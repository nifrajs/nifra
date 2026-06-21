import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Result, Treaty } from "@nifrajs/client"
import { client, testClient } from "@nifrajs/client"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"

/** Minimal hand-rolled Standard Schema (the framework integrates via the spec). */
function schema<O>(
  validate: (value: unknown) => StandardResult<O> | Promise<StandardResult<O>>,
): StandardSchemaV1<unknown, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, O>,
    },
  }
}

const nameBody = schema<{ name: string }>((v) =>
  typeof v === "object" && v !== null && "name" in v && typeof v.name === "string"
    ? { value: { name: v.name } }
    : { issues: [{ message: "name must be a string", path: ["name"] }] },
)
const pageQuery = schema<{ page: string }>((v) =>
  typeof v === "object" && v !== null && "page" in v && typeof v.page === "string"
    ? { value: { page: v.page } }
    : { issues: [{ message: "page is required", path: ["page"] }] },
)

const app = server()
  .get("/", () => ({ root: true }))
  .get("/health", () => ({ ok: true }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .get("/users/:id/posts/:postId", (c) => ({ id: c.params.id, postId: c.params.postId }))
  .post("/users", { body: nameBody }, (c) => ({ created: c.body.name }))
  .get("/search", { query: pageQuery }, (c) => ({ page: c.query.page }))
  .get("/files/*path", (c) => ({ path: c.params.path }))
  .post("/ping", () => ({ pong: true }))
  .get("/secure", (c) => ({ auth: c.req.headers.get("authorization") }))
  .get("/text", () => new Response("hello text"))
  .get("/boom", () => new Response("kaboom", { status: 500 }))
  .get("/empty204", (c) => {
    c.set.status = 204
    return undefined
  })
  .get("/empty200", () => new Response(null, { status: 200 }))

type App = typeof app

// Untyped escape for testing paths/methods the typed client deliberately forbids.
type RawCall = (arg?: unknown) => Promise<Result<unknown>>
type RawClient = {
  nope: { get: RawCall }
  health: { get: RawCall; post: RawCall }
  users: { post: RawCall }
}

let instance: ReturnType<typeof app.listen>
let api: Treaty<App>
const url = (): string => `http://localhost:${instance.port}`

beforeAll(() => {
  instance = app.listen(0)
  api = client<App>(url())
})
afterAll(() => {
  instance.stop()
})

describe("client — success paths", () => {
  test("GET static returns the full typed Result", async () => {
    expect(await api.health.get()).toEqual({
      ok: true,
      status: 200,
      data: { ok: true },
      error: null,
    })
  })

  test("root path via index", async () => {
    expect((await api.index.get()).data).toEqual({ root: true })
  })

  test("path param is substituted", async () => {
    expect((await api.users({ id: "42" }).get()).data).toEqual({ id: "42" })
  })

  test("nested params", async () => {
    expect((await api.users({ id: "1" }).posts({ postId: "2" }).get()).data).toEqual({
      id: "1",
      postId: "2",
    })
  })

  test('a no-arg / empty-object param call never throws and adds no "undefined" segment [AUDIT]', async () => {
    // The Treaty type requires the param object; this exercises the RUNTIME guard for off-type misuse.
    // The client never throws, and must not synthesize a "/users/undefined" path. off-type on purpose.
    type Callable = (arg?: Record<string, unknown>) => { get: () => Promise<Result<unknown>> }
    const usersFn = api.users as unknown as Callable
    expect((await usersFn().get()).ok).toBe(false) // pre-fix: threw TypeError (Object.values(undefined))
    expect((await usersFn({}).get()).ok).toBe(false) // pre-fix: hit "/users/undefined" → matched :id → 200
  })

  test("POST sends a JSON body", async () => {
    expect((await api.users.post({ name: "Ada" })).data).toEqual({ created: "Ada" })
  })

  test("query is serialized", async () => {
    expect((await api.search.get({ query: { page: "3" } })).data).toEqual({ page: "3" })
  })

  test("wildcard with slashes round-trips", async () => {
    expect((await api.files({ path: "a/b/c.txt" }).get()).data).toEqual({ path: "a/b/c.txt" })
  })

  test("bodyless POST", async () => {
    expect((await api.ping.post()).data).toEqual({ pong: true })
  })

  test("non-JSON response is returned as text", async () => {
    // /text returns a raw Response, so its typed output is `never`; assert the runtime value.
    expect((await api.text.get()).data as unknown).toBe("hello text")
  })

  test("204 and empty 200 yield undefined data", async () => {
    expect((await api.empty204.get()).status).toBe(204)
    expect((await api.empty204.get()).data).toBeUndefined()
    expect((await api.empty200.get()).data).toBeUndefined()
  })

  test("an un-awaited node proxy is not thenable", async () => {
    // The `then` guard keeps `await api.users` from hanging on a fake thenable.
    expect(await (api.users as unknown)).toBeDefined()
  })

  test("an AbortSignal is forwarded", async () => {
    const res = await api.health.get({ signal: new AbortController().signal })
    expect(res.ok).toBe(true)
  })
})

describe("client — headers", () => {
  test("default and per-call headers (per-call wins)", async () => {
    const authed = client<App>(url(), { headers: { authorization: "Bearer base" } })
    expect((await authed.secure.get()).data).toEqual({ auth: "Bearer base" })
    expect((await authed.secure.get({ headers: { authorization: "Bearer call" } })).data).toEqual({
      auth: "Bearer call",
    })
  })
})

describe("client — error paths (never throws)", () => {
  const raw = (): RawClient => client<App>(url()) as unknown as RawClient

  test("404 → not_found", async () => {
    const res = await raw().nope.get()
    expect(res).toMatchObject({ ok: false, status: 404, data: null, error: { error: "not_found" } })
  })

  test("405 → method_not_allowed", async () => {
    const res = await raw().health.post()
    expect(res).toMatchObject({ ok: false, status: 405, error: { error: "method_not_allowed" } })
  })

  test("400 validation carries issues", async () => {
    const res = await raw().users.post({ name: 123 })
    expect(res.ok).toBe(false)
    expect(res.error).toEqual({
      error: "validation",
      issues: [{ message: "name must be a string", path: ["name"] }],
    })
  })

  test("a non-standard error body falls back to request_failed", async () => {
    const res = await api.boom.get()
    expect(res).toMatchObject({ ok: false, status: 500, error: { error: "request_failed" } })
  })

  test("a network failure becomes a typed error, not a throw", async () => {
    const dead = client<App>("http://localhost:1") as unknown as RawClient
    const res = await dead.health.get()
    expect(res).toEqual({ ok: false, status: 0, data: null, error: { error: "network_error" } })
  })
})

describe("testClient", () => {
  test("is the in-process test client — full lifecycle, typed, never throws", async () => {
    const app = server()
      .get("/ping", () => ({ pong: true }))
      .get("/users/:id", (c) => ({ id: c.params.id }))
    const api = testClient<typeof app>(app)
    const ping = await api.ping.get()
    expect(ping.ok && ping.data).toEqual({ pong: true })
    const user = await api.users({ id: "42" }).get()
    expect(user.ok && user.data).toEqual({ id: "42" })
    const untyped = api as unknown as { nope: { get(): Promise<{ ok: boolean }> } }
    const missing = await untyped.nope.get()
    expect(missing.ok).toBe(false)
  })

  test("exposes a real .fetch(url, init) bridge for createWebApp's /api/* auto-mount", async () => {
    // `createWebApp({ api: inProcessClient(backend) })` mounts the backend over HTTP by dispatching
    // `api.fetch(req.url, req)`. That requires `.fetch` to be the in-process bridge (→ a `Response`),
    // NOT a route sub-proxy (a `/fetch` call). Assert the bridge dispatches GET + POST with the body.
    const backend = server()
      .get("/api/x", () => ({ x: 1 }))
      .post("/api/echo", async (c) => ({ echoed: await c.req.json() }))
    const api = testClient<typeof backend>(backend) as unknown as {
      fetch: (url: string, init?: RequestInit) => Promise<Response>
    }
    expect(typeof api.fetch).toBe("function")
    const got = await api.fetch("http://nifra.internal/api/x", { method: "GET" })
    expect(got instanceof Response).toBe(true)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ x: 1 })
    const echoed = await api.fetch("http://nifra.internal/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hi: 1 }),
    })
    expect(await echoed.json()).toEqual({ echoed: { hi: 1 } })
    // The typed route surface is unchanged — `.fetch` shadows only the mount seam, not real routes.
    const typed = await testClient<typeof backend>(backend).api.x.get()
    expect(typed.ok && typed.data).toEqual({ x: 1 })
  })
})
