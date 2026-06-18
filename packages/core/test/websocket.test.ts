import { afterEach, describe, expect, test } from "bun:test"
import {
  type NifraWebSocket,
  type RunningServer,
  type StandardSchemaV1,
  type StandardWebSocket,
  server,
  toFetchHandler,
  type WebSocketHandler,
} from "../src/index.ts"
// Value imports come from the subpath — importing it also registers the WS runtime `app.ws()` needs.
import { attachWebSocket, TopicRegistry } from "../src/ws.ts"

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

function makeApp() {
  return server()
    .ws("/echo", {
      open: (ws) => ws.send("welcome"),
      message: (ws, data) => ws.send(data), // echo text or binary
    })
    .ws<{ token: string }>("/guarded", {
      upgrade: (c) => {
        const token = new URL(c.req.url).searchParams.get("token")
        if (token !== "secret") return new Response("unauthorized", { status: 401 })
        return { token }
      },
      open: (ws) => ws.send(`hi ${ws.data.token}`),
    })
    .get("/health", () => ({ ok: true }))
}

// The `resolveWebSocketUpgrade` seam — no socket; this is exactly what the @nifrajs/node, @nifrajs/deno, and
// Workers (toFetchHandler) bridges will call, so testing it here covers all adapters' upgrade logic.
describe("resolveWebSocketUpgrade", () => {
  test("pass when there's no upgrade header", async () => {
    expect((await makeApp().resolveWebSocketUpgrade(new Request("http://t/echo"))).kind).toBe(
      "pass",
    )
  })

  test("pass when an upgrade header hits a non-WS path", async () => {
    const out = await makeApp().resolveWebSocketUpgrade(
      new Request("http://t/nope", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("pass")
  })

  test("no guard → upgrade with undefined data", async () => {
    const out = await makeApp().resolveWebSocketUpgrade(
      new Request("http://t/echo", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("upgrade")
    if (out.kind === "upgrade") expect(out.data).toBeUndefined()
  })

  test("upgrade() returning a Response rejects before connect", async () => {
    const out = await makeApp().resolveWebSocketUpgrade(
      new Request("http://t/guarded", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("reject")
    if (out.kind === "reject") expect(out.response.status).toBe(401)
  })

  test("upgrade() data threads to the outcome", async () => {
    const out = await makeApp().resolveWebSocketUpgrade(
      new Request("http://t/guarded?token=secret", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("upgrade")
    if (out.kind === "upgrade") expect(out.data).toEqual({ token: "secret" })
  })

  test("a throwing guard rejects with a flat 500", async () => {
    const app = server().ws("/boom", {
      upgrade: () => {
        throw new Error("nope")
      },
    })
    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/boom", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("reject")
    if (out.kind === "reject") expect(out.response.status).toBe(500)
  })
})

// A real Bun websocket round-trip through app.listen() — the WS-1 MVP.
describe("app.listen() WebSockets", () => {
  function collect(url: string, send: string[], count: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const got: string[] = []
      const c = new WebSocket(url)
      const timer = setTimeout(() => reject(new Error("timeout")), 3000)
      c.addEventListener("open", () => {
        for (const m of send) c.send(m)
      })
      c.addEventListener("message", (e) => {
        got.push(String(e.data))
        if (got.length >= count) {
          clearTimeout(timer)
          c.close()
          resolve(got)
        }
      })
      c.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("ws error"))
      })
    })
  }

  test("echo: open → welcome, message → echo", async () => {
    running = makeApp().listen(0)
    expect(await collect(`ws://127.0.0.1:${running.port}/echo`, ["hi"], 2)).toEqual([
      "welcome",
      "hi",
    ])
  })

  test("guarded: accepts with a valid token, threading data to ws.data", async () => {
    running = makeApp().listen(0)
    expect(await collect(`ws://127.0.0.1:${running.port}/guarded?token=secret`, [], 1)).toEqual([
      "hi secret",
    ])
  })

  test("guarded: rejects the upgrade without a token (never opens)", async () => {
    running = makeApp().listen(0)
    const outcome = await new Promise<string>((resolve) => {
      const c = new WebSocket(`ws://127.0.0.1:${running?.port}/guarded`)
      let opened = false
      const timer = setTimeout(() => resolve(opened ? "opened" : "rejected"), 700)
      c.addEventListener("open", () => {
        opened = true
      })
      c.addEventListener("error", () => {
        clearTimeout(timer)
        resolve("rejected")
      })
      c.addEventListener("close", () => {
        clearTimeout(timer)
        resolve(opened ? "opened" : "rejected")
      })
    })
    expect(outcome).toBe("rejected")
  })

  test("a normal HTTP route works alongside WS routes", async () => {
    running = makeApp().listen(0)
    const res = await fetch(`http://127.0.0.1:${running.port}/health`)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("binary frames round-trip (Uint8Array normalization)", async () => {
    running = makeApp().listen(0)
    const port = running.port
    const ok = await new Promise<boolean>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/echo`)
      c.binaryType = "arraybuffer"
      const timer = setTimeout(() => reject(new Error("timeout")), 3000)
      let welcomed = false
      c.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          welcomed = true
          c.send(new Uint8Array([1, 2, 3, 4]))
          return
        }
        const bytes = new Uint8Array(e.data as ArrayBuffer)
        clearTimeout(timer)
        c.close()
        resolve(welcomed && bytes.length === 4 && bytes[0] === 1 && bytes[3] === 4)
      })
      c.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("ws error"))
      })
    })
    expect(ok).toBe(true)
  })

  test("a throwing open handler is routed to error() (never crashes the socket loop)", async () => {
    running = server()
      .ws("/boom", {
        open: () => {
          throw new Error("open failed")
        },
        error: (ws) => ws.send("errored"),
      })
      .listen(0)
    expect(await collect(`ws://127.0.0.1:${running.port}/boom`, [], 1)).toEqual(["errored"])
  })

  test("pub/sub: subscribe receives broadcasts; ws.unsubscribe stops them", async () => {
    const app = server().ws("/room", {
      open: (ws) => ws.subscribe("lobby"),
      message: (ws, m) => {
        if (m === "leave") ws.unsubscribe("lobby")
      },
    })
    running = app.listen(0)
    const url = `ws://127.0.0.1:${running.port}/room`
    const a = new WebSocket(url)
    const b = new WebSocket(url)
    const aMsgs: string[] = []
    const bMsgs: string[] = []
    a.addEventListener("message", (e) => aMsgs.push(String(e.data)))
    b.addEventListener("message", (e) => bMsgs.push(String(e.data)))
    // Both open ⇒ their server-side open() has subscribed them to "lobby".
    await Promise.all(
      [a, b].map(
        (c) =>
          new Promise<void>((resolve, reject) => {
            c.addEventListener("open", () => resolve())
            c.addEventListener("error", () => reject(new Error("open failed")))
          }),
      ),
    )
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10)
    }
    app.publish("lobby", "m1")
    await waitFor(() => aMsgs.length === 1 && bMsgs.length === 1)
    b.send("leave") // b unsubscribes server-side
    await Bun.sleep(50) // let the server process the unsubscribe before the next broadcast
    app.publish("lobby", "m2")
    await waitFor(() => aMsgs.length === 2)
    expect(aMsgs).toEqual(["m1", "m2"])
    expect(bMsgs).toEqual(["m1"]) // b unsubscribed, so it missed m2
    a.close()
    b.close()
  })
})

// attachWebSocket — the shared bridge the @nifrajs/deno + Workers (toFetchHandler) adapters use over a
// standard WebSocket. Tested with a fake socket (no runtime), covering dispatch + normalization.
describe("attachWebSocket", () => {
  class FakeSocket implements StandardWebSocket {
    sent: (string | ArrayBufferView | ArrayBuffer)[] = []
    closedWith: { code?: number; reason?: string } | undefined
    binaryType = "blob"
    readyState = 1
    private listeners: Record<string, ((event: never) => void)[]> = {}
    send(data: string | ArrayBufferView | ArrayBuffer): void {
      this.sent.push(data)
    }
    close(code?: number, reason?: string): void {
      this.closedWith = code === undefined ? {} : reason === undefined ? { code } : { code, reason }
    }
    addEventListener(type: string, listener: (event: never) => void): void {
      let list = this.listeners[type]
      if (list === undefined) {
        list = []
        this.listeners[type] = list
      }
      list.push(listener)
    }
    fire(type: string, event: unknown): void {
      for (const l of this.listeners[type] ?? []) (l as (e: unknown) => void)(event)
    }
  }

  test("openNow fires open immediately; sets arraybuffer; send/close proxy", () => {
    const socket = new FakeSocket()
    let opened = false
    const handler: WebSocketHandler = {
      open: (ws) => {
        opened = true
        ws.send("hello")
      },
    }
    attachWebSocket(socket, handler, undefined, { openNow: true, pubsub: new TopicRegistry() })
    expect(opened).toBe(true)
    expect(socket.binaryType).toBe("arraybuffer")
    expect(socket.sent).toEqual(["hello"])
  })

  test("openNow:false waits for the open event", () => {
    const socket = new FakeSocket()
    let opened = false
    attachWebSocket(
      socket,
      {
        open: () => {
          opened = true
        },
      },
      undefined,
      { openNow: false, pubsub: new TopicRegistry() },
    )
    expect(opened).toBe(false)
    socket.fire("open", undefined)
    expect(opened).toBe(true)
  })

  test("text and binary messages normalize to string | Uint8Array", () => {
    const socket = new FakeSocket()
    const seen: unknown[] = []
    attachWebSocket(
      socket,
      {
        message: (_ws, data) => {
          seen.push(data)
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry() },
    )
    socket.fire("message", { data: "text" })
    socket.fire("message", { data: new Uint8Array([1, 2]).buffer }) // ArrayBuffer
    expect(seen[0]).toBe("text")
    expect(seen[1]).toBeInstanceOf(Uint8Array)
    expect(Array.from(seen[1] as Uint8Array)).toEqual([1, 2])
  })

  test("close threads code + reason; data is exposed and mutable", () => {
    const socket = new FakeSocket()
    let closed: { code: number; reason: string } | undefined
    const ws = attachWebSocket(
      socket,
      {
        close: (_ws, code, reason) => {
          closed = { code, reason }
        },
      },
      { n: 1 },
      { openNow: true, pubsub: new TopicRegistry() },
    )
    expect(ws.data).toEqual({ n: 1 })
    ws.data = { n: 2 }
    expect(ws.data).toEqual({ n: 2 })
    socket.fire("close", { code: 1001, reason: "bye" })
    expect(closed).toEqual({ code: 1001, reason: "bye" })
  })

  test("a throwing message handler routes to error(), not a crash", () => {
    const socket = new FakeSocket()
    let errored: unknown
    attachWebSocket(
      socket,
      {
        message: () => {
          throw new Error("boom")
        },
        error: (_ws, err) => {
          errored = err
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry() },
    )
    expect(() => socket.fire("message", { data: "x" })).not.toThrow()
    expect(errored).toBeInstanceOf(Error)
  })

  test("a socket error event routes to error()", () => {
    const socket = new FakeSocket()
    let errored = false
    attachWebSocket(
      socket,
      {
        error: () => {
          errored = true
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry() },
    )
    socket.fire("error", new Event("error"))
    expect(errored).toBe(true)
  })

  test("the returned NifraWebSocket proxies send/close/readyState/raw + subscribe/unsubscribe", () => {
    const socket = new FakeSocket()
    const pubsub = new TopicRegistry()
    const ws = attachWebSocket(socket, {}, undefined, { openNow: true, pubsub })
    expect(ws.readyState).toBe(1)
    expect(ws.raw).toBe(socket)
    ws.send("out")
    ws.close(1000, "bye")
    expect(socket.sent).toEqual(["out"])
    expect(socket.closedWith).toEqual({ code: 1000, reason: "bye" })
    // subscribe → an app.publish-style broadcast reaches this socket; unsubscribe stops it.
    ws.subscribe("t")
    pubsub.publish("t", "ping")
    expect(socket.sent).toEqual(["out", "ping"])
    ws.unsubscribe("t")
    pubsub.publish("t", "ping2")
    expect(socket.sent).toEqual(["out", "ping"]) // no new frame after unsubscribe
  })

  test("close unsubscribes the connection from all topics", () => {
    const socket = new FakeSocket()
    const pubsub = new TopicRegistry()
    const ws = attachWebSocket(socket, {}, undefined, { openNow: true, pubsub })
    ws.subscribe("t")
    socket.fire("close", { code: 1000, reason: "" }) // close → pubsub.unsubscribeAll
    pubsub.publish("t", "after-close")
    expect(socket.sent).toEqual([]) // the closed socket received nothing
  })
})

// toFetchHandler's Workers WS branch (feature-detected WebSocketPair). Mocked here so the branch runs
// on Bun; the real 101 round-trip is verified on workerd. The 101 Response only constructs on Workers,
// so off-workerd the `upgrade` path throws right after accept()+wire — which is what we assert.
describe("toFetchHandler WebSockets (Workers WebSocketPair)", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }

  function fakeServerSocket() {
    return {
      accepted: false,
      sent: [] as unknown[],
      readyState: 1,
      binaryType: "blob",
      accept() {
        this.accepted = true
      },
      send(d: unknown) {
        this.sent.push(d)
      },
      close() {},
      addEventListener() {},
    }
  }

  function withMockedPair<T>(socket: object, run: () => T): T {
    const g = globalThis as { WebSocketPair?: unknown }
    const original = g.WebSocketPair
    g.WebSocketPair = class {
      readonly 0 = {}
      readonly 1 = socket
    }
    try {
      return run()
    } finally {
      g.WebSocketPair = original
    }
  }

  test("non-WS request passes through to app.fetch (WS branch feature-gated)", async () => {
    const handler = toFetchHandler(
      server()
        .ws("/ws", { open: () => {} })
        .get("/h", () => ({ ok: true })),
    )
    const res = await withMockedPair(fakeServerSocket(), () =>
      Promise.resolve(handler.fetch(new Request("http://t/h"), {}, ctx)),
    )
    expect(await res.json()).toEqual({ ok: true })
  })

  test("a rejected upgrade returns the guard's Response (no 101)", async () => {
    const handler = toFetchHandler(
      server().ws("/ws", { upgrade: () => new Response("denied", { status: 403 }) }),
    )
    const res = await withMockedPair(fakeServerSocket(), () =>
      Promise.resolve(
        handler.fetch(new Request("http://t/ws", { headers: { upgrade: "websocket" } }), {}, ctx),
      ),
    )
    expect(res.status).toBe(403)
  })

  test("an accepted upgrade accept()s the server socket + wires the handler", () => {
    const sock = fakeServerSocket()
    let opened = false
    const handler = toFetchHandler(
      server().ws("/ws", {
        open: () => {
          opened = true
        },
      }),
    )
    withMockedPair(sock, () => {
      try {
        handler.fetch(new Request("http://t/ws", { headers: { upgrade: "websocket" } }), {}, ctx)
      } catch {
        // `new Response(null, { status: 101 })` throws off-workerd — expected; accept()+wire already ran.
      }
    })
    expect(sock.accepted).toBe(true)
    expect(opened).toBe(true)
  })
})

// TopicRegistry — the in-process pub/sub backing ws.subscribe + app.publish. Unit-tested with fake
// sockets (no runtime), covering broadcast, unsubscribe, close-cleanup, and send-error isolation.
describe("TopicRegistry", () => {
  function fakeWs() {
    const sent: unknown[] = []
    return { sent, send: (d: unknown) => sent.push(d) }
  }

  test("publish reaches every subscriber; unsubscribe + unsubscribeAll remove", () => {
    const r = new TopicRegistry()
    const a = fakeWs()
    const b = fakeWs()
    r.subscribe("t", a as unknown as NifraWebSocket)
    r.subscribe("t", b as unknown as NifraWebSocket)
    r.publish("t", "x")
    expect(a.sent).toEqual(["x"])
    expect(b.sent).toEqual(["x"])

    r.unsubscribe("t", b as unknown as NifraWebSocket)
    r.publish("t", "y")
    expect(a.sent).toEqual(["x", "y"])
    expect(b.sent).toEqual(["x"]) // b no longer receives

    r.unsubscribeAll(a as unknown as NifraWebSocket)
    r.publish("t", "z") // nobody subscribed → no-op (empty topic reclaimed)
    expect(a.sent).toEqual(["x", "y"])
  })

  test("a throwing send does not abort the broadcast to other subscribers", () => {
    const r = new TopicRegistry()
    const bad = {
      send: () => {
        throw new Error("dead socket")
      },
    }
    const good = fakeWs()
    r.subscribe("t", bad as unknown as NifraWebSocket)
    r.subscribe("t", good as unknown as NifraWebSocket)
    expect(() => r.publish("t", "x")).not.toThrow()
    expect(good.sent).toEqual(["x"])
  })

  test("publish to an unknown topic is a no-op", () => {
    expect(() => new TopicRegistry().publish("nobody-here", "x")).not.toThrow()
  })
})

// Contract-validated WS messages: a `messageSchema` validates each inbound frame (JSON-parsed); the
// handler's `message` then receives the typed value, invalid frames go to `onInvalidMessage`. The
// wrapping happens once at app.ws() registration, so this is verified through the public seam + a live
// round-trip (one path covers every adapter).
describe("WS messageSchema (contract-validated messages)", () => {
  // A hand-rolled Standard Schema for { text: string } — no @nifrajs/schema dependency in core tests.
  const textSchema: StandardSchemaV1<unknown, { text: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) =>
        typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string"
          ? { value: { text: (v as { text: string }).text } }
          : { issues: [{ message: "expected { text: string }" }] },
    },
  }
  const fakeWs = (): NifraWebSocket => ({
    send: () => {},
    close: () => {},
    readyState: 1,
    subscribe: () => {},
    unsubscribe: () => {},
    data: undefined,
    raw: null,
  })

  test("valid JSON → typed message; invalid JSON + schema failure → onInvalidMessage", async () => {
    const seen: Array<{ text: string }> = []
    const invalid: Array<{ issue: string; raw: unknown }> = []
    const app = server().ws("/m", {
      messageSchema: textSchema,
      message: (_ws, msg) => {
        // msg is typed { text: string } at compile time; assert at runtime too.
        seen.push(msg)
      },
      onInvalidMessage: (_ws, issues, raw) => {
        invalid.push({ issue: issues[0]?.message ?? "", raw })
      },
    })
    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/m", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("upgrade")
    if (out.kind !== "upgrade") return
    const ws = fakeWs()
    await out.handler.message?.(ws, JSON.stringify({ text: "hello" })) // valid
    await out.handler.message?.(ws, "not json{") // parse failure
    await out.handler.message?.(ws, JSON.stringify({ nope: 1 })) // schema failure
    expect(seen).toEqual([{ text: "hello" }])
    expect(invalid).toEqual([
      { issue: "invalid JSON", raw: "not json{" },
      { issue: "expected { text: string }", raw: JSON.stringify({ nope: 1 }) },
    ])
  })

  test("an async schema is awaited before dispatch", async () => {
    const asyncSchema: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (v) =>
          typeof v === "number" ? { value: v } : { issues: [{ message: "not a number" }] },
      },
    }
    const seen: number[] = []
    const app = server().ws("/n", {
      messageSchema: asyncSchema,
      message: (_ws, n) => void seen.push(n),
    })
    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/n", { headers: { upgrade: "websocket" } }),
    )
    if (out.kind !== "upgrade") throw new Error("expected upgrade")
    await out.handler.message?.(fakeWs(), "42")
    expect(seen).toEqual([42])
  })

  test("a binary frame is decoded as UTF-8 then JSON-validated", async () => {
    const seen: Array<{ text: string }> = []
    const app = server().ws("/b", {
      messageSchema: textSchema,
      message: (_ws, m) => void seen.push(m),
    })
    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/b", { headers: { upgrade: "websocket" } }),
    )
    if (out.kind !== "upgrade") throw new Error("expected upgrade")
    await out.handler.message?.(fakeWs(), new TextEncoder().encode(JSON.stringify({ text: "bin" })))
    expect(seen).toEqual([{ text: "bin" }])
  })

  test("live: app.ws with messageSchema validates over a real Bun socket", async () => {
    running = server()
      .ws("/echo", {
        messageSchema: textSchema,
        message: (ws, msg) => ws.send(`got:${msg.text}`),
        onInvalidMessage: (ws) => ws.send("invalid"),
      })
      .listen(0)
    const url = `ws://127.0.0.1:${running.port}/echo`
    const send = (frame: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const c = new WebSocket(url)
        const timer = setTimeout(() => reject(new Error("timeout")), 3000)
        c.addEventListener("open", () => c.send(frame))
        c.addEventListener("message", (e) => {
          clearTimeout(timer)
          c.close()
          resolve(String(e.data))
        })
        c.addEventListener("error", () => {
          clearTimeout(timer)
          reject(new Error("ws error"))
        })
      })
    expect(await send(JSON.stringify({ text: "hi" }))).toBe("got:hi")
    expect(await send("garbage")).toBe("invalid")
  })
})

