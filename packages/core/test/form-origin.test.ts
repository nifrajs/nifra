import { describe, expect, test } from "bun:test"
import { type ServerOptions, server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardResult, StandardSchemaV1 } from "../src/schema/standard.ts"

const nameBody: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-test",
    validate: (value): StandardResult<{ name: string }> =>
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof value.name === "string"
        ? { value: { name: value.name } }
        : { issues: [{ message: "name must be a string" }] },
  },
}

function post(contentType: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://app.test/f", {
    method: "POST",
    headers: { "content-type": contentType, "content-length": String(body.length), ...headers },
    body,
  })
}

const FORM = "application/x-www-form-urlencoded"
const crossSite = { origin: "https://evil.test" }

// Every lane that reads a body schema: body only, one derive + before, the same with an after, the
// generic lifecycle a second before hook falls back to, and the body-only runner an around hook or a
// validation-recovery hook takes.
function lanes(options: ServerOptions = {}) {
  let ran = 0
  const handler = (c: { body: { name: string } }) => {
    ran++
    return { name: c.body.name }
  }
  const apps = {
    body: server(options).use(nodeDirect()).post("/f", { body: nameBody }, handler),
    deriveBefore: server(options)
      .use(nodeDirect())
      .derive(() => ({ seen: true }))
      .beforeHandle(() => undefined)
      .post("/f", { body: nameBody }, handler),
    deriveBeforeAfter: server(options)
      .use(nodeDirect())
      .derive(() => ({ seen: true }))
      .beforeHandle(() => undefined)
      .afterHandle((result) => result)
      .post("/f", { body: nameBody }, handler),
    generic: server(options)
      .use(nodeDirect())
      .beforeHandle(() => undefined)
      .beforeHandle(() => undefined)
      .post("/f", { body: nameBody }, handler),
    around: server(options)
      .use(nodeDirect())
      .around((_c, next) => next())
      .post("/f", { body: nameBody }, handler),
    recovery: server(options)
      .use(nodeDirect())
      .post("/f", { body: nameBody, onValidationError: () => ({ name: "fallback" }) }, handler),
  }
  return { apps: Object.entries(apps), ran: () => ran }
}

async function statuses(options: ServerOptions, request: () => Request) {
  const { apps, ran } = lanes(options)
  const out: Record<string, [number, number]> = {}
  for (const [name, app] of apps) {
    const web = await app.fetch(request())
    const node = await app.resolveNode(request())
    out[name] = [web.status, node.kind === "response" ? node.response.status : node.status]
  }
  return { out, ran: ran() }
}

/** `status` from every lane, through both `fetch` and the node-direct resolver. */
const everyLane = (status: number): number[] => lanes().apps.flatMap(() => [status, status])

