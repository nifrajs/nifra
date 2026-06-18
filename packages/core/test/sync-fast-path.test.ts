import { describe, expect, test } from "bun:test"
import { defineContract, implement, server, silentLogger } from "../src/index.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"

/**
 * The synchronous fast path (RouteEntry.bare → `runBare`): a route with no body/query schema and no
 * derive/before/after/onError hooks runs without the `async` lifecycle machinery — a sync handler
 * produces its Response with no promise allocated. These tests pin that the fast path is behaviorally
 * **identical** to the full async lifecycle across every outcome: data, async data, thrown error,
 * thrown Response (control flow), decorations, and the request timeout (which must still bound a bare
 * *async* handler). Routes that have validation/hooks must still take the full lifecycle.
 */
function req(path: string, init?: RequestInit): Request {
  return new Request(`http://x${path}`, init)
}

describe("sync fast path — bare routes", () => {
  test("a sync handler returns data (200 + JSON), identical to the lifecycle", async () => {
    const app = server().get("/u/:id", (c) => ({ id: c.params.id }))
    const res = await app.fetch(req("/u/9"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "9" })
  })

  test("a sync handler returning a Response is passed through (with queued cookies)", async () => {
    const app = server().get("/r", (c) => {
      c.set.cookie("sid", "x")
      return new Response("raw", { status: 201 })
    })
    const res = await app.fetch(req("/r"))
    expect(res.status).toBe(201)
    expect(await res.text()).toBe("raw")
    expect(res.headers.getSetCookie().some((ck) => ck.startsWith("sid=x"))).toBe(true)
  })

  test("an async handler on a bare route still resolves correctly", async () => {
    const app = server().get("/a", async () => {
      await Promise.resolve()
      return { async: true }
    })
    expect(await (await app.fetch(req("/a"))).json()).toEqual({ async: true })
  })

  test("zero-length handlers that can observe arguments still receive the context", async () => {
    const app = server().get("/args", (...args: unknown[]) => {
      const ctx = args[0]
      return {
        argc: args.length,
        hasRequest: typeof ctx === "object" && ctx !== null && "req" in ctx,
      }
    })
    expect(await (await app.fetch(req("/args"))).json()).toEqual({
      argc: 1,
      hasRequest: true,
    })
  })

  test("a thrown Error → flat 500 (no leak), not a rejected fetch promise", async () => {
    const app = server({ logger: silentLogger }).get("/boom", () => {
      throw new Error("kaboom")
    })
    const res = await app.fetch(req("/boom")) // must resolve, never reject
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
  })

  test("a thrown Error from an ASYNC bare handler → flat 500 (rejection caught)", async () => {
    const app = server({ logger: silentLogger }).get("/boom", async () => {
      await Promise.resolve()
      throw new Error("late")
    })
    const res = await app.fetch(req("/boom"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
  })

  test("a thrown Response is deliberate control flow (returned as-is)", async () => {
    const app = server().get("/guard", () => {
      throw new Response(null, { status: 302, headers: { location: "/login" } })
    })
    const res = await app.fetch(req("/guard"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/login")
  })

  test("static decorations are applied on the fast path", async () => {
    const app = server()
      .decorate("db", { name: "pg" })
      .get("/d", (c) => ({ db: c.db.name }))
    expect(await (await app.fetch(req("/d"))).json()).toEqual({ db: "pg" })
  })

  test("undefined result → 204 on the fast path", async () => {
    const app = server().get("/empty", (c) => {
      c.set.status = 204
      return undefined
    })
    const res = await app.fetch(req("/empty"))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
  })

  test("a declared `response` contract does NOT push the route off the sync fast path", () => {
    // The response schema is a type + introspection contract only — the per-request lifecycle never
    // reads it and the `bare` gate ignores it. Observable proof: a bare sync handler on an implemented
    // route that declares a response still returns its Response *synchronously* (not a Promise) — i.e.
    // it runs `runBare`, exactly as the same route with no response would. Zero hot-path cost.
    const userResponse: StandardSchemaV1<unknown, { id: string }> = {
      "~standard": {
        version: 1,
        vendor: "nifra-test",
        validate: (v): StandardResult<{ id: string }> => ({ value: v as { id: string } }),
        types: undefined as unknown as StandardTypes<unknown, { id: string }>,
      },
    }
    const app = implement(
      defineContract({ getUser: { method: "GET", path: "/u/:id", response: userResponse } }),
      { getUser: (c) => ({ id: c.params.id }) },
    )
    const out = app.fetch(req("/u/9"))
    expect(out).toBeInstanceOf(Response) // synchronous ⇒ fast path taken, response schema never read
  })

  test("the request timeout still bounds a bare ASYNC handler (503)", async () => {
    // The fast path returns sync results directly (no timeout race), but a bare *async* handler returns
    // a promise — which must still be raced against the timeout.
    const app = server({ requestTimeoutMs: 30 }).get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 300))
      return { done: true }
    })
    const res = await app.fetch(req("/slow"))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: "request_timeout" })
  })
})