describe("ws runtime gate (@nifrajs/core/ws)", () => {
  // The registration is process-global, so the unregistered state can only be observed in a fresh
  // process: spawn one that calls app.ws() WITHOUT importing the subpath and assert the boot error.
  test("app.ws() without `import '@nifrajs/core/ws'` fails loud at registration", async () => {
    const script = `
      import { server } from "${new URL("../src/index.ts", import.meta.url).pathname}"
      try {
        server().ws("/chat", { message: () => {} })
        console.log("NO_THROW")
      } catch (err) {
        console.log(err?.code === "WS_RUNTIME_MISSING" && /@nifrajs\\/core\\/ws/.test(err?.message) ? "GATED" : "WRONG_ERROR:" + err)
      }
    `
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    expect(out.trim()).toBe("GATED")
  })
})

describe("server-side socket controls", () => {
  test("ws.data is mutable server-side and ws.close(code, reason) closes the client", async () => {
    running = server()
      .ws<{ n: number }>("/ctl", {
        upgrade: () => ({ n: 0 }),
        open: (ws) => {
          ws.data = { n: ws.data.n + 1 } // exercise the data setter on the Bun wrapper
          ws.send(`${ws.data.n}:${ws.readyState}`) // readyState: 1 (OPEN) on the Bun wrapper
        },
        message: (ws) => ws.close(4001, "done"),
      })
      .listen(0)
    const closed = await new Promise<{ code: number; got: string[] }>((resolve, reject) => {
      const got: string[] = []
      const c = new WebSocket(`ws://127.0.0.1:${running?.port}/ctl`)
      const timer = setTimeout(() => reject(new Error("timeout")), 3000)
      c.addEventListener("message", (e) => {
        got.push(String(e.data))
        c.send("bye")
      })
      c.addEventListener("close", (e) => {
        clearTimeout(timer)
        resolve({ code: e.code, got })
      })
      c.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("ws error"))
      })
    })
    expect(closed.got).toEqual(["1:1"])
    expect(closed.code).toBe(4001)
  })
})

