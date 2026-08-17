import { expect, test } from "bun:test"
import { server as coreServer } from "@nifrajs/core/server"
import { type StandardSchemaV1, server, toFetchHandler } from "../src/index.ts"

/** A hand-rolled Standard Schema for `{ name: string; age: number }` - no schema library in the test. */
const userBody: StandardSchemaV1<{ name: string; age: number }> = {
  "~standard": {
    version: 1,
    vendor: "edge-test",
    validate(value) {
      const v = value as { name?: unknown; age?: unknown }
      return typeof v?.name === "string" && typeof v?.age === "number"
        ? { value: { name: v.name, age: v.age } }
        : { issues: [{ message: "expected { name: string; age: number }" }] }
    },
  },
}

/** Both servers, wired to the SAME routes, so a rejection can be compared byte for byte. */
function edgeApp() {
  return server()
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/users", { body: userBody }, (c) => ({ created: c.body.name, age: c.body.age }))
}
function coreApp() {
  return coreServer()
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/users", { body: userBody }, (c) => ({ created: c.body.name, age: c.body.age }))
}

const jsonReq = (path: string, method: string, body: unknown, headers?: Record<string, string>) =>
  new Request(`https://x.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

/** Status + body + the headers that carry meaning for these envelopes. */
async function wire(res: Response) {
  return {
    status: res.status,
    body: await res.clone().text(),
    allow: res.headers.get("allow"),
  }
}

test("GET resolves typed path params, rendered as JSON", async () => {
  const res = await edgeApp().fetch(new Request("https://x.test/users/42"))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id: "42" })
})

test("POST validates the body and narrows c.body", async () => {
  const res = await edgeApp().fetch(jsonReq("/users", "POST", { name: "ada", age: 36 }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ created: "ada", age: 36 })
})

test("query() parses the search string on demand", async () => {
  const app = server().get("/s", (c) => c.query())
  const res = await app.fetch(new Request("https://x.test/s?q=hi&tag=a&tag=b"))
  expect(await res.json()).toEqual({ q: "hi", tag: ["a", "b"] })
})

test("header() reads request headers case-insensitively", async () => {
  const app = server().get("/h", (c) => ({ ua: c.header("User-Agent") }))
  const res = await app.fetch(new Request("https://x.test/h", { headers: { "user-agent": "z" } }))
  expect(await res.json()).toEqual({ ua: "z" })
})

test("all body-bearing verbs carry the schema lane", async () => {
  for (const method of ["PUT", "PATCH", "DELETE"] as const) {
    const app = server()[method.toLowerCase() as "put"]("/r", { body: userBody }, (c) => c.body)
    const ok = await app.fetch(jsonReq("/r", method, { name: "x", age: 1 }))
    expect(ok.status).toBe(200)
    const bad = await app.fetch(jsonReq("/r", method, { name: "x" }))
    expect(bad.status).toBe(422)
  }
})

test("HEAD and OPTIONS register as body-less routes", async () => {
  const app = server()
    .head("/x", () => "")
    .options("/x", () => ({ ok: true }))
  expect((await app.fetch(new Request("https://x.test/x", { method: "OPTIONS" }))).status).toBe(200)
})

test("a handler may throw a Response for an early exit", async () => {
  const app = server().get("/e", () => {
    throw new Response("gone", { status: 410 })
  })
  const res = await app.fetch(new Request("https://x.test/e"))
  expect(res.status).toBe(410)
  expect(await res.text()).toBe("gone")
})

test("a non-Response throw becomes a flat 500 (no leak)", async () => {
  const app = server().get("/boom", () => {
    throw new Error("secret internal detail")
  })
  const res = await app.fetch(new Request("https://x.test/boom"))
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain("secret internal detail")
})

test("custom maxBodyBytes rejects an over-cap body with 413", async () => {
  const app = server({ maxBodyBytes: 16 }).post("/u", { body: userBody }, (c) => c.body)
  const res = await app.fetch(jsonReq("/u", "POST", { name: "a".repeat(1000), age: 1 }))
  expect(res.status).toBe(413)
})

// --- Byte-parity with the full @nifrajs/core server: the whole point of reusing the shipped lane. ---

test("parity: 404 not-found envelope matches the full Server", async () => {
  const req = () => new Request("https://x.test/nope")
  expect(await wire(await edgeApp().fetch(req()))).toEqual(await wire(await coreApp().fetch(req())))
})

test("parity: 405 method-not-allowed + Allow header matches", async () => {
  const req = () => new Request("https://x.test/users/1", { method: "DELETE" })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(405)
  expect(e.allow).toContain("GET")
})

test("parity: 422 validation envelope (with issues) matches", async () => {
  const req = () => jsonReq("/users", "POST", { name: "ada" })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(422)
})

test("parity: 415 unsupported-media-type matches", async () => {
  const req = () =>
    new Request("https://x.test/users", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(415)
})

test("parity: 400 malformed-JSON matches", async () => {
  const req = () =>
    new Request("https://x.test/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    })
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
  expect(e.status).toBe(400)
})

test("parity: prototype-poisoning is rejected identically (default reject policy)", async () => {
  const req = () =>
    jsonReq("/users", "POST", JSON.parse('{"name":"a","age":1,"__proto__":{"x":1}}'))
  const e = await wire(await edgeApp().fetch(req()))
  expect(e).toEqual(await wire(await coreApp().fetch(req())))
})

test("parity: an urlencoded form body is framed the same way", async () => {
  const req = () =>
    new Request("https://x.test/users", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=ada&age=36",
    })
  // Same status on both (the form reaches the schema, which rejects age as a string -> 422).
  const e = await edgeApp().fetch(req())
  const c = await coreApp().fetch(req())
  expect(e.status).toBe(c.status)
})

test("toFetchHandler yields a Workers { fetch } module handler", async () => {
  const handler = toFetchHandler(edgeApp())
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as Parameters<
    typeof handler.fetch
  >[2]
  const res = await handler.fetch(new Request("https://x.test/users/7"), {}, ctx)
  expect(await res.json()).toEqual({ id: "7" })
})
