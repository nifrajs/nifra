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
  .post("/echo/:id", { body: t.object({ name: t.string() }), response: t.object({ id: t.string(), name: t.string() }) }, (c) => ({
    id: c.params.id,
    name: c.body.name,
  }))
  .get("/ping", { response: t.object({ ok: t.boolean() }) }, () => ({ ok: true }))

describe("shapeOf", () => {
  test("fingerprints structure not values", () => {
    expect(shapeOf({ a: 1, b: "x", c: [true] })).toEqual({ a: "number", b: "string", c: ["boolean"] })
    expect(shapeOf(null)).toBe("null")
    expect(shapeOf([])).toBe("[]")
  })
})

describe("redactForEmission", () => {
  test("redacts string leaves by default, keeps non-strings, honours the allow-list", () => {
    const out = redactForEmission({ name: "alice", age: 30, nested: { token: "sk_live_x" } }, new Set(["name"]))
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
    const req = new Request(`${ORIGIN}/echo/7`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob" }),
    })
    const res = await good.fetch(req.clone())
    const capsule = await captureIncident(req, res)

    const result = await replayIncident(good, capsule, { assertShape: true })
    expect(result.reproduced).toBe(true)
    expect(result.statusMatches).toBe(true)
    expect(result.shapeMatches).toBe(true)
    await assertIncidentReplays(good, capsule, { assertShape: true }) // does not throw
  })

  test("detects a diverged response and throws IncidentReplayError", async () => {
    // Capsule expects 200 on /echo, but replay against an app whose /echo 404s (route removed).
    const capsule = await captureIncident(
      { method: "POST", path: "/echo/7", headers: { "content-type": "application/json" }, body: { name: "bob" } },
      { status: 200, body: { id: "7", name: "bob" } },
    )
    const changed = server().get("/ping", { response: t.object({ ok: t.boolean() }) }, () => ({ ok: true }))
    const result = await replayIncident(changed, capsule)
    expect(result.reproduced).toBe(false)
    expect(result.expectedStatus).toBe(200)
    expect(result.status).not.toBe(200)
    await expect(assertIncidentReplays(changed, capsule)).rejects.toBeInstanceOf(IncidentReplayError)
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
      { method: "POST", path: "/echo/7", headers: { "content-type": "application/json" }, body: { name: "alice", note: "pii" } },
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
