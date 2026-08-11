/**
 * `createWebApp`'s `server` + `use` options - the two seams that let a page app reach the `Server`
 * it never constructs itself.
 *
 * The point of `use` is ORDER, so the control tests matter as much as the positive ones. Both
 * directions are pinned: a late `onResponse` DOES cover pages (app-global), a late `beforeHandle`
 * or `derive` does NOT (snapshotted per route at declaration). If the second one ever starts
 * passing, this option is redundant and should be deleted rather than kept.
 */
import { expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { NIFRA_BACKEND_MOUNT } from "@nifrajs/core/mount"
import { defineContextPlugin, type Middleware } from "@nifrajs/core/server"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

const stub: RenderAdapter = {
  renderToStream: () => streamOf("<p>page</p>"),
  hydrationHead: () => "",
}

/** One page at `/`, plus a `slow` page whose loader outlives any timeout under test. */
const manifestOf = (): Manifest => ({
  routes: [
    {
      id: "index",
      pattern: "/",
      layoutIds: [],
      file: "index.tsx",
      load: async () => ({ default: "home" }),
    },
    {
      id: "slow",
      pattern: "/slow",
      layoutIds: [],
      file: "slow.tsx",
      load: async () => ({
        default: "slow",
        loader: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5_000)),
      }),
    },
  ],
  layouts: {},
  notFound: { file: "_404.tsx", load: async () => ({ default: "not-found" }) },
})

/** Stamps a header on every response - an `onResponse` hook, the shape `securityHeaders()` uses. */
const stamp = (value: string): Middleware => ({
  name: `stamp-${value}`,
  onResponse: (response) => {
    const next = new Response(response.body, response)
    next.headers.set("x-stamp", value)
    return next
  },
})

const bridge = (app: { fetch(request: Request): Response | Promise<Response> }) => ({
  [NIFRA_BACKEND_MOUNT]: (request: Request) => Promise.resolve(app.fetch(request)),
})

test("use option covers a page route", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestOf(),
    clientEntry: "/c.js",
    use: (app) => app.use(stamp("via-option")),
  })
  const res = await app.fetch(new Request("http://x/"))
  expect(res.status).toBe(200)
  expect(res.headers.get("x-stamp")).toBe("via-option")
})

test("a LATE onResponse still covers pages - that hook is app-global, not order-scoped", async () => {
  // Pinned deliberately: `onResponse`/`onRequest` live in app-wide arrays read at request time, so
  // `app.use(securityHeaders())` after `createWebApp` does set the headers. The option is not needed
  // for these, and this test exists so nobody "fixes" a bug that isn't one.
  const app = createWebApp({ adapter: stub, manifest: manifestOf(), clientEntry: "/c.js" })
  app.use(stamp("late-but-global"))
  const res = await app.fetch(new Request("http://x/"))
  expect(res.headers.get("x-stamp")).toBe("late-but-global")
})

test("a LATE beforeHandle does NOT cover pages (why the option exists)", async () => {
  // The real order-scoped class: `beforeHandle`/`afterHandle`/`around`/`derive`/`decorate` are
  // snapshotted into each route AS IT IS DECLARED, and `createWebApp` declares every page before it
  // returns. So a guard added afterwards silently protects nothing - including `requestId()`, which
  // is a `derive`.
  let ran = 0
  const guard: Middleware = {
    name: "late-guard",
    beforeHandle: () => {
      ran += 1
    },
  }

  const late = createWebApp({ adapter: stub, manifest: manifestOf(), clientEntry: "/c.js" })
  late.use(guard)
  expect((await late.fetch(new Request("http://x/"))).status).toBe(200)
  expect(ran).toBe(0)

  const early = createWebApp({
    adapter: stub,
    manifest: manifestOf(),
    clientEntry: "/c.js",
    use: (a) => a.use(guard),
  })
  expect((await early.fetch(new Request("http://x/"))).status).toBe(200)
  expect(ran).toBe(1)
})

test("use option accepts a ContextPlugin (the requestId() shape) and its derive reaches pages", async () => {
  // The reason `use` is a callback and not a `Middleware[]`: `requestId()` is a ContextPlugin, so an
  // array of middleware objects could not have carried it at all. The derive must run for the PAGE
  // route, which is declared inside createWebApp.
  const seen: string[] = []
  const tagger = defineContextPlugin<{ tag: string }>("tagger", (app) =>
    app.derive((c) => {
      const tag = c.header("x-tag") ?? "generated"
      seen.push(tag)
      c.set.headers["x-tag"] = tag
      return { tag }
    }),
  )
  const app = createWebApp({
    adapter: stub,
    manifest: manifestOf(),
    clientEntry: "/c.js",
    use: (a) => void a.use(tagger),
  })
  const res = await app.fetch(new Request("http://x/", { headers: { "x-tag": "abc" } }))
  expect(res.status).toBe(200)
  expect(seen).toEqual(["abc"])
})

test("use option covers the 404 catch-all", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestOf(),
    clientEntry: "/c.js",
    use: (app) => app.use(stamp("via-option")),
  })
  const res = await app.fetch(new Request("http://x/nope"))
  expect(res.status).toBe(404)
  expect(res.headers.get("x-stamp")).toBe("via-option")
})

test("use option covers a mounted backend response", async () => {
  const backend = server().get("/api/ping", () => ({ pong: true }))
  const app = createWebApp({
    adapter: stub,
    manifest: manifestOf(),
    clientEntry: "/c.js",
    api: bridge(backend),
    use: (app) => app.use(stamp("via-option")),
  })
  const res = await app.fetch(new Request("http://x/api/ping"))
  expect(res.status).toBe(200)
  expect(res.headers.get("x-stamp")).toBe("via-option")
})

test("an onRequest middleware short-circuits ahead of the mount", async () => {
  let backendCalls = 0
  const backend = server().get("/api/ping", () => {
    backendCalls += 1
    return { pong: true }
  })
  const gate: Middleware = {
    name: "gate",
    onRequest: (req) =>
      req.headers.has("x-key") ? undefined : new Response("denied", { status: 401 }),
  }
  const app = createWebApp({
    adapter: stub,
    manifest: manifestOf(),
    clientEntry: "/c.js",
    api: bridge(backend),
    use: (a) => {
      a.use(gate)
      a.use(stamp("via-option"))
    },
  })

  const denied = await app.fetch(new Request("http://x/api/ping"))
  expect(denied.status).toBe(401)
  expect(backendCalls).toBe(0)
  // The short-circuit is still a response of this app, so response middleware sees it.
  expect(denied.headers.get("x-stamp")).toBe("via-option")

  const allowed = await app.fetch(new Request("http://x/api/ping", { headers: { "x-key": "k" } }))
  expect(allowed.status).toBe(200)
  expect(backendCalls).toBe(1)
})

test("server option reaches the Server constructor (requestTimeoutMs → 503)", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestOf(),
    clientEntry: "/c.js",
    server: { requestTimeoutMs: 50 },
  })
  const res = await app.fetch(new Request("http://x/slow"))
  expect(res.status).toBe(503)
}, 10_000)

test("without the server option the same slow page is not timed out", async () => {
  const app = createWebApp({ adapter: stub, manifest: manifestOf(), clientEntry: "/c.js" })
  // No timeout configured, so the request is still running after the window the test above used.
  const settled = await Promise.race([
    Promise.resolve(app.fetch(new Request("http://x/slow"))).then(() => "responded"),
    new Promise((resolve) => setTimeout(() => resolve("still-running"), 300)),
  ])
  expect(settled).toBe("still-running")
}, 10_000)
