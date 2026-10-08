import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import {
  assertIncidentReplays,
  captureIncident,
  generateRegressionTest,
  IncidentReplayError,
  redactForEmission,
  replayIncident,
  shapeOf,
} from "../src/index.ts"

const ORIGIN = "http://nifra.internal"

// A tiny app: /echo returns 200 with the posted name; /boom throws (500).
const good = server()
  .post(
    "/echo/:id",
    {
      body: t.object({ name: t.string() }),
      response: t.object({ id: t.string(), name: t.string() }),
    },
    (c) => ({
      id: c.params.id,
      name: c.body.name,
    }),
  )
  .get("/ping", { response: t.object({ ok: t.boolean() }) }, () => ({ ok: true }))

describe("shapeOf", () => {
  test("fingerprints structure not values", () => {
    expect(shapeOf({ a: 1, b: "x", c: [true] })).toEqual({
      a: "number",
      b: "string",
      c: ["boolean"],
    })
    expect(shapeOf(null)).toBe("null")
    expect(shapeOf([])).toBe("[]")
  })
})

describe("redactForEmission", () => {
  test("redacts string leaves by default, keeps non-strings, honours the allow-list", () => {
    const out = redactForEmission(
      { name: "alice", age: 30, nested: { token: "sk_live_x" } },
      new Set(["name"]),
    )
    expect(out).toEqual({ name: "alice", age: 30, nested: { token: "<redacted>" } })
  })
})

describe("captureIncident", () => {
  test("captures a real Request/Response, allow-listing headers", async () => {
    const req = new Request(`${ORIGIN}/echo/42?trace=1`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ name: "alice" }),
    })
    const res = new Response(JSON.stringify({ id: "42", name: "alice" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
    const capsule = await captureIncident(req, res)
    expect(capsule.request.method).toBe("POST")
    expect(capsule.request.path).toBe("/echo/42")
    expect(capsule.request.query).toEqual({ trace: "1" })
    expect(capsule.request.headers).toEqual({ "content-type": "application/json" }) // authorization dropped
    expect(capsule.request.body).toEqual({ name: "alice" })
    expect(capsule.response.status).toBe(201)
    expect(capsule.response.bodyShape).toEqual({ id: "string", name: "string" })
    expect(capsule.id).toMatch(/^inc_/)
  })

  test("captures from plain fields", async () => {
    const capsule = await captureIncident(
      { method: "GET", path: "/ping" },
      { status: 200, body: { ok: true } },
    )
    expect(capsule.request.path).toBe("/ping")
    expect(capsule.response.bodyShape).toEqual({ ok: "boolean" })
  })
})

describe("replayIncident / assertIncidentReplays", () => {
  test("reproduces an unchanged response (golden lock)", async () => {
    // Two fresh requests (one to fetch, one to capture) rather than `.clone()` - a request body can
    // only be read once, and `.clone()`'s DOM/undici return type doesn't unify with the Bun `Request`
    // that `app.fetch` expects under the root tsconfig.
    const makeReq = (): Request =>
      new Request(`${ORIGIN}/echo/7`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "bob" }),
      })
    const res = await good.fetch(makeReq())
    const capsule = await captureIncident(makeReq(), res)

    const result = await replayIncident(good, capsule, { assertShape: true })
    expect(result.reproduced).toBe(true)
    expect(result.statusMatches).toBe(true)
    expect(result.shapeMatches).toBe(true)
    await assertIncidentReplays(good, capsule, { assertShape: true }) // does not throw
  })

  test("detects a diverged response and throws IncidentReplayError", async () => {
    // Capsule expects 200 on /echo, but replay against an app whose /echo 404s (route removed).
    const capsule = await captureIncident(
      {
        method: "POST",
        path: "/echo/7",
        headers: { "content-type": "application/json" },
        body: { name: "bob" },
      },
      { status: 200, body: { id: "7", name: "bob" } },
    )
    const changed = server().get("/ping", { response: t.object({ ok: t.boolean() }) }, () => ({
      ok: true,
    }))
    const result = await replayIncident(changed, capsule)
    expect(result.reproduced).toBe(false)
    expect(result.expectedStatus).toBe(200)
    expect(result.status).not.toBe(200)
    await expect(assertIncidentReplays(changed, capsule)).rejects.toBeInstanceOf(
      IncidentReplayError,
    )
  })

  test("replays a repeated query parameter and a text body exactly as captured", async () => {
    const exact = {
      fetch: async (request: Request) => {
        const q = new URL(request.url).searchParams.getAll("q")
        const text = await request.text()
        const ok = q.join(",") === "first,second" && text === "raw text"
        return new Response(null, { status: ok ? 200 : 400 })
      },
    }
    const original = () =>
      new Request(`${ORIGIN}/search?q=first&q=second`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "raw text",
      })
    const capsule = await captureIncident(original(), await exact.fetch(original()))
    expect(capsule.request.queryPairs).toEqual([
      ["q", "first"],
      ["q", "second"],
    ])
    expect(capsule.request.bodyEncoding).toBe("text")
    expect(await replayIncident(exact, capsule)).toMatchObject({ reproduced: true, status: 200 })
  })

  test("catches a response-shape regression even when status matches", async () => {
    const capsule = await captureIncident(
      { method: "GET", path: "/ping" },
      { status: 200, body: { ok: true, extra: "field" } }, // captured shape has `extra`
    )
    // Current app returns 200 but WITHOUT `extra` → shape diverges.
    const result = await replayIncident(good, capsule, { assertShape: true })
    expect(result.statusMatches).toBe(true)
    expect(result.shapeMatches).toBe(false)
    expect(result.reproduced).toBe(false)
  })
})

