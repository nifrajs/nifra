import { expect, test } from "bun:test"
import { inProcessClient } from "@nifrajs/client"
import { NIFRA_BACKEND_MOUNT } from "@nifrajs/core/mount"
import { server } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws"
import { cors } from "../../middleware/src/index.ts"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const stub: RenderAdapter = {
  renderToStream: () => streamOf("<p>page</p>"),
  hydrationHead: () => "",
}

const manifest = (): Manifest => ({
  routes: [
    {
      id: "index",
      pattern: "/",
      layoutIds: [],
      file: "index.tsx",
      load: async () => ({ default: "home" }),
    },
  ],
  layouts: {},
  notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
})

/** A backend that reports the path it actually received. */
const echoBackend = () => ({
  [NIFRA_BACKEND_MOUNT]: (request: Request) =>
    Promise.resolve(Response.json({ saw: new URL(request.url).pathname })),
})

const pathSeenBy = async (app: { fetch(r: Request): Response | Promise<Response> }, path: string) =>
  ((await (await app.fetch(new Request(`http://x${path}`))).json()) as { saw: string }).saw

test("apiStrip removes the mount prefix so a standalone-shaped backend matches", async () => {
  // Default: the backend sees the FULL path, which is right when it only ever mounts here.
  const full = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    api: echoBackend(),
  })
  expect(await pathSeenBy(full, "/api/v1/forms")).toBe("/api/v1/forms")

  // A backend that also runs standalone declares routes WITHOUT the prefix. Without this option every
  // request 404s inside it, and the workaround is a Proxy rewriting each URL - which two apps wrote
  // independently.
  const stripped = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    api: echoBackend(),
    apiStrip: true,
  })
  expect(await pathSeenBy(stripped, "/api/v1/forms")).toBe("/v1/forms")
  // The prefix on its own becomes "/", not "".
  expect(await pathSeenBy(stripped, "/api")).toBe("/")
})

test("apiStrip preserves method, headers and body", async () => {
  const seen: { method?: string; auth?: string | null; body?: string } = {}
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    apiStrip: true,
    api: {
      [NIFRA_BACKEND_MOUNT]: async (request: Request) => {
        seen.method = request.method
        seen.auth = request.headers.get("authorization")
        seen.body = await request.text()
        return Response.json({ ok: true })
      },
    },
  })
  await app.fetch(
    new Request("http://x/api/sync", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: '{"a":1}',
    }),
  )
  expect(seen).toEqual({ method: "POST", auth: "Bearer t", body: '{"a":1}' })
})

test("a mount wins over the api prefix regardless of declaration order", async () => {
  // better-auth is not a `backend` route - the starter registers it on stack.routes. Without a mount
  // the browser's /api/auth/* hits the backend and 404s silently.
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    api: echoBackend(),
    mounts: [{ path: "/api/auth", app: { fetch: () => Response.json({ from: "auth" }) } }],
  })
  expect(await (await app.fetch(new Request("http://x/api/auth/session"))).json()).toEqual({
    from: "auth",
  })
  // Anything else under /api still reaches the backend.
  expect(await pathSeenBy(app, "/api/v1/forms")).toBe("/api/v1/forms")
})

test("mounts are matched longest-path-first, not in declaration order", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    mounts: [
      // Broad one FIRST - a declaration-order implementation would let it swallow the specific one.
      { path: "/api", app: { fetch: () => Response.json({ from: "broad" }) } },
      { path: "/api/auth", app: { fetch: () => Response.json({ from: "specific" }) } },
    ],
  })
  expect(await (await app.fetch(new Request("http://x/api/auth/x"))).json()).toEqual({
    from: "specific",
  })
  expect(await (await app.fetch(new Request("http://x/api/other"))).json()).toEqual({
    from: "broad",
  })
})

test("a mount only matches its own subtree, and pages still route", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    mounts: [{ path: "/api", app: { fetch: () => Response.json({ from: "mount" }) } }],
  })
  // `/apixyz` shares the prefix as a string head but is NOT under it.
  expect((await app.fetch(new Request("http://x/apixyz"))).status).toBe(404)
  expect(await (await app.fetch(new Request("http://x/"))).text()).toContain("page")
})

