import { afterEach, describe, expect, test } from "bun:test"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import type { RunningServer } from "../src/index.ts"
import { server } from "../src/index.ts"
import { websocket } from "../src/ws.ts"

const { cert, key } = await selfSignedCertificate()
/** The test certificate is self-signed, so each client trusts it explicitly. */
const trusted = { tls: { ca: cert } }
/** Bun's WebSocket client takes `tls` too; the global typing, merged with Node's, shows only `protocols`. */
const TlsWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket

let stop: (() => Promise<void>) | undefined
afterEach(async () => {
  await stop?.()
  stop = undefined
})

const listening = (app: { stop(): Promise<void> }, running: RunningServer): string => {
  stop = () => app.stop()
  return `127.0.0.1:${running.port}`
}

describe("listen({ tls })", () => {
  test("serves HTTPS, and requests see https: URLs on both Bun lanes", async () => {
    const app = server()
      .get("/static", () => ({ ok: true }))
      .get("/users/:id", (c) => ({ url: c.req.url }))
    const host = listening(app, app.listen(0, { hostname: "127.0.0.1", tls: { cert, key } }))

    expect(await (await fetch(`https://${host}/static`, trusted)).json()).toEqual({ ok: true })
    expect(await (await fetch(`https://${host}/users/7`, trusted)).json()).toEqual({
      url: `https://${host}/users/7`,
    })
    // The fallback handler answers what the native route table does not.
    expect((await fetch(`https://${host}/missing`, trusted)).status).toBe(404)
    // The port speaks TLS only.
    const plain = await fetch(`http://${host}/static`).then(
      (r) => r.status as number | string,
      () => "refused",
    )
    expect(plain).toBe("refused")
  })

  test("a WebSocket app serves wss: and https: from the same port, with the PEM as bytes", async () => {
    const app = server()
      .use(websocket())
      .ws("/echo", { message: (ws, data) => ws.send(data) })
      .get("/health", (c) => ({ url: c.req.url }))
    const bytes = new TextEncoder()
    const host = listening(
      app,
      app.listen(0, {
        hostname: "127.0.0.1",
        tls: { cert: bytes.encode(cert), key: bytes.encode(key) },
      }),
    )

    expect(await (await fetch(`https://${host}/health`, trusted)).json()).toEqual({
      url: `https://${host}/health`,
    })
    const ws = new TlsWebSocket(`wss://${host}/echo`, trusted)
    const echoed = await new Promise<unknown>((resolve, reject) => {
      ws.onopen = () => ws.send("over tls")
      ws.onmessage = (event) => resolve(event.data)
      ws.onerror = () => reject(new Error("wss connection failed"))
    })
    ws.close()
    expect(echoed).toBe("over tls")
  })
})
