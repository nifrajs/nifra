import { afterEach, describe, expect, test } from "bun:test"
import { type RunningServer, server } from "../src/index.ts"
import { websocket } from "../src/ws.ts"

/**
 * An app with WebSocket routes keeps Bun's route table for the HTTP routes no handshake can reach.
 * A handshake is a GET the dispatcher gives to the socket route first, so a GET route a request may
 * share with a socket route stays with the dispatcher; every other route is served from the table.
 */

type NativeHandler = () => Response
type NativeTable = Record<string, Record<string, NativeHandler>> | undefined

function nativeKeys(app: object): string[] {
  const portable: NativeHandler = () => new Response(null)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the table builder is private; the test lists what it holds.
  const builder = app as {
    buildBunNativeRoutes(
      fallback: NativeHandler,
      peer: object,
      platformFor: () => object,
    ): NativeTable
  }
  const table = builder.buildBunNativeRoutes(portable, {}, () => ({})) ?? {}
  return Object.keys(table)
    .flatMap((path) =>
      Object.keys(table[path]!)
        .filter((method) => table[path]![method] !== portable)
        .map((method) => `${method} ${path}`),
    )
    .sort()
}

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

function listening(app: {
  listen(port: number, options: { readonly hostname: string }): RunningServer
}): string {
  const instance = app.listen(0, { hostname: "127.0.0.1" })
  running = instance
  return `127.0.0.1:${instance.port}`
}

function echoed(url: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.onopen = () => socket.send(text)
    socket.onmessage = (event) => {
      socket.close()
      resolve(String(event.data))
    }
    socket.onerror = () => reject(new Error(`no socket at ${url}`))
  })
}

const echo = { message: (ws: { send(data: string): void }, data: unknown) => ws.send(String(data)) }

describe("the route table beside WebSocket routes", () => {
  test("routes no handshake can reach stay in the table", async () => {
    const app = server()
      .use(websocket())
      .ws("/echo", echo)
      .get("/users/:id", (c) => ({ id: c.params.id }))
      .post("/users", () => ({ ok: true }))
    expect(nativeKeys(app)).toEqual(["GET /users/:id", "HEAD /users/:id", "POST /users"])
    const host = listening(app)
    expect(await (await fetch(`http://${host}/users/7`)).json()).toEqual({ id: "7" })
    expect(await (await fetch(`http://${host}/users`, { method: "POST" })).json()).toEqual({
      ok: true,
    })
    expect(await echoed(`ws://${host}/echo`, "hi")).toBe("hi")
  })

  test("a GET route on the socket's own path answers a plain request, and the handshake still upgrades", async () => {
    const app = server()
      .use(websocket())
      .ws("/chat", echo)
      .get("/chat", () => "page")
    expect(nativeKeys(app)).toEqual([])
    const host = listening(app)
    expect(await (await fetch(`http://${host}/chat`)).json()).toBe("page")
    expect(await echoed(`ws://${host}/chat`, "hi")).toBe("hi")
  })

  test("a GET route a handshake may also reach stays out, and its other methods stay in", async () => {
    const app = server()
      .use(websocket())
      .ws("/rooms/:id", echo)
      .get("/rooms/new", () => "new")
      .get("/:area/:name", (c) => c.params.area)
      .get("/files/*rest", () => "file")
      .get("/health", () => "ok")
      .post("/rooms/:id", (c) => ({ posted: c.params.id }))
    expect(nativeKeys(app)).toEqual(["GET /health", "HEAD /health", "POST /rooms/:id"])
    const host = listening(app)
    const answer = async (path: string, init?: RequestInit): Promise<unknown> =>
      (await fetch(`http://${host}${path}`, init)).json()
    expect(await answer("/rooms/new")).toBe("new")
    // The dispatcher stops at the most specific path, which holds no GET: 405, not the `:area` route.
    expect(await answer("/rooms/7")).toEqual({ ok: false, error: "method_not_allowed" })
    expect(await answer("/health")).toBe("ok")
    expect(await answer("/rooms/7", { method: "POST" })).toEqual({ posted: "7" })
    expect(await echoed(`ws://${host}/rooms/new`, "a")).toBe("a")
    expect(await echoed(`ws://${host}/rooms/7`, "b")).toBe("b")
  })

  test("a socket route with a wildcard keeps every GET route under it with the dispatcher", async () => {
    const app = server()
      .use(websocket())
      .ws("/live/*rest", echo)
      .get("/live/status", () => "status")
      .get("/other/:id", (c) => c.params.id)
    expect(nativeKeys(app)).toEqual(["GET /other/:id", "HEAD /other/:id"])
    const host = listening(app)
    expect(await (await fetch(`http://${host}/live/status`)).json()).toBe("status")
    expect(await echoed(`ws://${host}/live/anything`, "c")).toBe("c")
  })

  test("an app that mounts sockets keeps the dispatcher for everything", () => {
    const child = server().use(websocket()).ws("/echo", echo)
    const app = server()
      .use(websocket())
      .mount({ path: "/child", app: child })
      .get("/users/:id", (c) => c.params.id)
    expect(nativeKeys(app)).toEqual([])
  })
})

describe("the route table beside WebSocket routes and onRequest hooks", () => {
  test("a handshake a hook rewrites onto a socket path still upgrades", async () => {
    const app = server()
      .use(websocket())
      .onRequest((req) => {
        const url = new URL(req.url)
        return url.pathname === "/health" && req.headers.get("upgrade") === "websocket"
          ? new Request(new URL("/chat", url), req)
          : undefined
      })
      .ws("/chat", echo)
      .get("/health", () => "ok")
    expect(nativeKeys(app)).toEqual([])
    const host = listening(app)
    expect(await (await fetch(`http://${host}/health`)).json()).toBe("ok")
    expect(await echoed(`ws://${host}/health`, "hi")).toBe("hi")
  })

  test("without a hook that can rewrite, the table stays", () => {
    const app = server()
      .use(websocket())
      .ws("/chat", echo)
      .get("/health", () => "ok")
    expect(nativeKeys(app)).toEqual(["GET /health", "HEAD /health"])
  })
})

describe("the route table without WebSocket routes is unchanged", () => {
  test("an app with no socket route serves the same table", () => {
    const app = server()
      .get("/users/:id", (c) => c.params.id)
      .post("/users", () => "ok")
    expect(nativeKeys(app)).toEqual(["GET /users/:id", "HEAD /users/:id", "POST /users"])
  })
})
