/** Elysia realtime target: `.ws()` (Bun native WS under the hood) + a generator SSE handler using
 * Elysia's `sse()` helper. Broadcast goes through the Bun server Elysia owns (`app.server.publish`). */
import { Elysia, sse } from "elysia"

const port = Number(process.argv[2])
const MSG = JSON.stringify({ t: 1, body: "x".repeat(64) })

const app = new Elysia()
  .ws("/echo", { message: (ws, message) => ws.send(message) })
  .ws("/room", { open: (ws) => ws.subscribe("room") })
  .get("/fire", ({ query }) => {
    const p = Number((query as { p?: string }).p ?? "0")
    const t0 = performance.now()
    for (let i = 0; i < p; i++) app.server?.publish("room", MSG)
    return { fired: p, ms: performance.now() - t0 }
  })
  .get("/feed", function* ({ query }) {
    const n = Number((query as { n?: string }).n ?? "0")
    for (let i = 0; i < n; i++) yield sse({ data: { n: i } })
  })
  .listen(port, () => console.log(`READY ${port}`))
