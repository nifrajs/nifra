/**
 * Hook and write failures on a real Node socket. An `onRequest` hook that throws or rejects is
 * answered by the app's `onError`, else a logged 500, on both the Web and the native-twin lanes. A
 * header value Node refuses to write fails after the app returned; the adapter answers 500 and logs
 * the error through the app's own logger, as Bun's `listen()` does. The request a hook receives on
 * Node is a lazy stand-in for undici's `Request`, which `new Request(req)` cannot copy; `clone()` can.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { type Logger, server, status } from "@nifrajs/core"
import { rateLimit } from "@nifrajs/middleware"
import { serve } from "@nifrajs/node"

const recorder = (): { logger: Logger; errors: unknown[] } => {
  const errors: unknown[] = []
  const ignore = (): void => undefined
  return {
    logger: { debug: ignore, info: ignore, warn: ignore, error: (_m, f) => errors.push(f?.detail) },
    errors,
  }
}

test("a hook that throws with no onError answers 500 and reaches the app's logger", async () => {
  const { logger, errors } = recorder()
  const app = server({ logger })
    .onRequest(() => {
      throw new Error("hook failed")
    })
    .get("/x", () => ({ ok: true }))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/x`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { ok: false, error: "internal_error" })
    assert.deepEqual(errors, ["hook failed"])
  } finally {
    await running.stop()
  }
})

const failures = {
  sync: () => {
    throw new Error("store down")
  },
  async: async () => {
    await Promise.resolve()
    throw new Error("store down")
  },
} as const

for (const mode of ["sync", "async"] as const) {
  test(`a ${mode} hook failure is answered by onError on both request lanes`, async () => {
    const { logger, errors } = recorder()
    const seen: string[] = []
    const app = server({ logger })
      .onError((error) => {
        seen.push(error instanceof Error ? error.message : String(error))
        return status(503, { error: "unavailable" })
      })
      .use({ onRequest: () => undefined, onNodeRequest: failures[mode] })
      .onRequest(failures[mode])
      .get("/x", () => ({ ok: true }))
    const twin = server({ logger })
      .onError(() => status(503, { error: "unavailable" }))
      .use({ onRequest: () => undefined, onNodeRequest: failures[mode] })
      .get("/x", () => ({ ok: true }))
    for (const served of [app, twin]) {
      const running = await serve(served, { port: 0, hostname: "127.0.0.1" })
      try {
        const res = await fetch(`http://127.0.0.1:${running.port}/x`)
        assert.equal(res.status, 503)
        assert.deepEqual(await res.json(), { error: "unavailable" })
      } finally {
        await running.stop()
      }
    }
    assert.deepEqual(seen, ["store down"])
    assert.deepEqual(errors, [])
  })
}

test("a rate-limit store outage goes through onError instead of the adapter's 500", async () => {
  const { logger, errors } = recorder()
  const down = { hit: () => Promise.reject(new Error("store down")) }
  const app = server({ logger })
    .onError(() => status(503, { error: "rate_limit_unavailable" }))
    .use(rateLimit({ store: down, max: 3, windowMs: 1000 }))
    .get("/x", () => ({ ok: true }))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/x`)
    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { error: "rate_limit_unavailable" })
    assert.deepEqual(errors, [])
  } finally {
    await running.stop()
  }
})

test("a hook can replace the request with req.clone()", async () => {
  const app = server()
    .onRequest((req) => req.clone())
    .post("/x", async (c) => ({ body: await c.req.text() }))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/x`, { method: "POST", body: "hi" })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { body: "hi" })
  } finally {
    await running.stop()
  }
})

test("a header value Node refuses to write answers 500 and reaches the app's logger", async () => {
  const { logger, errors } = recorder()
  const injected = { headers: { "x-bad": "a\r\nInjected: 1" } }
  const app = server({ logger })
    .get("/sync", () => status(200, { ok: true }, injected))
    .get("/async", async () => {
      await Promise.resolve()
      return status(200, { ok: true }, injected)
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    for (const path of ["/sync", "/async"]) {
      const res = await fetch(`http://127.0.0.1:${running.port}${path}`)
      assert.equal(res.status, 500)
      assert.equal(res.headers.get("x-bad"), null)
      assert.deepEqual(await res.json(), { ok: false, error: "internal_error" })
    }
    assert.equal(errors.length, 2)
    for (const detail of errors) assert.match(String(detail), /Invalid character in header content/)
  } finally {
    await running.stop()
  }
})
