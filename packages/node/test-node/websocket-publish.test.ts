/** A publish on Node itself, with the same fixture the Bun suite runs. */

import assert from "node:assert/strict"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "@nifrajs/node"
import { publishFeedApp, publishRoundTrip } from "../test/ws-publish-fixture.ts"

test("a publish frames each text once and every subscriber reads it byte for byte, in order", async () => {
  const feed = publishFeedApp(server().use(websocket()))
  const running = await serve(feed.app, { port: 0, hostname: "127.0.0.1" })
  try {
    const { got, expected } = await publishRoundTrip(feed, running.port)
    assert.deepEqual(got, expected)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})
