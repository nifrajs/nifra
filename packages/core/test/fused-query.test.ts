import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server, silentLogger } from "../src/index.ts"
import type { StandardResult, StandardSchemaV1 } from "../src/schema/standard.ts"

/**
 * The fused query lane: a route whose only lifecycle step is a query schema collapses parse +
 * validate + handler + respond into one closure on the Web dispatch path. These tests pin that the
 * fused lane is behaviorally IDENTICAL to the generic `query` lane for every outcome - valid input,
 * invalid input (the 422 contract), repeated keys, async validators, async handlers, thrown
 * Responses, thrown errors, decorations, merge() rebinding - and that every recovery/wrapper
 * feature (onValidationError, idempotency, hooks) still takes the generic lane with its full
 * semantics.
 */
function req(path: string, init?: RequestInit): Request {
  return new Request(`http://x${path}`, init)
}

const searchSchema: StandardSchemaV1<unknown, { q: string; limit: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-test",
    validate(value): StandardResult<{ q: string; limit: string }> {
      const v = value as Record<string, unknown>
      return typeof v.q === "string" && typeof v.limit === "string"
        ? { value: { q: v.q, limit: v.limit } }
        : { issues: [{ message: "q and limit are required" }] }
    },
  },
}

describe("fused query lane", () => {
  test("valid query -> validated object on c.query, 200 JSON", async () => {
    const app = server().get("/s", { query: searchSchema }, (c) => ({
      q: c.query.q,
      limit: c.query.limit,
    }))
    const res = await app.fetch(req("/s?q=a&limit=10"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ q: "a", limit: "10" })
  })

  test("invalid query -> the standard 422 validation contract", async () => {
    const app = server().get("/s", { query: searchSchema }, (c) => ({ q: c.query.q }))
    const res = await app.fetch(req("/s?q=a"))
    expect(res.status).toBe(422)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe("validation")
  })

  test("repeated keys promote to string[] before validation (t.array schema)", async () => {
    const app = server().get("/tags", { query: t.object({ tag: t.array(t.string()) }) }, (c) => ({
      tags: c.query.tag,
    }))
    expect(await (await app.fetch(req("/tags?tag=a&tag=b"))).json()).toEqual({ tags: ["a", "b"] })
  })

  test("an async validator still validates (falls to the then-chain)", async () => {
    const asyncSchema: StandardSchemaV1<unknown, { q: string }> = {
      "~standard": {
        version: 1,
        vendor: "nifra-test",
        async validate(value): Promise<StandardResult<{ q: string }>> {
          await Promise.resolve()
          const v = value as Record<string, unknown>
          return typeof v.q === "string" ? { value: { q: v.q } } : { issues: [{ message: "q" }] }
        },
      },
    }
    const app = server().get("/a", { query: asyncSchema }, (c) => ({ q: c.query.q }))
    expect(await (await app.fetch(req("/a?q=z"))).json()).toEqual({ q: "z" })
    expect((await app.fetch(req("/a"))).status).toBe(422)
  })

  test("an async handler resolves; a thrown Response passes through; an Error is a flat 500", async () => {
    const app = server({ logger: silentLogger })
      .get("/async", { query: searchSchema }, async (c) => {
        await Promise.resolve()
        return { q: c.query.q }
      })
      .get("/redir", { query: searchSchema }, () => {
        throw new Response(null, { status: 302, headers: { location: "/x" } })
      })
      .get("/boom", { query: searchSchema }, () => {
        throw new Error("secret detail")
      })
    expect(await (await app.fetch(req("/async?q=a&limit=1"))).json()).toEqual({ q: "a" })
    const redirected = await app.fetch(req("/redir?q=a&limit=1"))
    expect(redirected.status).toBe(302)
    expect(redirected.headers.get("location")).toBe("/x")
    const boom = await app.fetch(req("/boom?q=a&limit=1"))
    expect(boom.status).toBe(500)
    expect(await boom.text()).not.toContain("secret detail")
  })

  test("c.set headers/cookies still apply from a fused query handler", async () => {
    const app = server().get("/h", { query: searchSchema }, (c) => {
      c.set.headers["x-fused"] = "1"
      c.set.cookie("sid", "v")
      return { ok: true }
    })
    const res = await app.fetch(req("/h?q=a&limit=1"))
    expect(res.headers.get("x-fused")).toBe("1")
    expect(res.headers.getSetCookie().some((ck) => ck.startsWith("sid=v"))).toBe(true)
  })

  test("decorations reach the fused query handler", async () => {
    const app = server()
      .decorate("version", "9.9")
      .get("/d", { query: searchSchema }, (c) => ({
        v: (c as unknown as { version: string }).version,
        q: c.query.q,
      }))
    expect(await (await app.fetch(req("/d?q=a&limit=1"))).json()).toEqual({ v: "9.9", q: "a" })
  })

  test("merge() rebinds the fused closure WITH its validation intact", async () => {
    const feature = server().get("/s", { query: searchSchema }, (c) => ({ q: c.query.q }))
    const app = server().merge(feature)
    expect(await (await app.fetch(req("/s?q=a&limit=1"))).json()).toEqual({ q: "a" })
    // The rebound closure must still validate - a bare rebind would let this through.
    expect((await app.fetch(req("/s?q=only"))).status).toBe(422)
  })

  test("onValidationError recovery still runs (route falls back to the generic lane)", async () => {
    // The hook returns a REPLACEMENT input, re-validated by the same schema before the handler runs.
    const app = server().get(
      "/r",
      {
        query: searchSchema,
        onValidationError: () => ({ q: "fallback", limit: "0" }),
      },
      (c) => ({ q: c.query.q, limit: c.query.limit }),
    )
    const res = await app.fetch(req("/r?q=only"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ q: "fallback", limit: "0" })
  })

  test("a server-level onValidationError default also keeps the generic lane", async () => {
    const app = server({ onValidationError: () => ({ q: "default", limit: "1" }) }).get(
      "/r",
      { query: searchSchema },
      (c) => ({ q: c.query.q }),
    )
    expect(await (await app.fetch(req("/r?q=only"))).json()).toEqual({ q: "default" })
  })

  test("beforeHandle hooks still run for query routes (generic lane)", async () => {
    const order: string[] = []
    const app = server()
      .beforeHandle(() => {
        order.push("before")
      })
      .get("/hooked", { query: searchSchema }, (c) => {
        order.push("handler")
        return { q: c.query.q }
      })
    expect(await (await app.fetch(req("/hooked?q=a&limit=1"))).json()).toEqual({ q: "a" })
    expect(order).toEqual(["before", "handler"])
  })
})

