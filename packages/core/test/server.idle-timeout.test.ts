import { expect, test } from "bun:test"
import { server } from "../src/index.ts"

/**
 * `listen({ idleTimeoutSec })`.
 *
 * Bun closes a connection that has moved no bytes for 10 seconds, and a request whose handler is
 * still working moves none - so before this option existed, every endpoint slower than 10s had its
 * socket cut mid-flight, no matter what `requestTimeoutMs` said. Apps that render, export, or call a
 * slow upstream have to raise it.
 *
 * The assertions use a 1-second ceiling against a 5-second handler rather than the real-world shape
 * (a >10s handler under a raised timeout), because that proves the same wiring - the number reaches
 * Bun and governs the socket - in half the wall-clock.
 */

test("idleTimeoutSec governs how long Bun holds a connection open for a slow handler", async () => {
  const app = server().get("/slow", async () => {
    await Bun.sleep(5000)
    return { ok: true }
  })
  const running = app.listen(0, { hostname: "127.0.0.1", idleTimeoutSec: 1 })
  try {
    // 1s ceiling, 5s handler (Bun's timeout wheel fires it around 4s): Bun closes the socket before the handler can answer.
    await expect(fetch(`http://127.0.0.1:${running.port}/slow`)).rejects.toThrow()
  } finally {
    await app.stop({ drainMs: 0 })
  }
}, 20_000)

test("a handler under the ceiling still answers normally", async () => {
  const app = server().get("/slow", async () => {
    await Bun.sleep(5000)
    return { ok: true }
  })
  // Control for the test above: same handler, a ceiling above it, so the rejection there is
  // attributable to the option and not to the handler simply being slow.
  const running = app.listen(0, { hostname: "127.0.0.1", idleTimeoutSec: 30 })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/slow`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  } finally {
    await app.stop({ drainMs: 0 })
  }
}, 20_000)
