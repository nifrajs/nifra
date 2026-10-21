/** The live round trip on Node itself, with the same fixture the Bun suite runs. */

import assert from "node:assert/strict"
import { test } from "node:test"
import { serve } from "@nifrajs/node"
import { createWebApp } from "@nifrajs/web"
import { live } from "@nifrajs/web/live"
import { liveApp, liveRoundTrip } from "../test/live-runtime-fixture.ts"

test("a load, a watch, a change and the heartbeat over Node's server", async () => {
  const { app, runtime } = liveApp({ createWebApp, live })
  await runtime.ready
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const { heard, expected } = await liveRoundTrip(
      runtime,
      `http://127.0.0.1:${running.port}`,
      // undici's client takes handshake headers in its init object.
      (url, origin) => Reflect.construct(WebSocket, [url, { headers: { origin } }]),
    )
    assert.deepEqual(heard, expected)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})
