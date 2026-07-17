import { afterEach, describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { type NodeServer, serve } from "../src/index.ts"

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

describe("@nifrajs/node WebSockets", () => {
  test("echo: open → welcome, message → echo", async () => {
    running = await serve(makeApp(), { port: 0 })
    expect(await rt(`ws://127.0.0.1:${running.port}/echo`, ["hi"], 2)).toEqual(["welcome", "hi"])
  })

  test("guarded: accepts with token, threading data to ws.data", async () => {
    running = await serve(makeApp(), { port: 0 })
    expect(await rt(`ws://127.0.0.1:${running.port}/guarded?token=secret`, [], 1)).toEqual([
      "hi secret",
    ])
  })

  test("guarded: rejects without token (never opens)", async () => {
    running = await serve(makeApp(), { port: 0 })
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
    running = await serve(makeApp(), { port: 0 })
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
    running = await serve(makeApp(), { port: 0 })
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
      { port: 0 },
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
      { port: 0 },
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
    running = await serve(app, { port: 0 })
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

  test("an upgrade to a path with no WS route is rejected (404, never opens)", async () => {
    running = await serve(makeApp(), { port: 0 })
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
