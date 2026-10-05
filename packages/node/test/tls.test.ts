import { afterEach, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { type NodeServer, serve } from "../src/index.ts"

const { cert, key } = await selfSignedCertificate()
/** The test certificate is self-signed, so each client trusts it explicitly. */
const trusted = { tls: { ca: cert } }
/** Bun's WebSocket client takes `tls` too; the global typing, merged with Node's, shows only `protocols`. */
const TlsWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

test("tls serves HTTPS, and request URLs default to https:", async () => {
  const app = server()
    .get("/where", (c) => ({ url: c.req.url }))
    .post("/echo", (c) => c.req.json())
  running = await serve(app, { port: 0, hostname: "127.0.0.1", tls: { cert, key } })
  const base = `https://127.0.0.1:${running.port}`

  expect(await (await fetch(`${base}/where`, trusted)).json()).toEqual({ url: `${base}/where` })
  const echoed = await fetch(`${base}/echo`, {
    ...trusted,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ over: "tls" }),
  })
  expect(await echoed.json()).toEqual({ over: "tls" })
})

test("an explicit protocol still wins over the tls default", async () => {
  const app = server().get("/where", (c) => ({ url: c.req.url }))
  running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert, key },
    protocol: () => "http",
  })
  const res = await fetch(`https://127.0.0.1:${running.port}/where`, trusted)
  expect(await res.json()).toEqual({ url: `http://127.0.0.1:${running.port}/where` })
})

test("a WebSocket upgrade arrives over the TLS port", async () => {
  const app = server()
    .use(websocket())
    .ws("/echo", { message: (ws, data) => ws.send(data) })
  running = await serve(app, { port: 0, hostname: "127.0.0.1", tls: { cert, key } })

  const ws = new TlsWebSocket(`wss://127.0.0.1:${running.port}/echo`, trusted)
  const echoed = await new Promise<unknown>((resolve, reject) => {
    ws.onopen = () => ws.send("over tls")
    ws.onmessage = (event) => resolve(event.data)
    ws.onerror = () => reject(new Error("wss connection failed"))
  })
  ws.close()
  expect(echoed).toBe("over tls")
})