describe("allowedOrigins CSWSH guard (audit 2026-06, L3)", () => {
  const wsReq = (origin?: string) =>
    new Request("http://t/chat", {
      headers: origin === undefined ? { upgrade: "websocket" } : { upgrade: "websocket", origin },
    })

  test("allow-list: matching Origin upgrades, others + absent → 403", async () => {
    const app = server().ws("/chat", {
      allowedOrigins: ["https://app.example.com"],
      message: (ws, d) => ws.send(d),
    })
    expect((await app.resolveWebSocketUpgrade(wsReq("https://app.example.com"))).kind).toBe(
      "upgrade",
    )
    const evil = await app.resolveWebSocketUpgrade(wsReq("https://evil.example.com"))
    expect(evil.kind).toBe("reject")
    if (evil.kind === "reject") expect(evil.response.status).toBe(403)
    const none = await app.resolveWebSocketUpgrade(wsReq())
    expect(none.kind).toBe("reject") // absent Origin fails the allow-list form
  })

  test("predicate form is honored", async () => {
    const app = server().ws("/chat", {
      allowedOrigins: (o) => o?.endsWith(".trusted.com") ?? false,
      message: (ws, d) => ws.send(d),
    })
    expect((await app.resolveWebSocketUpgrade(wsReq("https://x.trusted.com"))).kind).toBe("upgrade")
    expect((await app.resolveWebSocketUpgrade(wsReq("https://x.evil.com"))).kind).toBe("reject")
  })

  test("origin check runs BEFORE upgrade() (a disallowed origin never reaches the guard)", async () => {
    let upgradeRan = false
    const app = server().ws("/chat", {
      allowedOrigins: ["https://ok.com"],
      upgrade: () => {
        upgradeRan = true
        return {}
      },
      message: (ws, d) => ws.send(d),
    })
    await app.resolveWebSocketUpgrade(wsReq("https://evil.com"))
    expect(upgradeRan).toBe(false)
  })

  test("no allowedOrigins → no built-in check (back-compat)", async () => {
    const app = server().ws("/chat", { message: (ws, d) => ws.send(d) })
    expect((await app.resolveWebSocketUpgrade(wsReq("https://anywhere.com"))).kind).toBe("upgrade")
  })
})
