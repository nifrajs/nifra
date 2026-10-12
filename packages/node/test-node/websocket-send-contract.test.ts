/** The outbound WebSocket contract on Node itself, with the same fixture the Bun and Deno suites run. */

import assert from "node:assert/strict"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "@nifrajs/node"
import { firstContractFrame, sendContractApp } from "../../core/test/ws-send-contract.ts"

test("a frame the route's sendSchema refuses never leaves, and error() hears of it", async () => {
  const contract = sendContractApp(server().use(websocket()))
  const running = await serve(contract.app, { port: 0, hostname: "127.0.0.1" })
  try {
    assert.equal(await firstContractFrame(running.port), JSON.stringify({ ok: true }))
    assert.equal(contract.errors.length, 1)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})
