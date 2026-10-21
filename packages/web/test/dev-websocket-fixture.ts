/**
 * One app WebSocket route and the checks both dev servers run on it: the handshake reaches the
 * route's `upgrade()` guard, an accepted socket echoes and hears `app.publish`, and a refused Host
 * never upgrades. The app comes from the suite, so this file imports nothing.
 */
import { connect } from "node:net"

interface WsRoutable {
  ws(path: string, handler: object): unknown
  publish(topic: string, data: string): unknown
}

interface RoomSocket {
  subscribe(topic: string): void
  send(data: string): void
}

/** Registers `/room` on `app`: `?deny` is refused by the guard; an open socket joins `room`. */
export function roomApp<App extends WsRoutable>(app: App): App {
  app.ws("/room", {
    upgrade: (c: { req: Request }) =>
      new URL(c.req.url).searchParams.has("deny")
        ? new Response("denied", { status: 403 })
        : undefined,
    open: (ws: RoomSocket) => {
      ws.subscribe("room")
      ws.send("hello")
    },
    message: (ws: RoomSocket, data: unknown) => ws.send(`echo:${String(data)}`),
  })
  return app
}

/** Open `/room`, echo once, then hear one publish; resolves with every frame in order. */
export async function roomRoundTrip(app: WsRoutable, port: number): Promise<string[]> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/room`)
  const frames: string[] = []
  const arrived: (() => void)[] = []
  socket.addEventListener("message", (event) => {
    frames.push(String(event.data))
    for (const wake of arrived.splice(0)) wake()
  })
  const count = async (n: number): Promise<void> => {
    while (frames.length < n) await new Promise<void>((resolve) => arrived.push(resolve))
  }
  await count(1)
  socket.send("x")
  await count(2)
  app.publish("room", "news")
  await count(3)
  socket.close()
  return frames
}

/** The status line's code of a raw WebSocket handshake for `path` under `host`. */
export function handshakeStatus(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let raw = ""
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      ),
    )
    socket.on("data", (chunk) => {
      raw += chunk
      if (raw.includes("\r\n")) {
        socket.destroy()
        resolve(Number(raw.slice(9, 12)))
      }
    })
    socket.on("error", reject)
  })
}
