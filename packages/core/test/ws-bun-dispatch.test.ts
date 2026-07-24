import { describe, expect, test } from "bun:test"
import { TopicRegistry, type WebSocketHandler } from "../src/server/websocket.ts"
import type { BunSocket } from "../src/server/ws-bun.ts"
import { createBunWsHandlers } from "../src/server/ws-bun.ts"

/**
 * The Bun WS dispatcher, driven directly with a fake socket.
 *
 * This layer is what stands between a user's WS callback and the socket loop: a throw in `open`,
 * `message` or `close` must reach `handler.error` and go no further, because an escaping error takes
 * the connection - and on Bun, the loop - with it. Nothing exercised it end to end, so the routing was
 * asserted only by reading it.
 */

interface FakeSocket extends BunSocket {
  readonly sent: string[]
  closedWith: { code: number | undefined; reason: string | undefined } | undefined
}

function fakeSocket(handler: WebSocketHandler): FakeSocket {
  const sent: string[] = []
  const socket = {
    sent,
    closedWith: undefined as { code: number | undefined; reason: string | undefined } | undefined,
    send(data: string | ArrayBufferView | ArrayBuffer) {
      sent.push(String(data))
      return 1
    },
    close(code?: number, reason?: string) {
      socket.closedWith = { code, reason }
    },
    readyState: 1,
    data: { handler, data: undefined as unknown },
  }
  return socket as unknown as FakeSocket
}

describe("createBunWsHandlers", () => {
  test("open wraps the socket once and reuses the wrapper for later frames", () => {
    const seen: unknown[] = []
    const handler: WebSocketHandler = {
      open: (ws) => {
        ws.send("hello")
        seen.push(ws)
      },
      message: (ws, data) => {
        seen.push(ws)
        ws.send(typeof data === "string" ? data : `bin:${data.byteLength}`)
      },
    }
    const socket = fakeSocket(handler)
    const handlers = createBunWsHandlers(new TopicRegistry())

    handlers.open(socket as never)
    handlers.message(socket as never, "ping")
    // A binary frame arrives as bytes, not a string.
    handlers.message(socket as never, new Uint8Array([1, 2, 3]) as never)

    expect(socket.sent).toEqual(["hello", "ping", "bin:3"])
    // The same portable wrapper is handed to every callback, so per-socket state set in `open` survives.
    expect(seen[0]).toBe(seen[1])
    expect(seen[1]).toBe(seen[2])
  })

  test("a throwing callback is routed to handler.error, not out of the socket loop", () => {
    const errors: unknown[] = []
    const handler: WebSocketHandler = {
      open: () => {
        throw new Error("open exploded")
      },
      message: () => Promise.reject(new Error("message exploded")),
      error: (_ws, error) => {
        errors.push((error as Error).message)
      },
    }
    const socket = fakeSocket(handler)
    const handlers = createBunWsHandlers(new TopicRegistry())

    expect(() => handlers.open(socket as never)).not.toThrow()
    expect(() => handlers.message(socket as never, "x")).not.toThrow()
    expect(errors).toContain("open exploded")
  })

  test("an error handler that itself throws is the end of the line", () => {
    const handler: WebSocketHandler = {
      open: () => {
        throw new Error("open exploded")
      },
      error: () => {
        throw new Error("the error handler is broken too")
      },
    }
    // Nothing above this can recover, so the only correct behaviour is to not crash.
    expect(() =>
      createBunWsHandlers(new TopicRegistry()).open(fakeSocket(handler) as never),
    ).not.toThrow()
  })

  test("close drops topic subscriptions so the registry cannot hold a dead socket", () => {
    const topics = new TopicRegistry()
    const handler: WebSocketHandler = {
      open: (ws) => ws.subscribe("room"),
    }
    const socket = fakeSocket(handler)
    const handlers = createBunWsHandlers(topics)

    handlers.open(socket as never)
    topics.publish("room", "before")
    expect(socket.sent).toEqual(["before"])

    handlers.close(socket as never, 1000, "bye")
    topics.publish("room", "after")
    // Still just the one frame: a closed socket must not keep receiving broadcasts.
    expect(socket.sent).toEqual(["before"])
  })

  test("a socket can leave a topic without closing", () => {
    const topics = new TopicRegistry()
    const handler: WebSocketHandler = {
      open: (ws) => ws.subscribe("room"),
      message: (ws) => ws.unsubscribe("room"),
    }
    const socket = fakeSocket(handler)
    const handlers = createBunWsHandlers(topics)

    handlers.open(socket as never)
    topics.publish("room", "first")
    handlers.message(socket as never, "leave")
    topics.publish("room", "second")

    // Left the topic, still connected - so it misses the broadcast but the socket is untouched.
    expect(socket.sent).toEqual(["first"])
    expect(socket.closedWith).toBeUndefined()
  })

  test("the wrapper exposes readyState and per-connection data by reference", () => {
    let captured: { readyState: number; read: unknown } | undefined
    const handler: WebSocketHandler = {
      open: (ws) => {
        ws.data = { user: 7 }
        captured = { readyState: ws.readyState, read: ws.data }
      },
      close: (ws, code, reason) => {
        ws.close(code, reason)
      },
    }
    const socket = fakeSocket(handler)
    const handlers = createBunWsHandlers(new TopicRegistry())

    handlers.open(socket as never)
    expect(captured?.readyState).toBe(1)
    expect(captured?.read).toEqual({ user: 7 })
    // Writes go through to the connection state Bun keeps on `ws.data`.
    expect(socket.data.data).toEqual({ user: 7 })

    handlers.close(socket as never, 1001, "going away")
    expect(socket.closedWith).toEqual({ code: 1001, reason: "going away" })
  })
})
