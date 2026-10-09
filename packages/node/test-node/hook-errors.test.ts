/**
 * An `onRequest` hook that throws escapes `app.fetch`. On Node the adapter answers 500 and logs
 * the error through the app's own logger, as Bun's `listen()` does. The request a hook receives on
 * Node is a lazy stand-in for undici's `Request`, which `new Request(req)` cannot copy; `clone()` can.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { type Logger, server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const recorder = (): { logger: Logger; errors: unknown[] } => {
  const errors: unknown[] = []
  const ignore = (): void => undefined
  return {
    logger: { debug: ignore, info: ignore, warn: ignore, error: (_m, f) => errors.push(f?.detail) },
    errors,
  }
}

test("a hook that throws past fetch answers 500 and reaches the app's logger", async () => {
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
