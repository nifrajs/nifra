import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { createWebSocketHub } from "../src/index.ts"

// The hub Durable Object holds the connections + the app's pub/sub registry, so app.publish broadcasts
// across them. Verified here on Bun by mocking the Workers `WebSocketPair` (a real DO round-trip is
// covered by the workerd verification). Constructing a 101 Response throws off-workerd, so the upgrade
// path is asserted up to that point (accept + wire + open already ran).

function fakeServer() {
  return {
    accepted: false,
    sent: [] as unknown[],
    readyState: 1,
    binaryType: "blob",
    accept() {
      this.accepted = true
    },
    send(data: unknown) {
      this.sent.push(data)
    },
    close() {},
    // attachWebSocket registers message/close/error listeners here; the broadcast assertion drives
    // `send` directly (via app.publish → the nifra wrapper), so we don't need to fire these.
    addEventListener(_type: string, _listener: (event: never) => void) {},
  }
}

async function withMockedPair<T>(
  captured: Array<ReturnType<typeof fakeServer>>,
  run: () => Promise<T>,
): Promise<T> {
  const g = globalThis as { WebSocketPair?: unknown }
  const original = g.WebSocketPair
  g.WebSocketPair = class {
    readonly 0 = {}
    readonly 1: ReturnType<typeof fakeServer>
    constructor() {
      const s = fakeServer()
      captured.push(s)
      this[1] = s
    }
  }
  try {
    return await run()
  } finally {
    g.WebSocketPair = original
  }
}

const upgrade = (path: string) =>
  new Request(`http://do${path}`, { headers: { upgrade: "websocket" } })

describe("createWebSocketHub", () => {
  test("accepts upgrades, runs open(), and app.publish broadcasts to every hub connection", async () => {
    const app = server()
      .use(websocket())
      .ws("/room", { open: (ws) => ws.subscribe("lobby") })
    const Hub = createWebSocketHub(app)
    const hub = new Hub({}, {})
    const servers: Array<ReturnType<typeof fakeServer>> = []
    for (let i = 0; i < 2; i++) {
      await withMockedPair(servers, async () => {
        try {
          await hub.fetch(upgrade("/room"))
        } catch {
          // `new Response(null, { status: 101 })` throws off-workerd — accept + wire + open already ran.
        }
      })
    }
    expect(servers.length).toBe(2)
    expect(servers.every((s) => s.accepted)).toBe(true)
    app.publish("lobby", "hello")
    expect(servers.map((s) => s.sent)).toEqual([["hello"], ["hello"]])
  })

  test("a rejected upgrade returns the guard's Response (no socket created)", async () => {
    const app = server()
      .use(websocket())
      .ws("/g", { upgrade: () => new Response("denied", { status: 403 }) })
    const hub = new (createWebSocketHub(app))({}, {})
    const res = await hub.fetch(upgrade("/g"))
    expect(res.status).toBe(403)
  })

  test("an upgrade to a non-WS path returns 426", async () => {
    const app = server()
      .use(websocket())
      .ws("/room", { open: () => {} })
    const hub = new (createWebSocketHub(app))({}, {})
    expect((await hub.fetch(upgrade("/no-such-route"))).status).toBe(426)
  })

  test("the upgrade guard's c.waitUntil is forwarded to the DO state", async () => {
    const waited: Array<Promise<unknown>> = []
    const app = server()
      .use(websocket())
      .ws("/w", {
        upgrade: (c) => {
          c.waitUntil(Promise.resolve("bg"))
          return {}
        },
      })
    const hub = new (createWebSocketHub(app))(
      { waitUntil: (p: Promise<unknown>) => void waited.push(p) },
      {},
    )
    const servers: Array<ReturnType<typeof fakeServer>> = []
    await withMockedPair(servers, async () => {
      try {
        await hub.fetch(upgrade("/w"))
      } catch {
        // 101 Response throws off-workerd — the guard (and its waitUntil) already ran.
      }
    })
    expect(waited.length).toBe(1)
  })

  test("returns 500 when WebSocketPair is unavailable (not a Workers runtime)", async () => {
    const app = server()
      .use(websocket())
      .ws("/x", { open: () => {} })
    const hub = new (createWebSocketHub(app))({}, {})
    // No WebSocketPair mock here — it's undefined under Bun, exercising the not-a-Workers guard.
    expect((await hub.fetch(upgrade("/x"))).status).toBe(500)
  })
})
