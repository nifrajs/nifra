/** nifra realtime target: `.use(websocket())` + `.use(streaming())`, the shipped WS + SSE lanes
 * (validated message dispatch, typed SSE framing). Imports built dist, like the other benches. */
import { server } from "../../packages/core/dist/index.js"
import { streaming } from "../../packages/core/dist/server/sse.js"
import { websocket } from "../../packages/core/dist/ws.js"
import { t } from "../../packages/schema/dist/index.js"

const port = Number(process.argv[2])
const MSG = JSON.stringify({ t: 1, body: "x".repeat(64) })

const app = server()
  .use(websocket())
  .use(streaming())
  .ws("/echo", { message: (ws, data) => ws.send(data as string) })
  .ws("/room", { open: (ws) => ws.subscribe("room") })
  .get("/fire", (c) => {
    const p = Number(new URL(c.req.url).searchParams.get("p") ?? "0")
    const t0 = performance.now()
    for (let i = 0; i < p; i++) app.publish("room", MSG)
    return { fired: p, ms: performance.now() - t0 }
  })
  .sse("/feed", { sse: t.object({ n: t.integer() }) }, (c, stream) => {
    const n = Number(new URL(c.req.url).searchParams.get("n") ?? "0")
    for (let i = 0; i < n; i++) stream.send({ n: i })
    stream.close()
  })

app.listen(port) // listen() is the Bun adapter binding on the built server
console.log(`READY ${port}`)
