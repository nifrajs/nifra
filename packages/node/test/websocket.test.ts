import { afterEach, describe, expect, test } from "bun:test"
import { server, status } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { rawUpgradeStatus } from "../../core/test/request-target-matrix.ts"
import {
  closeArgsAnswers,
  closeArgsRoute,
  FORBIDDEN_CLOSES,
} from "../../core/test/ws-close-args.ts"
import { firstContractFrame, sendContractApp } from "../../core/test/ws-send-contract.ts"
import { type NodeServer, serve } from "../src/index.ts"
import { PUBLISHED, publishFeedApp, publishRoundTrip } from "./ws-publish-fixture.ts"

// @nifrajs/node serves WebSockets via the optional `ws` package (a devDependency here). These run on the
// node:http server `serve()` builds, exercised under Bun's node:http compat + a real WebSocket client.

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 50 })
  running = undefined
})

function makeApp() {
  return server()
    .use(websocket())
    .ws("/echo", {
      open: (ws) => ws.send("welcome"),
      message: (ws, data) => ws.send(data),
    })
    .ws<{ token: string }>("/guarded", {
      upgrade: (c) => {
        const token = new URL(c.req.url).searchParams.get("token")
        return token === "secret" ? { token } : new Response("no", { status: 401 })
      },
      open: (ws) => ws.send(`hi ${ws.data.token}`),
    })
    .get("/health", () => ({ ok: true }))
}

function rt(url: string, send: string[], count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const got: string[] = []
    const c = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error("timeout")), 4000)
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

/** Send one text frame and report the echo, or the close code when the server closes instead. */
function echoOrClose(url: string, message: string): Promise<{ echo: string } | { close: number }> {
  return new Promise((resolve, reject) => {
    const c = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error("timeout")), 4000)
    c.addEventListener("open", () => c.send(message))
    c.addEventListener("message", (e) => {
      clearTimeout(timer)
      c.close()
      resolve({ echo: String(e.data) })
    })
    c.addEventListener("close", (e) => {
      clearTimeout(timer)
      resolve({ close: e.code })
    })
  })
}

describe("@nifrajs/node WebSocket payload caps", () => {
  const echo = (cap: number) =>
    server({ wsMaxPayloadBytes: cap })
      .use(websocket())
      .ws("/", { message: (ws, data) => ws.send(data) })

  test("each mounted child keeps its own cap, whichever upgrades first", async () => {
    const app = server()
      .mount({ path: "/small", app: echo(4), stripPrefix: true })
      .mount({ path: "/large", app: echo(64), stripPrefix: true })
    for (const order of [
      ["/large", "/small"],
      ["/small", "/large"],
    ]) {
      running = await serve(app, { hostname: "127.0.0.1", port: 0 })
      const base = `ws://127.0.0.1:${running.port}`
      const results = []
      for (const path of order)
        results.push([path, await echoOrClose(`${base}${path}`, "x".repeat(16))])
      expect(Object.fromEntries(results)).toEqual({
        "/small": { close: 1009 },
        "/large": { echo: "x".repeat(16) },
      })
      await running.stop({ drainMs: 50 })
      running = undefined
    }
  })

  test("a close RFC 6455 forbids throws a RangeError and leaves the socket open", async () => {
    running = await serve(closeArgsRoute(server().use(websocket())), {
      port: 0,
      hostname: "127.0.0.1",
    })
    expect(await closeArgsAnswers(running.port)).toEqual({
      answers: FORBIDDEN_CLOSES.map(() => "range"),
      closed: { code: 4000, reason: "ok" },
    })
  })

  test("a cap of 0 refuses every non-empty message", async () => {
    running = await serve(echo(0), { hostname: "127.0.0.1", port: 0 })
    expect(await echoOrClose(`ws://127.0.0.1:${running.port}/`, "x")).toEqual({ close: 1009 })
  })
})

