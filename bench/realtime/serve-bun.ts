/** Baseline: raw Bun.serve WebSocket + native pub/sub + a hand-rolled SSE stream. The ceiling every
 * framework row is measured against - no routing, no validation, no framing helpers. */
export {} // module scope - keep `server`/`port`/`MSG` out of the shared bench global namespace

const port = Number(process.argv[2])
const MSG = JSON.stringify({ t: 1, body: "x".repeat(64) })
const enc = new TextEncoder()

const server = Bun.serve<string>({
  port,
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === "/echo")
      return srv.upgrade(req, { data: "echo" }) ? undefined : new Response("no", { status: 400 })
    if (url.pathname === "/room")
      return srv.upgrade(req, { data: "room" }) ? undefined : new Response("no", { status: 400 })
    if (url.pathname === "/fire") {
      const p = Number(url.searchParams.get("p") ?? "0")
      const t0 = performance.now()
      for (let i = 0; i < p; i++) srv.publish("room", MSG)
      return Response.json({ fired: p, ms: performance.now() - t0 })
    }
    if (url.pathname === "/feed") {
      const n = Number(url.searchParams.get("n") ?? "0")
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < n; i++) c.enqueue(enc.encode(`data: ${JSON.stringify({ n: i })}\n\n`))
          c.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("ok")
  },
  websocket: {
    open(ws) {
      if (ws.data === "room") ws.subscribe("room")
    },
    message(ws, msg) {
      if (ws.data === "echo") ws.send(msg)
    },
  },
})
console.log(`READY ${server.port}`)