test("stripPrefix on a mount rewrites the path the sub-app sees", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    mounts: [
      {
        path: "/webhooks",
        stripPrefix: true,
        app: { fetch: (r: Request) => Response.json({ saw: new URL(r.url).pathname }) },
      },
    ],
  })
  expect(await pathSeenBy(app, "/webhooks/stripe")).toEqual("/stripe")
})

test("createWebApp composes the backend WebSocket mount with the request path", async () => {
  const backend = server()
    .use(websocket())
    .ws<{ path: string }>("/api/echo", {
      upgrade: (c) => ({ path: new URL(c.req.url).pathname }),
      open: (ws) => ws.send(ws.data.path),
    })
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    api: inProcessClient(backend),
  })

  const outcome = await app.resolveWebSocketUpgrade(
    new Request("http://x/api/echo", { headers: { upgrade: "websocket" } }),
  )
  expect(outcome.kind).toBe("upgrade")
  if (outcome.kind !== "upgrade") return
  expect(outcome.data).toEqual({ path: "/api/echo" })

  const running = app.listen(0)
  try {
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${running.port}/api/echo`)
      const timer = setTimeout(() => reject(new Error("WebSocket mount timeout")), 4_000)
      socket.addEventListener("message", (event) => {
        clearTimeout(timer)
        socket.close()
        resolve(String(event.data))
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("WebSocket mount connection failed"))
      })
    })
    expect(message).toBe("/api/echo")
  } finally {
    running.stop(true)
  }

  const standaloneBackend = server()
    .use(websocket())
    .ws<{ path: string }>("/echo", {
      upgrade: (c) => ({ path: new URL(c.req.url).pathname }),
    })
  const stripped = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    api: inProcessClient(standaloneBackend),
    apiStrip: true,
  })
  const strippedOutcome = await stripped.resolveWebSocketUpgrade(
    new Request("http://x/api/echo", { headers: { upgrade: "websocket" } }),
  )
  expect(strippedOutcome.kind).toBe("upgrade")
  if (strippedOutcome.kind !== "upgrade") return
  expect(strippedOutcome.data).toEqual({ path: "/echo" })
})

test("a mounted CORS middleware answers preflight before the page router", async () => {
  const api = server()
    .use(cors({ origin: "https://client.example" }))
    .post("/api/data", () => ({ ok: true }))
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    mounts: [{ path: "/api", app: api }],
  })

  const response = await app.fetch(
    new Request("http://x/api/data", {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    }),
  )
  expect(response.status).toBe(204)
  expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example")
  expect(response.headers.get("access-control-allow-methods")).toContain("POST")
  expect(response.headers.get("access-control-allow-headers")).toBe("content-type")
})

test("createWebApp preserves parent/child hook order around a mounted response", async () => {
  const order: string[] = []
  const child = server()
    .onRequest(() => {
      order.push("child-request")
    })
    .onResponse((response) => {
      order.push("child-response")
      return response
    })
    .get("/api/health", () => ({ ok: true }))
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    use: (parent) => {
      parent.onRequest(() => {
        order.push("parent-request")
      })
      parent.onResponse((response) => {
        order.push("parent-response")
        return response
      })
    },
    mounts: [{ path: "/api", app: child }],
  })

  const response = await app.fetch(new Request("http://x/api/health"))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(order).toEqual(["parent-request", "child-request", "child-response", "parent-response"])
})

test("createWebApp honors mount priority and safe GET 404 fallthrough", async () => {
  const seen: string[] = []
  const app = createWebApp({
    adapter: stub,
    manifest: manifest(),
    clientEntry: "/c.js",
    mounts: [
      {
        path: "/api",
        priority: 10,
        fallbackOn: 404,
        app: {
          fetch: () => {
            seen.push("high")
            return new Response("high", { status: 404 })
          },
        },
      },
      {
        path: "/api",
        priority: 0,
        fallbackOn: 404,
        app: {
          fetch: () => {
            seen.push("middle")
            return new Response("middle", { status: 404 })
          },
        },
      },
      {
        path: "/api",
        priority: -1,
        app: {
          fetch: () => {
            seen.push("fallback")
            return new Response("fallback")
          },
        },
      },
    ],
  })

  const response = await app.fetch(new Request("http://x/api/health"))
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("fallback")
  expect(seen).toEqual(["high", "middle", "fallback"])
})