describe("@nifrajs/node WebSockets", () => {
  test("stop() closes an open WebSocket with 1001 instead of leaving it serving", async () => {
    running = await serve(makeApp(), { hostname: "127.0.0.1", port: 0 })
    const c = new WebSocket(`ws://127.0.0.1:${running.port}/echo`)
    const closed = new Promise<number>((resolve) =>
      c.addEventListener("close", (e) => resolve(e.code)),
    )
    await new Promise((resolve) => c.addEventListener("message", resolve, { once: true }))
    await running.stop({ drainMs: 2000 })
    running = undefined
    expect(await closed).toBe(1001)
    expect(c.readyState).toBe(WebSocket.CLOSED)
  })

  test("a frame the route's sendSchema refuses never leaves, as on Bun", async () => {
    const contract = sendContractApp(server().use(websocket()))
    running = await serve(contract.app, { port: 0, hostname: "127.0.0.1" })
    expect(await firstContractFrame(running.port)).toBe(JSON.stringify({ ok: true }))
    expect(contract.errors).toHaveLength(1)
  })

  test("a publish frames each text once and every subscriber reads it byte for byte, in order", async () => {
    const feed = publishFeedApp(server().use(websocket()))
    running = await serve(feed.app, { hostname: "127.0.0.1", port: 0 })
    // Bun swaps `ws` for its own stand-in, which reads the 0 its native send returns for an empty
    // frame as "dropped" and sends it again on every `drain` (Windows' loopback buffer drains mid-run).
    // The empty frame runs on Node, in test-node.
    const texts = PUBLISHED.filter((text) => text !== "")
    const { got, expected } = await publishRoundTrip(feed, running.port, texts)
    expect(got).toEqual(expected)
  })

  test("echo: open → welcome, message → echo", async () => {
    running = await serve(makeApp(), { hostname: "127.0.0.1", port: 0 })
    expect(await rt(`ws://127.0.0.1:${running.port}/echo`, ["hi"], 2)).toEqual(["welcome", "hi"])
  })

  test("a mounted child WebSocket keeps its path and handler context", async () => {
    const child = server()
      .use(websocket())
      .ws("/echo", {
        open: (ws) => ws.send("child-ready"),
        message: (ws, data) => ws.send(data),
      })
    const parent = server().mount({ path: "/api", app: child, stripPrefix: true })
    running = await serve(parent, { hostname: "127.0.0.1", port: 0 })
    expect(await rt(`ws://127.0.0.1:${running.port}/api/echo`, ["child-ping"], 2)).toEqual([
      "child-ready",
      "child-ping",
    ])
  })

  test("a handshake target with dot segments upgrades on the path it resolves to", async () => {
    running = await serve(makeApp(), { port: 0, hostname: "127.0.0.1" })
    expect(await rawUpgradeStatus(running.port, "/rooms/../echo")).toBe(101)
    expect(await rawUpgradeStatus(running.port, "/rooms/%2e%2e/echo")).toBe(101)
  })

  test("guarded: accepts with token, threading data to ws.data", async () => {
    running = await serve(makeApp(), { hostname: "127.0.0.1", port: 0 })
    expect(await rt(`ws://127.0.0.1:${running.port}/guarded?token=secret`, [], 1)).toEqual([
      "hi secret",
    ])
  })

  test("guarded: rejects without token (never opens)", async () => {
    running = await serve(makeApp(), { hostname: "127.0.0.1", port: 0 })
    const outcome = await new Promise<string>((resolve) => {
      const c = new WebSocket(`ws://127.0.0.1:${running?.port}/guarded`)
      let opened = false
      const timer = setTimeout(() => resolve(opened ? "opened" : "rejected"), 900)
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

  test("binary frames round-trip (Uint8Array normalization)", async () => {
    running = await serve(makeApp(), { hostname: "127.0.0.1", port: 0 })
    const port = running.port
    const ok = await new Promise<boolean>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/echo`)
      c.binaryType = "arraybuffer"
      const timer = setTimeout(() => reject(new Error("timeout")), 4000)
      let welcomed = false
      c.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          welcomed = true
          c.send(new Uint8Array([7, 8, 9]))
          return
        }
        const bytes = new Uint8Array(e.data as ArrayBuffer)
        clearTimeout(timer)
        c.close()
        resolve(welcomed && bytes.length === 3 && bytes[0] === 7 && bytes[2] === 9)
      })
      c.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("ws error"))
      })
    })
    expect(ok).toBe(true)
  })

  test("a normal HTTP route works alongside WS routes", async () => {
    running = await serve(makeApp(), { hostname: "127.0.0.1", port: 0 })
    const res = await fetch(`http://127.0.0.1:${running.port}/health`)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("ws.readyState + ws.close() proxy to the socket", async () => {
    running = await serve(
      server()
        .use(websocket())
        .ws("/c", {
          open: (ws) => {
            ws.send(`state:${ws.readyState}`)
            ws.close(1000, "done")
          },
        }),
      { hostname: "127.0.0.1", port: 0 },
    )
    const result = await new Promise<{ msg: string; code: number }>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${running?.port}/c`)
      let msg = ""
      const timer = setTimeout(() => reject(new Error("timeout")), 4000)
      c.addEventListener("message", (e) => {
        msg = String(e.data)
      })
      c.addEventListener("close", (e) => {
        clearTimeout(timer)
        resolve({ msg, code: e.code })
      })
      c.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("ws error"))
      })
    })
    expect(result.msg).toBe("state:1")
    expect(result.code).toBe(1000)
  })

  test("a throwing open handler is routed to error()", async () => {
    running = await serve(
      server()
        .use(websocket())
        .ws("/e", {
          open: () => {
            throw new Error("boom")
          },
          error: (ws) => ws.send("errored"),
        }),
      { hostname: "127.0.0.1", port: 0 },
    )
    expect(await rt(`ws://127.0.0.1:${running.port}/e`, [], 1)).toEqual(["errored"])
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
    running = await serve(app, { hostname: "127.0.0.1", port: 0 })
    const url = `ws://127.0.0.1:${running.port}/room`
    const a = new WebSocket(url)
    const b = new WebSocket(url)
    const aMsgs: string[] = []
    const bMsgs: string[] = []
    a.addEventListener("message", (e) => aMsgs.push(String(e.data)))
    b.addEventListener("message", (e) => bMsgs.push(String(e.data)))
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
    b.send("leave")
    await Bun.sleep(50)
    app.publish("lobby", "m2")
    await waitFor(() => aMsgs.length === 2)
    expect(aMsgs).toEqual(["m1", "m2"])
    expect(bMsgs).toEqual(["m1"])
    a.close()
    b.close()
    // Real runtime is ~1s; the generous timeout is headroom against full-suite scheduling contention
    // (this real-socket pub/sub test occasionally exceeded the default 5s under parallel load).
  }, 15000)

  test("an upgrade naming a host outside allowedHosts is refused before any route runs", async () => {
    running = await serve(makeApp(), {
      hostname: "127.0.0.1",
      port: 0,
      allowedHosts: ["app.example.test"],
    })
    expect(await rawUpgradeStatus(running.port, "/echo")).toBe(400)
  })

  test("an upgrade to a path with no WS route is rejected (404, never opens)", async () => {
    running = await serve(makeApp(), { hostname: "127.0.0.1", port: 0 })
    const outcome = await new Promise<string>((resolve) => {
      const c = new WebSocket(`ws://127.0.0.1:${running?.port}/no-such-ws`)
      let opened = false
      const timer = setTimeout(() => resolve(opened ? "opened" : "rejected"), 900)
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
})

describe("@nifrajs/node: the handshake runs the route chain", () => {
  test("a socket registered after a guard answers a handshake without credentials with 401", async () => {
    const app = server()
      .use(websocket())
      .beforeHandle((c) =>
        c.req.headers.get("authorization") === "Bearer good"
          ? undefined
          : status(401, { error: "no" }),
      )
      .ws("/socket", {})
    running = await serve(app, { hostname: "127.0.0.1", port: 0 })
    expect(await rawUpgradeStatus(running.port, "/socket")).toBe(401)
    expect(await rawUpgradeStatus(running.port, "/socket", { authorization: "Bearer good" })).toBe(
      101,
    )
  })
})
