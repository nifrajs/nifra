import { afterEach, describe, expect, test } from "bun:test"
import type { RunningServer } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { streaming } from "@nifrajs/core/sse"
import { websocket } from "@nifrajs/core/ws"
import { t } from "@nifrajs/schema"
import { client, testClient } from "../src/index.ts"
import { hasDotSegment } from "../src/sendable-path.ts"

// A `.` or `..` path segment never reaches the server as written: URL parsing drops it, in every
// spelling, so `/users/../posts` is a request for `/posts`. The client refuses such a call rather
// than send it to a route the call does not name.

const hits: string[] = []

const app = server()
  .use(streaming())
  .use(websocket())
  .get("/", () => ({ route: "root" }))
  .delete("/", () => {
    hits.push("DELETE /")
    return { route: "delete-root" }
  })
  .get("/posts", () => ({ route: "all-posts" }))
  .get("/users/:id", (c) => ({ route: "user", id: c.params.id }))
  .delete("/users/:id", (c) => {
    hits.push(`DELETE /users/${c.params.id}`)
    return { route: "delete-user", id: c.params.id }
  })
  .get("/users/:id/posts", (c) => ({ route: "user-posts", id: c.params.id }))
  .get("/.well-known/:name", (c) => ({ route: "well-known", name: c.params.name }))
  .get("/files/*", (c) => ({ route: "files", rest: c.params["*"] }))
  .sse("/rooms/:id/feed", { sse: t.object({ n: t.integer() }) }, (_c, stream) => {
    hits.push("SSE feed")
    stream.send({ n: 1 })
    stream.close()
  })
  .sse("/feed", { sse: t.object({ n: t.integer() }) }, (_c, stream) => {
    hits.push("SSE /feed")
    stream.send({ n: 1 })
    stream.close()
  })
  .ws("/rooms/:id/chat", { message() {} })

const REFUSED = { ok: false, status: 0, data: null, error: { error: "invalid_path" } } as const

let running: RunningServer | undefined
const NativeWebSocket = globalThis.WebSocket

afterEach(async () => {
  hits.length = 0
  globalThis.WebSocket = NativeWebSocket
  await running?.stop()
  running = undefined
})

describe("hasDotSegment", () => {
  test.each([
    "/..",
    "/.",
    "/users/..",
    "/users/../posts",
    "/users/./posts",
    "/users/%2e%2e/posts",
    "/users/%2E%2E",
    "/users/.%2e",
    "/users/%2E.",
    "/users/%2e",
    "/a\\..\\b",
    "/a/..\\b",
  ])("refuses %s", (path) => {
    expect(hasDotSegment(path)).toBe(true)
  })

  test.each([
    "",
    "/",
    "/users/42",
    "/users/...",
    "/users/..a",
    "/users/a..",
    "/users/a.b",
    "/.well-known/x",
    "/files/report.json",
    "/users/%252e%252e",
    "/files/a%2F..%2Fb",
    "/users/%2e%2e%2e",
    "/v1.2",
  ])("sends %s", (path) => {
    expect(hasDotSegment(path)).toBe(false)
  })
})

describe("a `.` or `..` param value is refused, not sent to another route", () => {
  const api = testClient<typeof app>(app)

  test.each(["..", "."])("GET with id %p", async (id) => {
    expect(await api.users({ id }).get()).toEqual(REFUSED)
    expect(await api.users({ id }).posts.get()).toEqual(REFUSED)
  })

  test.each(["..", "."])("DELETE with id %p runs no handler", async (id) => {
    expect(await api.users({ id }).delete()).toEqual(REFUSED)
    expect(hits).toEqual([])
  })

  test("over the network too", async () => {
    running = app.listen(0)
    const remote = client<typeof app>(`http://127.0.0.1:${running.port}`)
    expect(await remote.users({ id: ".." }).delete()).toEqual(REFUSED)
    expect(await remote.users({ id: ".." }).posts.get()).toEqual(REFUSED)
    expect(hits).toEqual([])
    const ok = await remote.users({ id: "42" }).delete()
    expect(ok.ok && ok.data).toEqual({ route: "delete-user", id: "42" })
  })

  test("nothing runs: no fetch, no onRequest hook, no retry", async () => {
    let fetches = 0
    let hooks = 0
    const guarded = client<typeof app>("http://localhost:1", {
      fetch: () => {
        fetches += 1
        return Promise.resolve(new Response("{}"))
      },
      onRequest: () => {
        hooks += 1
      },
      retry: { attempts: 3 },
    })
    expect(await guarded.users({ id: ".." }).get()).toEqual(REFUSED)
    expect(fetches).toBe(0)
    expect(hooks).toBe(0)
  })

  test("a pre-encoded spelling is sent as text, so it stays the param value", async () => {
    const res = await api.users({ id: "%2e%2e" }).get()
    expect(res.ok && res.data).toEqual({ route: "user", id: "%2e%2e" })
  })

  test("values that only contain dots elsewhere are sent", async () => {
    for (const id of ["...", "..a", "a..", "a.b", ".hidden"]) {
      const res = await api.users({ id }).get()
      expect(res.ok && res.data).toEqual({ route: "user", id })
    }
  })

  test("a static segment that starts with a dot is sent", async () => {
    const res = await api[".well-known"]({ name: "security.txt" }).get()
    expect(res.ok && res.data).toEqual({ route: "well-known", name: "security.txt" })
  })

  test("a wildcard value keeps its dots: it is one encoded segment", async () => {
    const res = await api.files({ "*": "a/../b" }).get()
    expect(res.ok && res.data).toEqual({ route: "files", rest: "a/../b" })
  })

  test("a wildcard value that is only `..` is refused", async () => {
    expect(await api.files({ "*": ".." }).get()).toEqual(REFUSED)
  })
})

describe("subscribe()", () => {
  const api = testClient<typeof app>(app)

  test("reports invalid_path through onError, closes once, opens no stream", async () => {
    const errors: unknown[] = []
    let closes = 0
    const events: unknown[] = []
    const subscription = api.rooms({ id: ".." }).feed.subscribe((event) => events.push(event), {
      onError: (error) => {
        errors.push(error)
        // The handler may use the subscription it was given.
        subscription.close()
      },
      onClose: () => {
        closes += 1
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("invalid_path")
    expect(closes).toBe(1)
    expect(events).toEqual([])
    expect(hits).toEqual([])
  })

  test("a subscription closed before it starts reports nothing", async () => {
    const errors: unknown[] = []
    const subscription = api
      .rooms({ id: ".." })
      .feed.subscribe(() => {}, { onError: (error) => errors.push(error) })
    subscription.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(errors).toEqual([])
  })
})

describe("ws()", () => {
  test("throws before a socket is constructed", () => {
    let constructed = 0
    globalThis.WebSocket = class {
      constructor() {
        constructed += 1
      }
    } as unknown as typeof WebSocket
    const remote = client<typeof app>("http://127.0.0.1:1")
    expect(() => remote.rooms({ id: ".." }).chat.ws()).toThrow(/"\." or "\.\." segment/)
    expect(constructed).toBe(0)
  })
})
