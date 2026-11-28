/**
 * The server the protocol conformance suites run against: HTTP/2 for h2spec (over TLS when
 * `TLS_CERT` and `TLS_KEY` name PEM files, else by prior knowledge), and a WebSocket echo at `/ws`
 * for the Autobahn fuzzing client. Prints `ready <port>` once bound.
 */
import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "../dist/index.js"

const app = server()
  .use(websocket())
  .get("/", () => "ok")
  .post("/", () => "ok")
  .ws("/ws", { message: (ws, message) => ws.send(message) })

const { TLS_CERT, TLS_KEY } = process.env
const tls =
  TLS_CERT && TLS_KEY ? { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) } : undefined

const running = await serve(app, {
  port: Number(process.env.PORT ?? 0),
  hostname: "127.0.0.1",
  http2: true,
  tls,
  wsDeflate: process.env.WS_DEFLATE === "1",
  wsMaxMessageSize: 32 * 1024 * 1024,
})
console.log(`ready ${running.port}`)
