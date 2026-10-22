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
