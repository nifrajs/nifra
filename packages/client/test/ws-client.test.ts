import { afterEach, describe, expect, test } from "bun:test"
import { client, testClient } from "@nifrajs/client"
import type { RunningServer, StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { openWebSocket } from "../src/ws.ts"

const NativeWebSocket = globalThis.WebSocket

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readyState = 0
  readonly sent: string[] = []
  readonly closeCalls: Array<{ code?: number; reason?: string }> = []

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super()
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  send(frame: string): void {
    this.sent.push(frame)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }

  fail(): Event {
    const event = new Event("error")
    this.dispatchEvent(event)
    return event
  }

  end(): void {
    this.dispatchEvent(new Event("close"))
  }
}

function useFakeWebSocket(): void {
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
}

function schema<O>(validate: (value: unknown) => StandardResult<O>): StandardSchemaV1<unknown, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, O>,
    },
  }
}

const chatIn = schema<{ say: string }>((v) =>
  typeof v === "object" &&
  v !== null &&
  "say" in v &&
  typeof (v as { say: unknown }).say === "string"
    ? { value: { say: (v as { say: string }).say } }
    : { issues: [{ message: "say must be a string", path: ["say"] }] },
)
const chatOut = schema<{ echoed: string; at: number }>((v) => ({
  value: v as { echoed: string; at: number },
}))

const app = server()
  .use(websocket())
  .get("/health", () => ({ ok: true }))
  .ws("/chat", {
    messageSchema: chatIn,
    sendSchema: chatOut,
    message: (ws, data) => {
      ws.send(JSON.stringify({ echoed: data.say, at: 1 }))
    },
  })

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
  globalThis.WebSocket = NativeWebSocket
})

describe("typed client .ws()", () => {
  test("send/messages round-trip a typed frame over a real socket", async () => {
    running = app.listen(0)
    const api = client<typeof app>(`http://127.0.0.1:${running.port}`)

    const chat = api.chat.ws()
    chat.send({ say: "hello" }) // queued until open - must not throw
    await chat.opened

    const iterator = chat.messages()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ echoed: "hello", at: 1 })

    chat.close()
    const end = await iterator.next()
    expect(end.done).toBe(true)
  })

  test("onMessage callback form delivers parsed frames and unsubscribes", async () => {
    running = app.listen(0)
    const api = client<typeof app>(`http://127.0.0.1:${running.port}`)
    const chat = api.chat.ws()

    const got: unknown[] = []
    const stop = chat.onMessage((m) => got.push(m))
    chat.send({ say: "one" })
    await chat.opened
    // Wait for the frame to arrive.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (got.length > 0) {
          clearInterval(t)
          resolve()
        }
      }, 5)
    })
    expect(got).toEqual([{ echoed: "one", at: 1 }])
    stop()
    chat.close()
  })

  test("a schema-invalid inbound frame is dropped by the server, not echoed", async () => {
    running = app.listen(0)
    const api = client<typeof app>(`http://127.0.0.1:${running.port}`)
    const chat = api.chat.ws()
    await chat.opened

    // Bypass the typed surface to send a frame the messageSchema rejects.
    chat.raw.send(JSON.stringify({ not: "the contract" }))
    chat.send({ say: "after" })

    const iterator = chat.messages()
    const first = await iterator.next()
    // Only the valid frame comes back - the invalid one never reached the handler.
    expect(first.value).toEqual({ echoed: "after", at: 1 })
    chat.close()
  })

  test("the in-process client refuses .ws() with a real explanation", () => {
    const api = testClient<typeof app>(app)
    expect(() => api.chat.ws()).toThrow(/in-process client cannot open WebSockets/)
  })
})

describe("WebSocket runtime behavior", () => {
  test("builds the secure URL, queues until open, and filters off-contract frames", async () => {
    useFakeWebSocket()
    const handle = openWebSocket(
      "https://example.test",
      "/chat",
      { query: { room: "a b", page: 2, secure: true }, protocols: ["nifra-json"] },
      false,
    )
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toBe("wss://example.test/chat?room=a+b&page=2&secure=true")
    expect(socket.protocols).toEqual(["nifra-json"])

    handle.send({ queued: true })
    expect(socket.sent).toEqual([])
    socket.open()
    await handle.opened
    expect(socket.sent).toEqual(['{"queued":true}'])

    handle.send({ immediate: true })
    const messages: unknown[] = []
    const unsubscribe = handle.onMessage((message) => messages.push(message))
    socket.message(new Uint8Array([1, 2]))
    socket.message("not-json")
    socket.message('{"accepted":true}')
    unsubscribe()
    socket.message('{"ignored":true}')
    expect(messages).toEqual([{ accepted: true }])
    expect(socket.sent.at(-1)).toBe('{"immediate":true}')

    handle.close(1000, "done")
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "done" }])
  })

  test("reports connection failures and rejects opened", async () => {
    useFakeWebSocket()
    const errors: unknown[] = []
    const handle = openWebSocket(
      "http://example.test",
      "",
      { onError: (e) => errors.push(e) },
      false,
    )
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toBe("ws://example.test/")
    const event = socket.fail()

    expect(errors).toEqual([event])
    await expect(handle.opened).rejects.toThrow("websocket_connect_failed")
  })

  test("fails clearly when the runtime has no WebSocket implementation", () => {
    globalThis.WebSocket = undefined as unknown as typeof WebSocket
    expect(() => openWebSocket("http://example.test", "/chat", undefined, false)).toThrow(
      /no global WebSocket/,
    )
  })

  test("call and iterator abort signals close or finish their respective operation", async () => {
    useFakeWebSocket()
    const alreadyAborted = AbortSignal.abort()
    openWebSocket("http://example.test", "/one", { signal: alreadyAborted }, false)
    const firstSocket = FakeWebSocket.instances[0]!
    expect(firstSocket.closeCalls).toHaveLength(1)

    const callAbort = new AbortController()
    const handle = openWebSocket("http://example.test", "/two", { signal: callAbort.signal }, false)
    const secondSocket = FakeWebSocket.instances[1]!
    callAbort.abort()
    expect(secondSocket.closeCalls).toHaveLength(1)

    const iteratorAbort = new AbortController()
    const iterator = handle.messages({ signal: iteratorAbort.signal })
    const pending = iterator.next()
    iteratorAbort.abort()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })

  test("async iteration handles buffered, pending, closed, and explicit-return states", async () => {
    useFakeWebSocket()
    const handle = openWebSocket("http://example.test", "/chat", undefined, false)
    const socket = FakeWebSocket.instances[0]!
    const iterator = handle.messages()
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator)

    socket.message('{"buffered":1}')
    expect(await iterator.next()).toEqual({ value: { buffered: 1 }, done: false })

    const pending = iterator.next()
    socket.message('{"pending":2}')
    expect(await pending).toEqual({ value: { pending: 2 }, done: false })

    expect(await iterator.return()).toEqual({ value: undefined, done: true })
    expect(await iterator.next()).toEqual({ value: undefined, done: true })

    const closingIterator = handle.messages()
    const closingPending = closingIterator.next()
    socket.end()
    expect(await closingPending).toEqual({ value: undefined, done: true })
  })
})
