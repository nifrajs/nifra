import { afterEach, describe, expect, test } from "bun:test"
import { heapGrowth, isReleased } from "@nifrajs/test-utils/leak"
import {
  type NifraWebSocket,
  type RunningServer,
  type StandardWebSocket,
  server,
  type WebSocketHandler,
} from "../src/index.ts"
import { attachWebSocket, TopicRegistry, websocket } from "../src/ws.ts"

/**
 * Real sockets through `app.listen()`: a connection that subscribed to a topic and went away must
 * leave nothing behind in the server's registries. Each round trip waits on the server's own close
 * event, not a timer, so the measurement starts only once the server has finished with the socket.
 */

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

function chatServer() {
  let topic = 0
  let lastOpened: WeakRef<object> | undefined
  let serverClosed: (() => void) | undefined
  const app = server()
    .use(websocket())
    .ws("/chat", {
      open: (ws: NifraWebSocket) => {
        lastOpened = new WeakRef(ws)
        ws.subscribe(`topic:${topic++}`)
        ws.subscribe("everyone")
      },
      close: () => serverClosed?.(),
    })
  running = app.listen(0, { hostname: "127.0.0.1" })
  const url = `ws://127.0.0.1:${running.port}/chat`

  /** One client connects, the server subscribes it, the client leaves, the server sees the close. */
  async function visit(): Promise<WeakRef<object>> {
    const closed = new Promise<void>((resolve) => {
      serverClosed = resolve
    })
    const client = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      client.addEventListener("open", () => resolve(), { once: true })
      client.addEventListener("error", () => reject(new Error("ws error")), { once: true })
    })
    client.close()
    await closed
    if (lastOpened === undefined) throw new Error("the server never opened the socket")
    return lastOpened
  }
  return { visit }
}

describe("websocket registries after a client leaves", () => {
  test("the server-side socket is released", async () => {
    const { visit } = chatServer()
    expect(await isReleased(visit, { samples: 6, minCollected: 4 })).toBe(true)
  })

  test("heap stays flat across connections that each subscribe to a new topic", async () => {
    const { visit } = chatServer()
    const result = await heapGrowth(
      async () => {
        await visit()
      },
      { warmup: 100, iterations: 600 },
    )
    expect(result.bytesPerIteration).toBeLessThan(256)
  })
})

/** The portable path Node, Deno and Workers take: a TopicRegistry the server keeps for its lifetime. */
describe("TopicRegistry after a socket closes", () => {
  class FakeSocket implements StandardWebSocket {
    binaryType = "blob"
    readyState = 1
    private readonly listeners: Record<string, ((event: never) => void)[]> = {}
    send(): void {}
    close(): void {}
    addEventListener(type: string, listener: (event: never) => void): void {
      this.listeners[type] = [...(this.listeners[type] ?? []), listener]
    }
    fire(type: string, event: { readonly code: number; readonly reason: string }): void {
      for (const listener of this.listeners[type] ?? []) Reflect.apply(listener, undefined, [event])
    }
  }

  const visitOn = (registry: TopicRegistry) => {
    let n = 0
    return (): WeakRef<object> => {
      const socket = new FakeSocket()
      const handler: WebSocketHandler = {
        open: (ws) => {
          ws.subscribe(`topic:${n++}`)
          ws.subscribe("everyone")
        },
      }
      const ws = attachWebSocket(socket, handler, undefined, { openNow: true, pubsub: registry })
      socket.fire("close", { code: 1000, reason: "" })
      return new WeakRef(ws)
    }
  }

  test("the socket is released", async () => {
    const registry = new TopicRegistry()
    expect(await isReleased(visitOn(registry))).toBe(true)
  })

  test("heap stays flat across sockets that each subscribe to a new topic", async () => {
    const visit = visitOn(new TopicRegistry())
    const result = await heapGrowth(() => {
      visit()
    })
    expect(result.bytesPerIteration).toBeLessThan(64)
  })
})
