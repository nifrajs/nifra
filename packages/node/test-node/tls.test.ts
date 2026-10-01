import assert from "node:assert/strict"
import { get } from "node:https"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "@nifrajs/node"
import { WebSocket } from "ws"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"

let cert = ""
let port = 0
let stop: (() => Promise<void>) | undefined

before(async () => {
  const pair = await selfSignedCertificate()
  cert = pair.cert
  const app = server()
    .use(websocket())
    .ws("/echo", { message: (ws, data) => ws.send(data) })
    .get("/where", (c) => ({ url: c.req.url }))
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1", tls: pair })
  port = handle.port
  stop = () => handle.stop({ drainMs: 0 })
})

after(async () => {
  await stop?.()
})

function getText(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(`https://127.0.0.1:${port}${path}`, { ca: cert }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        body += chunk
      })
      res.on("end", () => resolve(body))
    }).on("error", reject)
  })
}

test("tls serves HTTPS, and request URLs default to https:", async () => {
  assert.deepEqual(JSON.parse(await getText("/where")), {
    url: `https://127.0.0.1:${port}/where`,
  })
})

test("a WebSocket upgrade arrives over the TLS port", async () => {
  // `ca` for the `ws` package on Node; `tls.ca` for Bun's built-in `ws`, so `bun test` passes too.
  const ws = new WebSocket(`wss://127.0.0.1:${port}/echo`, { ca: cert, tls: { ca: cert } })
  const echoed = await new Promise<string>((resolve, reject) => {
    ws.on("open", () => ws.send("over tls"))
    ws.on("message", (data) => resolve(String(data)))
    ws.on("error", reject)
  })
  ws.close()
  assert.equal(echoed, "over tls")
})
