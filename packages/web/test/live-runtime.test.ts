/** The live round trip on Bun's own server; the Node and Deno suites run the same fixture. */
import { afterEach, expect, test } from "bun:test"
import { createWebApp } from "../src/index.ts"
import { live } from "../src/live.ts"
import { liveApp, liveRoundTrip } from "./live-runtime-fixture.ts"

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

test("a load, a watch, a change and the heartbeat over Bun's server", async () => {
  const { app, runtime } = liveApp({ createWebApp, live })
  await runtime.ready
  const running = app.listen(0, { hostname: "127.0.0.1" })
  stops.push(() => running.stop(true))
  const { heard, expected } = await liveRoundTrip(
    runtime,
    `http://127.0.0.1:${running.port}`,
    // Bun's client takes upgrade headers; the DOM constructor type does not know the option.
    (url, origin) => Reflect.construct(WebSocket, [url, { headers: { origin } }]),
  )
  expect(heard).toEqual(expected)
  // The same page still renders as a document.
  expect((await fetch(`http://127.0.0.1:${running.port}/posts/42`)).status).toBe(200)
})