describe("generateRegressionTest", () => {
  test("emits a redact-by-default, sanitize-bannered test that asserts replay", async () => {
    const capsule = await captureIncident(
      {
        method: "POST",
        path: "/echo/7",
        headers: { "content-type": "application/json" },
        body: { name: "alice", note: "pii" },
      },
      { status: 200, body: { id: "7", name: "alice" } },
    )
    const code = generateRegressionTest(capsule, { importPath: "../src/app", assertShape: false })
    expect(code).toContain("SANITIZE BEFORE COMMITTING")
    expect(code).toContain("<redacted>") // string body values redacted
    expect(code).not.toContain('"alice"') // the real value is gone
    expect(code).toContain("assertIncidentReplays")
    expect(code).toContain('from "../src/app"')
    expect(code).toContain("reproduces status 200")
  })

  test("query values, header values and the note are redacted unless allow-listed", async () => {
    const capsule = await captureIncident(
      new Request("http://x/reset?token=SYNTHETIC_TOKEN_ONLY&page=2", {
        headers: { authorization: "Bearer SYNTHETIC_BEARER", "content-type": "text/plain" },
      }),
      { status: 400 },
      { headerAllowList: ["authorization", "content-type"], note: "user SYNTHETIC_NOTE" },
    )
    const code = generateRegressionTest(capsule, { allowQuery: ["page"] })
    expect(code).toContain("SANITIZE BEFORE COMMITTING")
    for (const secret of ["SYNTHETIC_TOKEN_ONLY", "SYNTHETIC_BEARER", "SYNTHETIC_NOTE"]) {
      expect(code).not.toContain(secret)
    }
    expect(code).toContain('"page": "2"')
    expect(code).toContain('"content-type": "text/plain"')
    expect(code).toContain("Review the request path")

    const kept = generateRegressionTest(capsule, {
      allowQuery: ["token", "page"],
      allowHeaders: ["Authorization", "content-type"],
      keepNote: true,
    })
    expect(kept).toContain("SYNTHETIC_TOKEN_ONLY")
    expect(kept).toContain("SYNTHETIC_BEARER")
    expect(kept).toContain("SYNTHETIC_NOTE")
    expect(kept).not.toContain("SANITIZE BEFORE COMMITTING")
  })

  test("repeated query values are redacted in their pairs too", async () => {
    const capsule = await captureIncident(
      new Request(`${ORIGIN}/ping?token=SECRET_ONE&token=SECRET_TWO`),
      { status: 200 },
    )
    const emitted = generateRegressionTest(capsule)
    expect(emitted).not.toContain("SECRET_ONE")
    expect(emitted).not.toContain("SECRET_TWO")
  })

  test("allow-list keeps a safe value verbatim and drops the banner when nothing was redacted", async () => {
    const capsule = await captureIncident(
      { method: "GET", path: "/ping" },
      { status: 200, body: { ok: true } },
    )
    const code = generateRegressionTest(capsule) // GET, no body → nothing to redact
    expect(code).not.toContain("SANITIZE BEFORE COMMITTING")
    expect(code).not.toContain("<redacted>")
  })
})
