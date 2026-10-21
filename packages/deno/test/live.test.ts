/** The live round trip on Deno's own server, with the same fixture the Bun and Node suites run. */
import { createWebApp } from "@nifrajs/web"
import { live } from "@nifrajs/web/live"
import { liveApp, liveRoundTrip } from "../../web/test/live-runtime-fixture.ts"
import { serve } from "../src/index.ts"

Deno.test("live: a load, a watch, a change and the heartbeat over Deno's server", async () => {
  const { app, runtime } = liveApp({ createWebApp, live })
  await runtime.ready
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  try {
    const { heard, expected } = await liveRoundTrip(
      runtime,
      `http://127.0.0.1:${running.port}`,
      // Deno's client takes handshake headers in its options object.
      (url, origin) => new WebSocket(url, { headers: { origin } }),
    )
    if (JSON.stringify(heard) !== JSON.stringify(expected)) {
      throw new Error(`heard ${JSON.stringify(heard)}, expected ${JSON.stringify(expected)}`)
    }
  } finally {
    await running.stop({ drainMs: 50 })
  }
})