describe("a form body from another site", () => {
  test("is refused with 403 on every body lane, before the handler runs", async () => {
    const { out, ran } = await statuses({}, () => post(FORM, "name=Ada", crossSite))
    expect(out).toEqual({
      body: [403, 403],
      deriveBefore: [403, 403],
      deriveBeforeAfter: [403, 403],
      generic: [403, 403],
      around: [403, 403],
      recovery: [403, 403],
    })
    expect(ran).toBe(0)
    const { apps } = lanes()
    const res = await apps[0]![1].fetch(post(FORM, "name=Ada", crossSite))
    expect(await res.json()).toEqual({ ok: false, error: "forbidden_origin" })
  })

  test("is refused for multipart, text/plain and a mixed-case media type too", async () => {
    const { apps } = lanes()
    const app = apps[0]![1]
    const boundary = "b0undary"
    const multipart = `--${boundary}\r\ncontent-disposition: form-data; name="name"\r\n\r\nAda\r\n--${boundary}--\r\n`
    expect(
      (await app.fetch(post(`multipart/form-data; boundary=${boundary}`, multipart, crossSite)))
        .status,
    ).toBe(403)
    expect((await app.fetch(post("text/plain", '{"name":"Ada"}', crossSite))).status).toBe(403)
    expect(
      (await app.fetch(post("Application/X-WWW-Form-Urlencoded", "name=Ada", crossSite))).status,
    ).toBe(403)
    // The same text/plain body from the app's own pages is still the media type no route reads.
    expect((await app.fetch(post("text/plain", '{"name":"Ada"}'))).status).toBe(415)
  })

  test("passes from the app's own origin, behind a TLS-terminating proxy, and without an Origin", async () => {
    for (const headers of [{ origin: "http://app.test" }, { origin: "https://app.test" }, {}]) {
      const { out, ran } = await statuses({}, () => post(FORM, "name=Ada", headers))
      expect(Object.values(out).flat()).toEqual(everyLane(200))
      expect(ran).toBe(everyLane(200).length)
    }
  })

  test("Origin: null passes only when Sec-Fetch-Site says the post is same-origin", async () => {
    const { apps } = lanes()
    const app = apps[0]![1]
    // What a same-origin form POST sends under `Referrer-Policy: no-referrer`.
    const own = post(FORM, "name=Ada", { origin: "null", "sec-fetch-site": "same-origin" })
    expect((await app.fetch(own)).status).toBe(200)
    expect((await app.fetch(post(FORM, "name=Ada", { origin: "null" }))).status).toBe(403)
    const sandboxed = post(FORM, "name=Ada", { origin: "null", "sec-fetch-site": "cross-site" })
    expect((await app.fetch(sandboxed)).status).toBe(403)
  })

  test("passes from an origin listed in formOrigins, exactly", async () => {
    const listed = await statuses({ formOrigins: ["https://idp.test"] }, () =>
      post(FORM, "name=Ada", { origin: "https://idp.test" }),
    )
    expect(Object.values(listed.out).flat()).toEqual(everyLane(200))
    const prefix = await statuses({ formOrigins: ["https://idp.test"] }, () =>
      post(FORM, "name=Ada", { origin: "https://idp.test.evil.test" }),
    )
    expect(Object.values(prefix.out).flat()).toEqual(everyLane(403))
  })

  test("passes when a formOrigins function accepts the origin", async () => {
    const seen: string[] = []
    const formOrigins = (origin: string) => {
      seen.push(origin)
      return origin.endsWith(".idp.test")
    }
    const { apps } = lanes({ formOrigins })
    const app = apps[0]![1]
    expect((await app.fetch(post(FORM, "name=Ada", { origin: "https://a.idp.test" }))).status).toBe(
      200,
    )
    expect((await app.fetch(post(FORM, "name=Ada", crossSite))).status).toBe(403)
    expect(seen).toEqual(["https://a.idp.test", "https://evil.test"])
  })

  test("a cross-origin JSON body is left to CORS", async () => {
    const { out } = await statuses({}, () => post("application/json", '{"name":"Ada"}', crossSite))
    expect(Object.values(out).flat()).toEqual(everyLane(200))
  })
})

// An unsafe route without `schema.body` never reads a body, so the body lane's check never runs
// for it. Each shape below takes a different lane.
function bodylessLanes(options: ServerOptions = {}) {
  let ran = 0
  const hit = () => {
    ran++
    return { ok: true }
  }
  const apps = {
    bare: server(options)
      .use(nodeDirect())
      .post("/f", () => hit()),
    context: server(options)
      .use(nodeDirect())
      .post("/f", (c) => (c.req.method === "POST" ? hit() : hit())),
    deriveBefore: server(options)
      .use(nodeDirect())
      .derive(() => ({ seen: true }))
      .beforeHandle(() => undefined)
      .post("/f", () => hit()),
    generic: server(options)
      .use(nodeDirect())
      .beforeHandle(() => undefined)
      .beforeHandle(() => undefined)
      .post("/f", () => hit()),
    around: server(options)
      .use(nodeDirect())
      .around((_c, next) => next())
      .post("/f", () => hit()),
    put: server(options)
      .use(nodeDirect())
      .put("/f", () => hit()),
    patch: server(options)
      .use(nodeDirect())
      .patch("/f", () => hit()),
    delete: server(options)
      .use(nodeDirect())
      .delete("/f", () => hit()),
  }
  return { apps: Object.entries(apps), ran: () => ran }
}

function send(method: string, contentType: string | null, headers: Record<string, string> = {}) {
  const all = new Headers(headers)
  if (contentType !== null) all.set("content-type", contentType)
  return new Request("http://app.test/f", { method, headers: all, body: "a=1" })
}

const METHOD_OF: Record<string, string> = { put: "PUT", patch: "PATCH", delete: "DELETE" }
const methodOf = (name: string): string => METHOD_OF[name] ?? "POST"

