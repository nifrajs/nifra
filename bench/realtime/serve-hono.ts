/** Hono realtime target: `createBunWebSocket()` for Bun native WS + `streamSSE` for the SSE lane.
 * Broadcast subscribes the raw Bun socket and publishes through the Bun server (`getBunServer`). */

import type { ServerWebSocket } from "bun"
import { Hono } from "hono"
import { createBunWebSocket, getBunServer } from "hono/bun"
import { streamSSE } from "hono/streaming"

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>()
const port = Number(process.argv[2])
const MSG = JSON.stringify({ t: 1, body: "x".repeat(64) })

const app = new Hono()
app.get(
  "/echo",
  upgradeWebSocket(() => ({
    onMessage(evt, ws) {
      ws.send(evt.data as string)
    },
  })),
)
app.get(
  "/room",
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      ;(ws.raw as ServerWebSocket | undefined)?.subscribe("room")
    },
  })),
)
app.get("/fire", (c) => {
  const p = Number(c.req.query("p") ?? "0")
  const srv = getBunServer(c) as { publish(topic: string, data: string): void } | undefined
  const t0 = performance.now()
  for (let i = 0; i < p; i++) srv?.publish("room", MSG)
  return c.json({ fired: p, ms: performance.now() - t0 })
})
app.get("/feed", (c) =>
  streamSSE(c, async (stream) => {
    const n = Number(c.req.query("n") ?? "0")
    for (let i = 0; i < n; i++) await stream.writeSSE({ data: JSON.stringify({ n: i }) })
  }),
)

const server = Bun.serve({ port, fetch: app.fetch, websocket })
console.log(`READY ${server.port}`)
