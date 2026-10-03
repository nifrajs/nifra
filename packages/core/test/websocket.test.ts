import { afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  type NifraWebSocket,
  type RunningServer,
  type StandardSchemaV1,
  type StandardWebSocket,
  server,
  toFetchHandler,
  type WebSocketHandler,
} from "../src/index.ts"
// The `websocket()` plugin and the socket-wiring value exports both come from the subpath.
import { attachWebSocket, TopicRegistry, websocket } from "../src/ws.ts"

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

function makeApp() {
  return server()
    .use(websocket())
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

// The `resolveWebSocketUpgrade` seam - no socket; this is exactly what the @nifrajs/node, @nifrajs/deno, and
// Workers (toFetchHandler) bridges will call, so testing it here covers all adapters' upgrade logic.
describe("resolveWebSocketUpgrade", () => {
  test("a clientIp trust declaration reaches the handshake's onRequest hooks", async () => {
    const hookSaw: (string | undefined)[] = []
    const app = server({ clientIp: { header: "x-real-ip" } })
      .use(websocket())
      .onRequest((_req, platform) => {
        hookSaw.push(platform?.clientIp)
        return platform?.clientIp === "6.6.6.6"
          ? new Response("denied", { status: 403 })
          : undefined
      })
      .ws("/sock", { upgrade: () => ({}) })
    const handshake = (ip: string) =>
      app.resolveWebSocketUpgrade(
        new Request("http://t/sock", { headers: { upgrade: "websocket", "x-real-ip": ip } }),
        { clientIp: "127.0.0.1" },
      )
    const denied = await handshake("6.6.6.6")
    expect(denied.kind).toBe("reject")
    expect((await handshake("1.1.1.1")).kind).toBe("upgrade")
    expect(hookSaw).toEqual(["6.6.6.6", "1.1.1.1"])
  })

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

  test("pass for a non-GET request with an upgrade header, so its HTTP route answers it", async () => {
    let guardRan = 0
    const app = server()
      .use(websocket())
      .ws("/both", {
        upgrade: () => {
          guardRan += 1
          return {}
        },
      })
      .post("/both", () => ({ posted: true }))
    const post = () =>
      new Request("http://t/both", { method: "POST", headers: { upgrade: "websocket" } })
    expect((await app.resolveWebSocketUpgrade(post())).kind).toBe("pass")
    expect(guardRan).toBe(0)
    expect(await (await app.fetch(post())).json()).toEqual({ posted: true })
  })

  test("no guard → upgrade with undefined data", async () => {
    const out = await makeApp().resolveWebSocketUpgrade(
      new Request("http://t/echo", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("upgrade")
    if (out.kind === "upgrade") expect(out.data).toBeUndefined()
  })

  test("global request hooks and platform context apply to the upgrade guard", async () => {
    const seen: Array<{ clientIp: string | undefined; path: string }> = []
    const app = server<{ TOKEN: string }>()
      .onRequest((request, platform) => {
        seen.push({ clientIp: platform?.clientIp, path: new URL(request.url).pathname })
        return undefined
      })
      .use(websocket())
      .ws<{ token: string }>("/guarded", {
        upgrade: (c) => ({ token: c.env.TOKEN }),
      })

    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/guarded", { headers: { upgrade: "websocket" } }),
      { env: { TOKEN: "from-platform" }, clientIp: "203.0.113.8" },
    )
    expect(seen).toEqual([{ clientIp: "203.0.113.8", path: "/guarded" }])
    expect(out.kind).toBe("upgrade")
    if (out.kind === "upgrade") expect(out.data).toEqual({ token: "from-platform" })
  })

  test("async request hooks chain before the upgrade guard", async () => {
    const seen: string[] = []
    const app = server()
      .onRequest(async (request) => {
        seen.push("first")
        return new Request(new URL("/guarded", request.url).href, {
          method: request.method,
          headers: request.headers,
        })
      })
      .onRequest(async (request) => {
        seen.push(new URL(request.url).pathname)
        return undefined
      })
      .use(websocket())
      .ws("/guarded", { upgrade: () => ({ ok: true }) })

    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/original", { headers: { upgrade: "websocket" } }),
    )
    expect(seen).toEqual(["first", "/guarded"])
    expect(out.kind).toBe("upgrade")
  })

  test("a rejected request hook becomes a flat 500", async () => {
    const app = server()
      .onRequest(async () => {
        throw new Error("private hook detail")
      })
      .use(websocket())
      .ws("/guarded", { upgrade: () => ({}) })

    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/guarded", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("reject")
    if (out.kind === "reject") {
      expect(out.response.status).toBe(500)
      expect(await out.response.text()).not.toContain("private hook detail")
    }
  })

  test("upgrade guards have a bounded default deadline", async () => {
    const app = server({ wsUpgradeTimeoutMs: 10 })
      .use(websocket())
      .ws("/slow", {
        upgrade: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100))
          return {}
        },
      })
    const out = await app.resolveWebSocketUpgrade(
      new Request("http://t/slow", { headers: { upgrade: "websocket" } }),
    )
    expect(out.kind).toBe("reject")
    if (out.kind === "reject") expect(out.response.status).toBe(503)
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
    const app = server()
      .use(websocket())
      .ws("/boom", {
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

  // Deno builds a request's headers only when they are read, and its adapter asks this of every
  // request.
  test("a WebSocket-free mount leaves the request's headers unread", async () => {
    const app = server().mount({
      path: "/api",
      app: server().get("/x", () => "x"),
      stripPrefix: true,
    })
    const request = new Request("http://t/api/x")
    let reads = 0
    Object.defineProperty(request, "headers", {
      get: () => {
        reads += 1
        return new Headers()
      },
    })
    expect((await app.resolveWebSocketUpgrade(request)).kind).toBe("pass")
    expect(reads).toBe(0)
  })

  test("a mounted app that gains a WebSocket route later upgrades", async () => {
    const child = server()
    const app = server().mount({ path: "/api", app: child, stripPrefix: true })
    const upgrade = () => new Request("http://t/api/echo", { headers: { upgrade: "websocket" } })
    expect((await app.resolveWebSocketUpgrade(upgrade())).kind).toBe("pass")
    child.use(websocket()).ws("/echo", { message: (ws, data) => ws.send(data) })
    expect((await app.resolveWebSocketUpgrade(upgrade())).kind).toBe("upgrade")
  })

  test("an app with a WebSocket route mounted further down later upgrades", async () => {
    const inner = server()
      .use(websocket())
      .ws("/echo", { message: (ws, data) => ws.send(data) })
    const middle = server()
    const app = server().mount({ path: "/middle", app: middle, stripPrefix: true })
    const upgrade = () =>
      new Request("http://t/middle/inner/echo", { headers: { upgrade: "websocket" } })
    expect((await app.resolveWebSocketUpgrade(upgrade())).kind).toBe("pass")
    middle.mount({ path: "/inner", app: inner, stripPrefix: true })
    expect((await app.resolveWebSocketUpgrade(upgrade())).kind).toBe("upgrade")
  })
})

// A real Bun websocket round-trip through app.listen() - the WS-1 MVP.
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
    running = makeApp().listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/echo`, ["hi"], 2)).toEqual([
      "welcome",
      "hi",
    ])
  })

  test("opt-in sendSchema validation drops invalid Bun frames", async () => {
    const sendSchema: StandardSchemaV1<unknown, { text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { text?: unknown }).text === "string"
            ? { value: value as { text: string } }
            : { issues: [{ message: "expected { text: string }" }] },
      },
    }
    running = server()
      .use(websocket())
      .ws("/validated", {
        sendSchema,
        validateSend: true,
        open: (ws) => {
          ws.send(JSON.stringify({ text: "ok" }))
          ws.send(JSON.stringify({ text: 42 }))
        },
      })
      .listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/validated`, [], 1)).toEqual([
      JSON.stringify({ text: "ok" }),
    ])
  })

  test("guarded: accepts with a valid token, threading data to ws.data", async () => {
    running = makeApp().listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/guarded?token=secret`, [], 1)).toEqual([
      "hi secret",
    ])
  })

  test("guarded: rejects the upgrade without a token (never opens)", async () => {
    running = makeApp().listen(0, { hostname: "127.0.0.1" })
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

  // End-to-end over a real Bun socket: the server option has to reach the runtime, not just the
  // upgrade outcome, or every adapter enforces nothing.
  test("wsMaxPayloadBytes closes a socket that sends an oversize frame", async () => {
    running = server({ wsMaxPayloadBytes: 8 })
      .use(websocket())
      .ws("/echo", { message: (ws, data) => ws.send(data) })
      .listen(0, { hostname: "127.0.0.1" })
    const closed = await new Promise<number>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${running?.port}/echo`)
      const timer = setTimeout(() => reject(new Error("timeout")), 3000)
      c.addEventListener("open", () => c.send("x".repeat(64)))
      c.addEventListener("message", () => {
        clearTimeout(timer)
        reject(new Error("the oversize frame was echoed back"))
      })
      c.addEventListener("close", (e) => {
        clearTimeout(timer)
        resolve(e.code)
      })
    })
    // Bun drops the connection outright rather than sending a 1009 close frame, so the client sees
    // 1006 (abnormal closure); the `attachWebSocket` path used by the other adapters sends 1009.
    // What matters at this level is that the frame was refused and never reached the handler.
    expect([1006, 1009]).toContain(closed)
  })

  test("a normal HTTP route works alongside WS routes", async () => {
    running = makeApp().listen(0, { hostname: "127.0.0.1" })
    const res = await fetch(`http://127.0.0.1:${running.port}/health`)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("binary frames round-trip (Uint8Array normalization)", async () => {
    running = makeApp().listen(0, { hostname: "127.0.0.1" })
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
      .use(websocket())
      .ws("/boom", {
        open: () => {
          throw new Error("open failed")
        },
        error: (ws) => ws.send("errored"),
      })
      .listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/boom`, [], 1)).toEqual(["errored"])
  })

  test("pub/sub: subscribe receives broadcasts; ws.unsubscribe stops them", async () => {
    const app = server()
      .use(websocket())
      .ws("/room", {
        open: (ws) => ws.subscribe("lobby"),
        message: (ws, m) => {
          if (m === "leave") ws.unsubscribe("lobby")
        },
      })
    running = app.listen(0, { hostname: "127.0.0.1" })
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

  // A validateSend route makes broadcast bytes route-dependent (validated + dropped per socket), so
  // the app must keep the JS registry publish path - never Bun's native topic broadcast, which would
  // deliver raw frames unchecked. This locks that: a valid broadcast lands, an invalid one is dropped.
  test("pub/sub with validateSend keeps registry validation (no native broadcast bypass)", async () => {
    const sendSchema: StandardSchemaV1<unknown, { text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { text?: unknown }).text === "string"
            ? { value: value as { text: string } }
            : { issues: [{ message: "expected { text: string }" }] },
      },
    }
    const app = server()
      .use(websocket())
      .ws("/room", {
        sendSchema,
        validateSend: true,
        open: (ws) => ws.subscribe("lobby"),
      })
    running = app.listen(0, { hostname: "127.0.0.1" })
    const c = new WebSocket(`ws://127.0.0.1:${running.port}/room`)
    const msgs: string[] = []
    c.addEventListener("message", (e) => msgs.push(String(e.data)))
    await new Promise<void>((resolve, reject) => {
      c.addEventListener("open", () => resolve())
      c.addEventListener("error", () => reject(new Error("open failed")))
    })
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10)
    }
    app.publish("lobby", JSON.stringify({ text: "ok" })) // valid -> delivered
    app.publish("lobby", JSON.stringify({ text: 42 })) // invalid -> dropped per socket
    await waitFor(() => msgs.length === 1)
    await Bun.sleep(50) // give any (wrongly) undropped invalid frame time to arrive
    expect(msgs).toEqual([JSON.stringify({ text: "ok" })])
    c.close()
  })

  // A mounted Nifra app takes part in Bun's WebSocket wiring only while it has a WebSocket route, so
  // composing one without any - the `api` backend `createWebApp` mounts - needs no runtime.
  test("a mounted app without WebSocket routes listens without a runtime", async () => {
    const nested = server().mount({
      path: "/v1",
      app: server().get("/y", () => "y"),
      stripPrefix: true,
    })
    running = server()
      .mount({ path: "/api", app: server().get("/x", () => "x"), stripPrefix: true })
      .mount({ path: "/nested", app: nested, stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    expect(await (await fetch(`http://127.0.0.1:${running.port}/api/x`)).json()).toBe("x")
    expect(await (await fetch(`http://127.0.0.1:${running.port}/nested/v1/y`)).json()).toBe("y")
  })

  test("a parent's own WebSocket routes still upgrade beside a WebSocket-free mount", async () => {
    running = makeApp()
      .mount({ path: "/api", app: server().get("/x", () => "x"), stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/echo`, ["hi"], 2)).toEqual([
      "welcome",
      "hi",
    ])
    expect(await (await fetch(`http://127.0.0.1:${running.port}/api/x`)).json()).toBe("x")
  })

  // Bun's own broadcast reaches only sockets subscribed through Bun, so a frame sent with the
  // handle's `publish` arriving shows the app kept native pub/sub.
  test("native pub/sub stays on beside a WebSocket-free mount", async () => {
    running = server()
      .use(websocket())
      .ws("/room", {
        open: (ws) => {
          ws.subscribe("lobby")
          ws.send("joined")
        },
      })
      .mount({ path: "/api", app: server().get("/x", () => "x"), stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    const c = new WebSocket(`ws://127.0.0.1:${running.port}/room`)
    const msgs: string[] = []
    c.addEventListener("message", (e) => {
      msgs.push(String(e.data))
      if (msgs.length === 1) running?.publish?.("lobby", "native")
    })
    for (let i = 0; i < 200 && msgs.length < 2; i++) await Bun.sleep(10)
    c.close()
    expect(msgs).toEqual(["joined", "native"])
  })

  // Its sockets would land on this server's Bun topics, beside the parent's own.
  test("under native pub/sub, a WebSocket route a mounted app gains after listen() does not upgrade", async () => {
    const child = server()
    running = makeApp()
      .mount({ path: "/api", app: child, stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    child.use(websocket()).ws("/echo", { open: (ws) => ws.send("child-ready") })
    const outcome = await new Promise<string>((resolve) => {
      const c = new WebSocket(`ws://127.0.0.1:${running?.port}/api/echo`)
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

  test("listening again after a mounted app gained a WebSocket route upgrades it", async () => {
    const child = server()
    const app = makeApp().mount({ path: "/api", app: child, stripPrefix: true })
    app.listen(0, { hostname: "127.0.0.1" }).stop(true)
    child.use(websocket()).ws("/echo", { open: (ws) => ws.send("child-ready") })
    running = app.listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/api/echo`, [], 1)).toEqual(["child-ready"])
  })

  test("a mounted child's WebSocket route upgrades through a parent with no runtime", async () => {
    const child = server()
      .use(websocket())
      .ws("/echo", {
        open: (ws) => ws.send("child-ready"),
        message: (ws, data) => ws.send(data),
      })
    running = server()
      .mount({ path: "/api", app: child, stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/api/echo`, ["ping"], 2)).toEqual([
      "child-ready",
      "ping",
    ])
  })

  // The runtime is asked for when `listen()` runs, not when the child is mounted.
  test("a child given its runtime and WebSocket route after the mount upgrades", async () => {
    const late = server()
    const parent = server().mount({ path: "/late", app: late, stripPrefix: true })
    late.use(websocket()).ws("/echo", { open: (ws) => ws.send("late-ready") })
    running = parent.listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/late/echo`, [], 1)).toEqual(["late-ready"])
  })

  test("a WebSocket route two mounts down upgrades through the outer app", async () => {
    const inner = server()
      .use(websocket())
      .ws("/echo", { message: (ws, data) => ws.send(data) })
    const middle = server().mount({ path: "/inner", app: inner, stripPrefix: true })
    running = server()
      .mount({ path: "/middle", app: middle, stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/middle/inner/echo`, ["deep"], 1)).toEqual([
      "deep",
    ])
  })

  test("a mounted resolver that names no runtime still needs one", async () => {
    const inner = server()
      .use(websocket())
      .ws("/echo", { message: (ws, data) => ws.send(data) })
    // Forwards the resolver but not the runtime seam, so it cannot say whether it takes an upgrade.
    const wrapped = {
      fetch: (request: Request) => inner.fetch(request),
      resolveWebSocketUpgrade: (request: Request) => inner.resolveWebSocketUpgrade(request),
    }
    const bare = server().mount({ path: "/api", app: wrapped, stripPrefix: true })
    expect(() => {
      running = bare.listen(0, { hostname: "127.0.0.1" })
    }).toThrow("websocket() runtime")
    running = server()
      .use(websocket())
      .mount({ path: "/api", app: wrapped, stripPrefix: true })
      .listen(0, { hostname: "127.0.0.1" })
    expect(await collect(`ws://127.0.0.1:${running.port}/api/echo`, ["wrapped"], 1)).toEqual([
      "wrapped",
    ])
  })

  test("an app mounted under itself to alias a prefix still listens", async () => {
    const app = server().get("/x", () => "x")
    app.mount({ path: "/v1", app, stripPrefix: true })
    running = app.listen(0, { hostname: "127.0.0.1" })
    expect(await (await fetch(`http://127.0.0.1:${running.port}/v1/x`)).json()).toBe("x")
  })
})

// attachWebSocket - the shared bridge the @nifrajs/deno + Workers (toFetchHandler) adapters use over a
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

  test("opt-in send validation checks JSON text and UTF-8 binary before sending", () => {
    const socket = new FakeSocket()
    const errors: unknown[] = []
    const schema: StandardSchemaV1<unknown, { text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { text?: unknown }).text === "string"
            ? { value: value as { text: string } }
            : { issues: [{ message: "expected { text: string }" }] },
      },
    }
    const ws = attachWebSocket(
      socket,
      {
        sendSchema: schema,
        validateSend: true,
        error: (_ws, error) => {
          errors.push(error)
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry() },
    )
    ws.send(JSON.stringify({ text: "ok" }))
    ws.send(new TextEncoder().encode(JSON.stringify({ text: "binary" })))
    ws.send(JSON.stringify({ text: 42 }))
    ws.send("not json")
    expect(socket.sent).toHaveLength(2)
    expect(socket.sent[0]).toBe(JSON.stringify({ text: "ok" }))
    expect(new TextDecoder().decode(socket.sent[1] as Uint8Array)).toBe(
      JSON.stringify({ text: "binary" }),
    )
    expect(errors).toHaveLength(2)
  })

  test("async send validators fail closed without an unhandled rejection", () => {
    const socket = new FakeSocket()
    const errors: unknown[] = []
    const schema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ value: "ok" }),
      },
    }
    const ws = attachWebSocket(
      socket,
      {
        sendSchema: schema,
        validateSend: true,
        error: (_ws, error) => {
          errors.push(error)
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry() },
    )
    ws.send(JSON.stringify("ok"))
    expect(socket.sent).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("must be synchronous")
  })

  test("an error handler that sends a rejected diagnostic reports once instead of recursing", () => {
    const socket = new FakeSocket()
    const errors: unknown[] = []
    const schema: StandardSchemaV1<unknown, { text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { text?: unknown }).text === "string"
            ? { value: value as { text: string } }
            : { issues: [{ message: "expected { text: string }" }] },
      },
    }
    let ws!: ReturnType<typeof attachWebSocket>
    ws = attachWebSocket(
      socket,
      {
        sendSchema: schema,
        validateSend: true,
        error: (_socket, error) => {
          errors.push(error)
          // The diagnostic itself violates the same contract. Reporting it must not re-enter the
          // handler; without the re-entrancy guard this recurses until the stack is exhausted.
          ws.send(JSON.stringify({ text: 42 }))
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry() },
    )
    expect(() => ws.send(JSON.stringify({ text: 42 }))).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(socket.sent).toHaveLength(0)
  })

  test("a rejected async validator is contained by the same re-entrancy guard", () => {
    const socket = new FakeSocket()
    const errors: unknown[] = []
    const schema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ value: "ok" }),
      },
    }
    let ws!: ReturnType<typeof attachWebSocket>
    ws = attachWebSocket(
      socket,
      {
        sendSchema: schema,
        validateSend: true,
        error: (_socket, error) => {
          errors.push(error)
          ws.send(JSON.stringify("again"))
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry() },
    )
    expect(() => ws.send(JSON.stringify("ok"))).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(socket.sent).toHaveLength(0)
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

  // Without a cap the handler sees whatever the peer sent, so a single frame can pin however much
  // memory the runtime was willing to buffer. 1009 is the RFC 6455 "message too big" code.
  test("an oversize frame closes with 1009 and never reaches the handler", () => {
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
      { openNow: true, pubsub: new TopicRegistry(), maxPayloadBytes: 4 },
    )
    socket.fire("message", { data: "ok" }) // 2 bytes - delivered
    expect(seen).toEqual(["ok"])

    socket.fire("message", { data: "toolong" })
    expect(seen).toHaveLength(1)
    expect(socket.closedWith).toEqual({ code: 1009, reason: "message too large" })

    // The cap counts UTF-8 bytes, not UTF-16 code units: 3 characters, 6 bytes.
    const utf8 = new FakeSocket()
    const seenUtf8: unknown[] = []
    attachWebSocket(
      utf8,
      {
        message: (_ws, data) => {
          seenUtf8.push(data)
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry(), maxPayloadBytes: 4 },
    )
    utf8.fire("message", { data: "ééé" })
    expect(seenUtf8).toEqual([])
    expect(utf8.closedWith).toEqual({ code: 1009, reason: "message too large" })

    // And binary frames are measured by their real byte length.
    const bin = new FakeSocket()
    const seenBin: unknown[] = []
    attachWebSocket(
      bin,
      {
        message: (_ws, data) => {
          seenBin.push(data)
        },
      },
      undefined,
      { openNow: true, pubsub: new TopicRegistry(), maxPayloadBytes: 4 },
    )
    bin.fire("message", { data: new Uint8Array([1, 2, 3, 4]).buffer })
    expect(seenBin).toHaveLength(1)
    bin.fire("message", { data: new Uint8Array([1, 2, 3, 4, 5]).buffer })
    expect(seenBin).toHaveLength(1)
    expect(bin.closedWith).toEqual({ code: 1009, reason: "message too large" })
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
// so off-workerd the `upgrade` path throws right after accept()+wire - which is what we assert.
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
        .use(websocket())
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
      server()
        .use(websocket())
        .ws("/ws", { upgrade: () => new Response("denied", { status: 403 }) }),
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
      server()
        .use(websocket())
        .ws("/ws", {
          open: () => {
            opened = true
          },
        }),
    )
    withMockedPair(sock, () => {
      try {
        handler.fetch(new Request("http://t/ws", { headers: { upgrade: "websocket" } }), {}, ctx)
      } catch {
        // `new Response(null, { status: 101 })` throws off-workerd - expected; accept()+wire already ran.
      }
    })
    expect(sock.accepted).toBe(true)
    expect(opened).toBe(true)
  })

  test("an accepted upgrade enforces wsMaxPayloadBytes on inbound frames", () => {
    const listeners = new Map<string, (event: { readonly data: unknown }) => void>()
    const closed: unknown[] = []
    const received: unknown[] = []
    const sock = {
      ...fakeServerSocket(),
      addEventListener(type: string, listener: (event: { readonly data: unknown }) => void) {
        listeners.set(type, listener)
      },
      close(code?: number) {
        closed.push(code)
      },
    }
    const handler = toFetchHandler(
      server({ wsMaxPayloadBytes: 8 })
        .use(websocket())
        .ws("/ws", { message: (_ws, data) => void received.push(data) }),
    )
    withMockedPair(sock, () => {
      try {
        handler.fetch(new Request("http://t/ws", { headers: { upgrade: "websocket" } }), {}, ctx)
      } catch {
        // `new Response(null, { status: 101 })` throws off-workerd - expected; accept()+wire already ran.
      }
    })
    listeners.get("message")?.({ data: "short" })
    listeners.get("message")?.({ data: "x".repeat(20) })
    expect(received).toEqual(["short"])
    expect(closed).toEqual([1009])
  })

  // The `webSocketHub` option is the only way `app.publish` reaches every client on Workers: a
  // stateless isolate cannot hold connections, so upgrades have to be handed to one Durable Object.
  // Untested until now, because inside `server.ts` this branch hid inside a 3,200-line file's average.
  test("webSocketHub hands the upgrade to the single hub Durable Object", async () => {
    const seen: { name?: unknown; request?: Request } = {}
    const ns = {
      idFromName(name: string) {
        seen.name = name
        return { name }
      },
      get(id: unknown) {
        return {
          fetch: (request: Request) => {
            seen.request = request
            return Promise.resolve(new Response(null, { status: 101, headers: { id: String(id) } }))
          },
        }
      },
    }
    const handler = toFetchHandler(
      server()
        .use(websocket())
        .ws("/ws", { open: () => {} }),
      { webSocketHub: () => ns },
    )
    const req = new Request("http://t/ws", { headers: { upgrade: "WebSocket" } })
    const res = await handler.fetch(req, {}, ctx)
    expect(res.status).toBe(101)
    // One hub per app: the id is derived from a fixed name, so every isolate reaches the same object.
    expect(seen.name).toBe("nifra-ws-hub")
    // The hub resolves the route itself, so it needs the original request, not a rebuilt one.
    expect(seen.request).toBe(req)
  })

  test("webSocketHub leaves non-upgrade requests on the normal fetch path", async () => {
    const ns = {
      idFromName: () => {
        throw new Error("the hub must not be consulted for a plain request")
      },
      get: () => ({ fetch: () => Promise.resolve(new Response(null)) }),
    }
    const handler = toFetchHandler(
      server()
        .use(websocket())
        .ws("/ws", { open: () => {} })
        .get("/h", () => ({ ok: true })),
      { webSocketHub: () => ns },
    )
    const res = await handler.fetch(new Request("http://t/h"), {}, ctx)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// TopicRegistry - the in-process pub/sub backing ws.subscribe + app.publish. Unit-tested with fake
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
  // A hand-rolled Standard Schema for { text: string } - no @nifrajs/schema dependency in core tests.
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
    const app = server()
      .use(websocket())
      .ws("/m", {
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

  test("a __proto__ key in a frame gets the app's protoPoisoning policy, as a JSON body does", async () => {
    const passthrough: StandardSchemaV1<unknown, object> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) =>
          typeof v === "object" && v !== null
            ? { value: v }
            : { issues: [{ message: "expected an object" }] },
      },
    }
    const poisoned = '{"text":"x","__proto__":{"admin":true}}'
    const run = async (protoPoisoning?: "reject" | "strip" | "ignore") => {
      const seen: object[] = []
      const invalid: string[] = []
      const app = server(protoPoisoning === undefined ? {} : { protoPoisoning })
        .use(websocket())
        .ws("/p", {
          messageSchema: passthrough,
          message: (_ws, msg) => void seen.push(msg),
          onInvalidMessage: (_ws, issues) => void invalid.push(issues[0]?.message ?? ""),
        })
      const out = await app.resolveWebSocketUpgrade(
        new Request("http://t/p", { headers: { upgrade: "websocket" } }),
      )
      if (out.kind !== "upgrade") throw new Error("expected upgrade")
      await out.handler.message?.(fakeWs(), poisoned)
      return { seen, invalid }
    }
    expect(await run()).toEqual({ seen: [], invalid: ["invalid JSON"] })
    const stripped = await run("strip")
    expect(stripped.invalid).toEqual([])
    expect(Object.hasOwn(stripped.seen[0] ?? {}, "__proto__")).toBe(false)
    const ignored = await run("ignore")
    expect(Object.hasOwn(ignored.seen[0] ?? {}, "__proto__")).toBe(true)
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
    const app = server()
      .use(websocket())
      .ws("/n", {
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
    const app = server()
      .use(websocket())
      .ws("/b", {
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
      .use(websocket())
      .ws("/echo", {
        messageSchema: textSchema,
        message: (ws, msg) => ws.send(`got:${msg.text}`),
        onInvalidMessage: (ws) => ws.send("invalid"),
      })
      .listen(0, { hostname: "127.0.0.1" })
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

describe("ws runtime gate (.use(websocket()))", () => {
  // A fresh process that calls app.ws() WITHOUT `.use(websocket())` must fail loud at registration.
  test("app.ws() without `.use(websocket())` fails loud at registration", async () => {
    const script = `
      import { server } from ${JSON.stringify(fileURLToPath(new URL("../src/index.ts", import.meta.url)))}
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

  test("validateSend requires a sendSchema at registration", () => {
    expect(() =>
      server().use(websocket()).ws("/invalid-send-validation", { validateSend: true }),
    ).toThrow(/validateSend requires sendSchema/)
  })
})

describe("server-side socket controls", () => {
  test("ws.data is mutable server-side and ws.close(code, reason) closes the client", async () => {
    running = server()
      .use(websocket())
      .ws<{ n: number }>("/ctl", {
        upgrade: () => ({ n: 0 }),
        open: (ws) => {
          ws.data = { n: ws.data.n + 1 } // exercise the data setter on the Bun wrapper
          ws.send(`${ws.data.n}:${ws.readyState}`) // readyState: 1 (OPEN) on the Bun wrapper
        },
        message: (ws) => ws.close(4001, "done"),
      })
      .listen(0, { hostname: "127.0.0.1" })
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
    const app = server()
      .use(websocket())
      .ws("/chat", {
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
    const app = server()
      .use(websocket())
      .ws("/chat", {
        allowedOrigins: (o) => o?.endsWith(".trusted.com") ?? false,
        message: (ws, d) => ws.send(d),
      })
    expect((await app.resolveWebSocketUpgrade(wsReq("https://x.trusted.com"))).kind).toBe("upgrade")
    expect((await app.resolveWebSocketUpgrade(wsReq("https://x.evil.com"))).kind).toBe("reject")
  })

  test("origin check runs BEFORE upgrade() (a disallowed origin never reaches the guard)", async () => {
    let upgradeRan = false
    const app = server()
      .use(websocket())
      .ws("/chat", {
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

  test("no allowedOrigins → secure default: cross-origin browser rejected; same-origin + non-browser pass", async () => {
    const app = server()
      .use(websocket())
      .ws("/chat", { message: (ws, d) => ws.send(d) })
    // Cross-origin browser handshake (Origin present, different host) → rejected (CSWSH default).
    expect((await app.resolveWebSocketUpgrade(wsReq("https://anywhere.com"))).kind).toBe("reject")
    // Same-origin browser handshake (Origin host === request host "t") → allowed.
    expect((await app.resolveWebSocketUpgrade(wsReq("http://t"))).kind).toBe("upgrade")
    // Non-browser client (no Origin header) → allowed (CSWSH is browser-only).
    expect((await app.resolveWebSocketUpgrade(wsReq())).kind).toBe("upgrade")
  })
})