describe("a form post from another site to a route without a body schema", () => {
  test("is refused with 403 on every lane and method, before the handler runs", async () => {
    const { apps, ran } = bodylessLanes()
    for (const type of [FORM, "multipart/form-data; boundary=b", "text/plain", null]) {
      for (const [name, app] of apps) {
        const web = await app.fetch(send(methodOf(name), type, crossSite))
        expect([name, web.status]).toEqual([name, 403])
        expect(await web.json()).toEqual({ ok: false, error: "forbidden_origin" })
        const node = await app.resolveNode(send(methodOf(name), type, crossSite))
        expect([name, node.kind === "response" ? node.response.status : node.status]).toEqual([
          name,
          403,
        ])
      }
    }
    expect(ran()).toBe(0)
  })

  test("passes from its own origin, without an Origin, as JSON, and with a preflight-forcing Authorization", async () => {
    const { apps, ran } = bodylessLanes()
    let expected = 0
    for (const [name, app] of apps) {
      for (const request of [
        () => send(methodOf(name), FORM, { origin: "http://app.test" }),
        () => send(methodOf(name), FORM),
        () => send(methodOf(name), "application/json", crossSite),
        () => send(methodOf(name), null, { origin: "http://app.test" }),
        () => send(methodOf(name), null),
        () => send(methodOf(name), null, { ...crossSite, authorization: "Bearer t" }),
        () => send(methodOf(name), null, { ...crossSite, "sec-fetch-site": "same-origin" }),
      ]) {
        expect([name, (await app.fetch(request())).status]).toEqual([name, 200])
        expected++
      }
    }
    expect(ran()).toBe(expected)
  })

  test("a browser's own-origin post passes on Sec-Fetch-Site, and a proxy-terminated one on its Origin", async () => {
    const { apps, ran } = bodylessLanes()
    const bare = apps[0]![1]
    const sameOrigin = { origin: "http://app.test", "sec-fetch-site": "same-origin" }
    expect((await bare.fetch(send("POST", FORM, sameOrigin))).status).toBe(200)
    // https page, plain-http request URL: what a TLS-terminating proxy looks like to the server.
    expect((await bare.fetch(send("POST", FORM, { origin: "https://app.test" }))).status).toBe(200)
    const attacker = { ...crossSite, "sec-fetch-site": "cross-site" }
    expect((await bare.fetch(send("POST", FORM, attacker))).status).toBe(403)
    expect(ran()).toBe(2)
  })

  test("passes from a formOrigins origin and leaves a safe method alone", async () => {
    const { apps } = bodylessLanes({ formOrigins: ["https://idp.test"] })
    const bare = apps[0]![1]
    expect((await bare.fetch(send("POST", FORM, { origin: "https://idp.test" }))).status).toBe(200)
    expect((await bare.fetch(send("POST", null, { origin: "https://idp.test" }))).status).toBe(200)
    expect((await bare.fetch(send("POST", null, crossSite))).status).toBe(403)
    expect((await bare.fetch(send("POST", FORM, crossSite))).status).toBe(403)
    const reader = server().get("/f", () => ({ ok: true }))
    const read = new Request("http://app.test/f", {
      headers: { "content-type": FORM, ...crossSite },
    })
    expect((await reader.fetch(read)).status).toBe(200)
  })

  test("a route with a body schema still answers a request with no content type with 415", async () => {
    const { apps } = lanes()
    const res = await apps[0]![1].fetch(post("", "a=1", crossSite))
    expect(res.status).toBe(415)
  })

  test("is refused by Bun's native route table too", async () => {
    let ran = 0
    const app = server().post("/f", () => {
      ran++
      return { ok: true }
    })
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const url = `http://127.0.0.1:${instance.port}/f`
      const post = (headers: Record<string, string>) =>
        fetch(url, { method: "POST", headers: { "content-type": FORM, ...headers }, body: "a=1" })
      expect((await post(crossSite)).status).toBe(403)
      expect((await post({})).status).toBe(200)
      const bare = (headers: Record<string, string>) => fetch(url, { method: "POST", headers })
      expect((await bare(crossSite)).status).toBe(403)
      expect((await bare({ ...crossSite, authorization: "Bearer t" })).status).toBe(200)
      expect((await bare({ ...crossSite, authorization: "Basic dTpw" })).status).toBe(403)
      expect(ran).toBe(2)
    } finally {
      instance.stop(true)
    }
  })
  test("a handler that owns its origin policy is left to it", async () => {
    const own = Object.assign(() => ({ ok: true }), {
      [Symbol.for("nifra.route.ownsFormOrigin")]: true,
    })
    const app = server().post("/f", own)
    expect((await app.fetch(send("POST", FORM, crossSite))).status).toBe(200)
  })
})
