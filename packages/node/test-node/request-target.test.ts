/**
 * Request targets with dot segments, on **Node itself**: `IncomingMessage.url` is the target exactly as
 * the client sent it, so this is the runtime where the adapter's own resolution is the only one.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "@nifrajs/node"
import {
  rawUpgradeStatus,
  requestTargetApp,
  requestTargetMismatches,
} from "../../core/test/request-target-matrix.ts"

test("a target with dot segments or a backslash routes the path it resolves to", async () => {
  const running = await serve(requestTargetApp(server()), { port: 0, hostname: "127.0.0.1" })
  try {
    assert.deepEqual(await requestTargetMismatches(running.port), [])
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

test("a handshake target with dot segments upgrades on the path it resolves to", async () => {
  const app = server()
    .use(websocket())
    .ws("/echo", { message: (ws, data) => ws.send(data) })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assert.equal(await rawUpgradeStatus(running.port, "/rooms/../echo"), 101)
    assert.equal(await rawUpgradeStatus(running.port, "/rooms/%2e%2e/echo"), 101)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})
