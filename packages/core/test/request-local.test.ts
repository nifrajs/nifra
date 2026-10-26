import { describe, expect, test } from "bun:test"
import { carryToCopy } from "../src/server/request-local.ts"
import {
  carryRequestLocals,
  requestLocal,
  server,
  type WebSocketUpgradeOutcome,
} from "../src/server.ts"

describe("requestLocal", () => {
  test("a value set before mount() is read in the child app after the prefix strip", async () => {
    const id = requestLocal<string>()
    let outer: Request | undefined
    const child = server().get("/a", (c) => ({ id: id.get(c.req) ?? null, same: c.req === outer }))
    const app = server()
      .onRequest((req) => {
        outer = req
        id.set(req, "r-1")
      })
      .mount({ path: "/child", app: child, stripPrefix: true })
    const body = await (await app.fetch(new Request("http://x/child/a"))).json()
    expect(body).toEqual({ id: "r-1", same: false })
  })

  test("a value the child sets is read through the parent's request", async () => {
    const decision = requestLocal<string>()
    const seen: (string | undefined)[] = []
    const child = server().get("/a", (c) => {
      decision.set(c.req, "allowed")
      return "ok"
    })
    const app = server()
      .onResponse((res, req) => {
        seen.push(decision.get(req))
        return res
      })
      .mount({ path: "/child", app: child, stripPrefix: true })
    expect((await app.fetch(new Request("http://x/child/a"))).status).toBe(200)
    expect(seen).toEqual(["allowed"])
  })

  test("a mount's WebSocket pass, reused for HTTP, reads a value set after the pass", async () => {
    const id = requestLocal<string>()
    let passed: Request | undefined
    const app = server().mount({
      path: "/ws",
      stripPrefix: true,
      app: {
        resolveWebSocketUpgrade: (request: Request): WebSocketUpgradeOutcome => {
          passed = request
          return { kind: "pass" }
        },
        fetch: (request: Request) =>
          Response.json({ id: id.get(request) ?? null, reused: request === passed }),
      },
    })
    const request = new Request("http://x/ws/a", { headers: { upgrade: "websocket" } })
    expect((await app.resolveWebSocketUpgrade(request)).kind).toBe("pass")
    id.set(request, "after-pass")
    expect(await (await app.fetch(request)).json()).toEqual({ id: "after-pass", reused: true })
  })

  test("a request whose target is resolved keeps the values set before fetch", async () => {
    // A target as a client sent it, the way Deno, or Bun with no Host, hands one over.
    class RawTarget extends Request {
      override get url(): string {
        return "/a/../b"
      }
    }
    const id = requestLocal<string>()
    const app = server().get("/b", (c) => ({
      id: id.get(c.req) ?? null,
      path: new URL(c.req.url).pathname,
    }))
    const raw = new RawTarget("http://localhost/a/../b")
    id.set(raw, "raw")
    expect(await (await app.fetch(raw)).json()).toEqual({ id: "raw", path: "/b" })
  })

  test("a request an onRequest hook rebuilds reads the values once the hook carries them", async () => {
    const id = requestLocal<string>()
    const app = (carry: boolean) =>
      server()
        .onRequest((req) => {
          id.set(req, "first")
        })
        .onRequest((req) => {
          const rebuilt = new Request(req.url.replace("/old", "/new"), req)
          if (carry) carryRequestLocals(req, rebuilt)
          return rebuilt
        })
        .get("/new", (c) => ({ id: id.get(c.req) ?? null }))
    const read = async (carry: boolean) =>
      (await app(carry).fetch(new Request("http://x/old"))).json()
    expect([await read(true), await read(false)]).toEqual([{ id: "first" }, { id: null }])
  })

  test("a copy made without carryRequestLocals reads nothing; with it, both share one scope", () => {
    const id = requestLocal<string>()
    const original = new Request("http://x/a")
    id.set(original, "v")
    const plain = new Request("http://x/b", original)
    expect([id.get(plain), id.has(plain)]).toEqual([undefined, false])
    const carried = new Request("http://x/b", original)
    carryRequestLocals(original, carried)
    expect(id.get(carried)).toBe("v")
    id.set(carried, "w")
    expect(id.get(original)).toBe("w")
    expect(id.delete(original)).toBe(true)
    expect([id.has(carried), id.delete(carried)]).toEqual([false, false])
  })

  test("carrying into a request that already holds values keeps the ones the scope lacks", () => {
    const a = requestLocal<string>()
    const b = requestLocal<string>()
    const from = new Request("http://x/")
    const to = new Request("http://x/")
    a.set(from, "from-a")
    a.set(to, "to-a")
    b.set(to, "to-b")
    carryRequestLocals(from, to)
    expect([a.get(to), b.get(to), a.get(from), b.get(from)]).toEqual([
      "from-a",
      "to-b",
      "from-a",
      "to-b",
    ])
    // Carrying again, or the other way round, changes nothing; neither does a third member.
    carryRequestLocals(to, from)
    const third = new Request("http://x/")
    carryRequestLocals(to, third)
    expect([a.get(third), b.get(third)]).toEqual(["from-a", "to-b"])
  })

  test("two slots never see each other's values", () => {
    const first = requestLocal<number>()
    const second = requestLocal<number>()
    const req = new Request("http://x/")
    first.set(req, 1)
    expect([first.get(req), second.get(req), second.has(req)]).toEqual([1, undefined, false])
  })

  test("a copy records nothing until a first slot makes the table", () => {
    const LINKS = Symbol.for("nifra.requestLocals")
    const saved = Object.getOwnPropertyDescriptor(globalThis, LINKS)
    Reflect.deleteProperty(globalThis, LINKS)
    try {
      const from = new Request("http://x/")
      carryToCopy(from, new Request("http://x/a", from))
      carryRequestLocals(from, new Request("http://x/b", from))
      expect(Reflect.get(globalThis, LINKS)).toBeUndefined()
      const id = requestLocal<string>()
      expect(Reflect.get(globalThis, LINKS)).toBeInstanceOf(WeakMap)
      const copy = new Request("http://x/c", from)
      carryToCopy(from, copy)
      id.set(copy, "v")
      expect(id.get(from)).toBe("v")
    } finally {
      if (saved === undefined) Reflect.deleteProperty(globalThis, LINKS)
      else Object.defineProperty(globalThis, LINKS, saved)
    }
  })

  test("concurrent requests through a mount never read each other's values", async () => {
    const id = requestLocal<string>()
    // Each handler waits until all three are in flight, so every value is set before any is read again.
    let arrived = 0
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const child = server().get("/a", async (c) => {
      const before = id.get(c.req) ?? null
      if (++arrived === 3) release()
      await barrier
      return { before, after: id.get(c.req) ?? null, sent: c.req.headers.get("x-id") }
    })
    const app = server()
      .onRequest((req) => {
        id.set(req, req.headers.get("x-id") ?? "")
      })
      .mount({ path: "/child", app: child, stripPrefix: true })
    const send = (value: string) =>
      app.fetch(new Request("http://x/child/a", { headers: { "x-id": value } }))
    const bodies = await Promise.all(
      ["one", "two", "three"].map(async (value) => (await send(value)).json()),
    )
    expect(bodies).toEqual(
      ["one", "two", "three"].map((value) => ({ before: value, after: value, sent: value })),
    )
  })
})