describe("sync fast path — routes that must NOT take it", () => {
  const nameBody = ((): StandardSchemaV1<unknown, { name: string }> => ({
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate: (v): StandardResult<{ name: string }> =>
        typeof v === "object" && v !== null && "name" in v && typeof v.name === "string"
          ? { value: { name: v.name } }
          : { issues: [{ message: "bad" }] },
      types: undefined as unknown as StandardTypes<unknown, { name: string }>,
    },
  }))()
  const searchQuery = ((): StandardSchemaV1<unknown, { q: string; limit: string }> => ({
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate: (v): StandardResult<{ q: string; limit: string }> =>
        typeof v === "object" &&
        v !== null &&
        "q" in v &&
        typeof v.q === "string" &&
        "limit" in v &&
        typeof v.limit === "string"
          ? { value: { q: v.q, limit: v.limit } }
          : { issues: [{ message: "bad query" }] },
      types: undefined as unknown as StandardTypes<unknown, { q: string; limit: string }>,
    },
  }))()

  test("a body-schema route still validates (full lifecycle)", async () => {
    const app = server().post("/u", { body: nameBody }, (c) => ({ created: c.body.name }))
    const ok = await app.fetch(
      req("/u", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(await ok.json()).toEqual({ created: "Ada" })
    const bad = await app.fetch(
      req("/u", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 1 }),
      }),
    )
    expect(bad.status).toBe(400)
  })

  test("a query-schema-only route validates without the full async lifecycle", async () => {
    const app = server().get("/search", { query: searchQuery }, (c) => ({
      q: c.query.q,
      limit: c.query.limit,
    }))

    const ok = app.fetch(req("/search?q=ada&limit=10"))
    expect(ok).toBeInstanceOf(Response)
    expect(await (ok as Response).json()).toEqual({ q: "ada", limit: "10" })

    const bad = app.fetch(req("/search?q=ada"))
    expect(bad).toBeInstanceOf(Response)
    expect((bad as Response).status).toBe(400)
  })

  test("query-schema-only route uses the parsed search without leaking fragments", async () => {
    const app = server().get("/search", { query: searchQuery }, (c) => ({
      q: c.query.q,
      limit: c.query.limit,
    }))

    const ok = app.fetch(req("/search?q=ada&limit=10#frag?limit=bad"))
    expect(ok).toBeInstanceOf(Response)
    expect(await (ok as Response).json()).toEqual({ q: "ada", limit: "10" })

    const bad = app.fetch(req("/search#frag?q=ada&limit=10"))
    expect(bad).toBeInstanceOf(Response)
    expect((bad as Response).status).toBe(400)
  })

  test("query-schema-only route preserves encoded URLSearchParams semantics", async () => {
    const app = server().get("/search", { query: searchQuery }, (c) => ({
      q: c.query.q,
      limit: c.query.limit,
    }))

    const ok = app.fetch(req("/search?q=ada+lovelace&limit=10"))
    expect(ok).toBeInstanceOf(Response)
    expect(await (ok as Response).json()).toEqual({ q: "ada lovelace", limit: "10" })
  })

  test("an async query validator still resolves correctly on the query-only path", async () => {
    const asyncQuery: StandardSchemaV1<unknown, { q: string }> = {
      "~standard": {
        version: 1,
        vendor: "nifra-test",
        validate: async (v): Promise<StandardResult<{ q: string }>> =>
          typeof v === "object" && v !== null && "q" in v && typeof v.q === "string"
            ? { value: { q: v.q } }
            : { issues: [{ message: "bad query" }] },
        types: undefined as unknown as StandardTypes<unknown, { q: string }>,
      },
    }
    const app = server().get("/search", { query: asyncQuery }, (c) => ({ q: c.query.q }))

    const ok = app.fetch(req("/search?q=ada"))
    expect(ok).toBeInstanceOf(Promise)
    expect(await (await ok).json()).toEqual({ q: "ada" })
  })

  test("a beforeHandle short-circuit still runs (full lifecycle)", async () => {
    const app = server()
      .beforeHandle(() => new Response("blocked", { status: 403 }))
      .get("/x", () => ({ ok: true }))
    const res = await app.fetch(req("/x"))
    expect(res.status).toBe(403)
    expect(await res.text()).toBe("blocked")
  })

  test("a derive runs and extends context (full lifecycle)", async () => {
    const app = server()
      .derive(() => ({ who: "ada" }))
      .get("/me", (c) => ({ who: c.who }))
    expect(await (await app.fetch(req("/me"))).json()).toEqual({ who: "ada" })
  })
})