// Registration picks a specialized lifecycle per route shape. These two shapes each select a
// distinct one, so without a route of that exact shape the specialization never runs at all.
describe("registration-specialized lifecycles", () => {
  test("a route with BOTH body and query schemas validates body first, then query", async () => {
    const app = server({ logger: silentLogger }).post(
      "/items",
      { body: t.object({ name: t.string() }), query: t.object({ limit: t.string() }) },
      (c) => ({ name: c.body.name, limit: c.query.limit }),
    )

    const ok = await app.fetch(
      new Request("http://x/items?limit=5", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "widget" }),
      }),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ name: "widget", limit: "5" })

    // A bad body short-circuits before the query is ever looked at.
    const badBody = await app.fetch(
      new Request("http://x/items?limit=5", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 42 }),
      }),
    )
    expect(badBody.status).toBe(422)

    // A valid body with a missing required query param still fails, at the later stage.
    const badQuery = await app.fetch(
      new Request("http://x/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "widget" }),
      }),
    )
    expect(badQuery.status).toBe(422)
  })

  test("an async afterHandle continues the remaining chain and still catches", async () => {
    const app = server({ logger: silentLogger })
      .afterHandle(async (result) => ({ first: result }))
      .afterHandle((result) => ({ second: result }))
      .get("/chain", () => ({ id: 1 }))

    expect(await (await app.fetch(new Request("http://x/chain"))).json()).toEqual({
      second: { first: { id: 1 } },
    })

    // A throw after the chain resumed still lands on the error path rather than escaping.
    const boom = server({ logger: silentLogger })
      .afterHandle(async (result) => ({ first: result }))
      .afterHandle(() => {
        throw new Error("after-handle failed")
      })
      .get("/boom", () => ({ id: 1 }))
    expect((await boom.fetch(new Request("http://x/boom"))).status).toBe(500)
  })
})
