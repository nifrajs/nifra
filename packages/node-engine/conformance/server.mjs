/**
 * The server the protocol conformance suites run against: HTTP/2 by prior knowledge for h2spec, and
 * a WebSocket echo at `/ws` for the Autobahn fuzzing client. Prints `ready <port>` once bound.
 */
import { server } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "../dist/index.js"

const app = server()
  .use(websocket())
  .get("/", () => "ok")
  .post("/", () => "ok")
  .ws("/ws", { message: (ws, message) => ws.send(message) })

const running = await serve(app, {
  port: Number(process.env.PORT ?? 0),
  hostname: "127.0.0.1",
  http2: true,
  wsDeflate: process.env.WS_DEFLATE === "1",
  wsMaxMessageSize: 32 * 1024 * 1024,
})
console.log(`ready ${running.port}`)
