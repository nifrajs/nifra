import { afterEach, describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import type { RunningServer } from "../src/server.ts"
import type { WebSocketUpgradeOutcome } from "../src/ws.ts"
import { attachWebSocket, TopicRegistry, websocket } from "../src/ws.ts"

/**
 * WebSockets through a composed app. `mount({ app })` carries upgrades for any child exposing
 * `resolveWebSocketUpgrade`, including one that is not a nifra server and builds its outcome from
 * `@nifrajs/core/ws`. `mountFetch` carries HTTP only.
 */

let running: RunningServer | undefined
afterEach(() => {
  running?.stop()
  running = undefined
})

/** The first frame the socket receives after sending `ping`, or how it ended without one. */
const firstFrame = (url: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url)
    socket.addEventListener("open", () => socket.send("ping"))
    socket.addEventListener("message", (event) => {
      resolve(`message: ${String(event.data)}`)
      socket.close()
    })
    socket.addEventListener("error", () => resolve("error"))
    socket.addEventListener("close", () => resolve("closed"))
  })

/** A child that is not a nifra server: HTTP through fetch, upgrades from the public ws subpath. */
function plainChild() {
  const pubsub = new TopicRegistry()
  return {
    fetch: () => new Response("plain http"),
    resolveWebSocketUpgrade: (request: Request): WebSocketUpgradeOutcome =>
      new URL(request.url).pathname === "/chat"
        ? {
            kind: "upgrade",
            handler: { message: (ws, data) => ws.send(`plain ${String(data)}`) },
            data: undefined,
            pubsub,
            attach: attachWebSocket,
          }
        : { kind: "pass" },
  }
}

describe("WebSockets through composed children", () => {
  test("mount() carries a nifra child's and a plain child's upgrades; mountFetch carries none", async () => {
    const child = server()
      .use(websocket())
      .ws("/chat", { message: (ws, data) => ws.send(`nifra ${String(data)}`) })
    running = server()
      .use(websocket())
      .mount({ path: "/nifra", app: child, stripPrefix: true })
      .mount({ path: "/plain", app: plainChild(), stripPrefix: true })
      .mountFetch("/legacy", () => new Response("legacy http"), { stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    const base = `127.0.0.1:${running.port}`
    expect(await firstFrame(`ws://${base}/nifra/chat`)).toBe("message: nifra ping")
    expect(await firstFrame(`ws://${base}/plain/chat`)).toBe("message: plain ping")
    expect(await firstFrame(`ws://${base}/legacy/chat`)).not.toStartWith("message")
    const http = await fetch(`http://${base}/plain/page`)
    expect(await http.text()).toBe("plain http")
  })

  test("on Bun, a plain child's upgrades need the websocket() runtime on the parent", () => {
    const parent = server().mount({ path: "/plain", app: plainChild(), stripPrefix: true })
    expect(() => {
      running = parent.listen(0, { hostname: "127.0.0.1" })
    }).toThrow("needs the websocket() runtime installed on the parent or child app")
  })
})
