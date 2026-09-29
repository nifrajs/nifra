import { expect, test } from "bun:test"
import { inProcessClient } from "@nifrajs/client"
import { type Platform, server } from "@nifrajs/core/server"
import { createWebApp, type Loader, type Manifest, type RenderAdapter } from "../src/index.ts"

// A loader's `ctx.api` is bound to the page request's platform: the backend it reaches sees the
// visitor's clientIp/env/waitUntil, never the page request's headers.

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

const manifestWith = (loader: Loader, action?: Loader): Manifest => ({
  routes: [
    {
      id: "index",
      pattern: "/",
      layoutIds: [],
      file: "index.tsx",
      load: async () => ({ default: "home", loader, ...(action === undefined ? {} : { action }) }),
    },
  ],
  layouts: {},
})

type Api = ReturnType<typeof inProcessClient<ReturnType<typeof backendOf>>>

const backendOf = (options?: Parameters<typeof server>[0]) =>
  server(options)
    .get("/api/ip", async (c) => {
      // Yield so concurrent renders interleave inside the backend handler.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { ip: c.clientIp ?? null }
    })
    .get("/api/headers", (c) => ({
      cookie: c.req.headers.get("cookie"),
      authorization: c.req.headers.get("authorization"),
    }))
    .get("/api/platform", (c) => {
      c.waitUntil(Promise.resolve("audit"))
      return { env: (c.env as { region?: string } | undefined)?.region ?? null }
    })
    .get("/api/plain", () => ({ ok: true }))

const dataRequest = (headers: Record<string, string> = {}): Request =>
  new Request("http://x/", { headers: { "x-nifra-data": "1", ...headers } })

const ipLoader: Loader = async (ctx) => {
  const api = ctx.api as Api
  return (await api.api.ip.get()).data
}

test("a loader call sees the visitor's clientIp derived under the page app's trust declaration", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(ipLoader),
    clientEntry: "/c.js",
    api: inProcessClient(backendOf()),
    server: { clientIp: { header: "cf-connecting-ip" } },
  })
  const response = await app.fetch(dataRequest({ "cf-connecting-ip": "203.0.113.7" }))
  expect(await response.json()).toEqual({ ip: "203.0.113.7" })
})

test("a backend with its own header trust keeps the already-derived clientIp", async () => {
  // The synthesized loader request carries no cf-connecting-ip header; re-deriving from it would
  // collapse every SSR caller into `undefined`.
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(ipLoader),
    clientEntry: "/c.js",
    api: inProcessClient(backendOf({ clientIp: { header: "cf-connecting-ip" } })),
    server: { clientIp: { header: "cf-connecting-ip" } },
  })
  const response = await app.fetch(dataRequest({ "cf-connecting-ip": "198.51.100.4" }))
  expect(await response.json()).toEqual({ ip: "198.51.100.4" })
  // The auto-mounted browser path still derives from the real request's header.
  const direct = await app.fetch(
    new Request("http://x/api/ip", { headers: { "cf-connecting-ip": "198.51.100.9" } }),
  )
  expect(await direct.json()).toEqual({ ip: "198.51.100.9" })
})

test("concurrent renders from different visitors each see their own clientIp", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(async (ctx) => {
      const api = ctx.api as Api
      await new Promise((resolve) => setTimeout(resolve, 2))
      const first = (await api.api.ip.get()).data
      const second = (await api.api.ip.get()).data
      return { first, second }
    }),
    clientEntry: "/c.js",
    api: inProcessClient(backendOf()),
    server: { clientIp: { header: "cf-connecting-ip" } },
  })
  const ips = Array.from({ length: 8 }, (_, i) => `192.0.2.${i + 1}`)
  const bodies = await Promise.all(
    ips.map(async (ip) => (await app.fetch(dataRequest({ "cf-connecting-ip": ip }))).json()),
  )
  expect(bodies).toEqual(ips.map((ip) => ({ first: { ip }, second: { ip } })))
})

test("env and waitUntil reach a backend handler called from a loader", async () => {
  const scheduled: unknown[] = []
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(async (ctx) => (await (ctx.api as Api).api.platform.get()).data),
    clientEntry: "/c.js",
    api: inProcessClient(backendOf()),
  })
  const platform: Platform = {
    env: { region: "eu" },
    waitUntil: (promise) => {
      scheduled.push(promise)
    },
  }
  const response = await app.fetch(dataRequest(), platform)
  expect(await response.json()).toEqual({ env: "eu" })
  expect(scheduled).toHaveLength(1)
  expect(await scheduled[0]).toBe("audit")
})

test("loader and action calls never carry the page request's cookie or authorization", async () => {
  const headersOf = async (ctx: Parameters<Loader>[0]) =>
    (await (ctx.api as Api).api.headers.get()).data
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(headersOf, headersOf),
    clientEntry: "/c.js",
    api: inProcessClient(backendOf()),
  })
  const secrets = { cookie: "session=abc", authorization: "Bearer page-token" }
  const loaded = await app.fetch(dataRequest(secrets))
  expect(await loaded.json()).toEqual({ cookie: null, authorization: null })
  const acted = await app.fetch(
    new Request("http://x/", { method: "POST", headers: { "x-nifra-data": "1", ...secrets } }),
  )
  expect(await acted.json()).toEqual({ cookie: null, authorization: null })
})

test("a loader call does not resolve the socket peer unless the backend reads c.clientIp", async () => {
  let peerReads = 0
  const platform: Platform = {
    get clientIp() {
      peerReads++
      return "203.0.113.50"
    },
  }
  const plain = createWebApp({
    adapter: stub,
    manifest: manifestWith(async (ctx) => (await (ctx.api as Api).api.plain.get()).data),
    clientEntry: "/c.js",
    api: inProcessClient(backendOf()),
  })
  expect(await (await plain.fetch(dataRequest(), platform)).json()).toEqual({ ok: true })
  expect(peerReads).toBe(0)

  const reading = createWebApp({
    adapter: stub,
    manifest: manifestWith(ipLoader),
    clientEntry: "/c.js",
    api: inProcessClient(backendOf()),
  })
  expect(await (await reading.fetch(dataRequest(), platform)).json()).toEqual({
    ip: "203.0.113.50",
  })
  expect(peerReads).toBe(1)
})

test("an api without the bind seam is handed to loaders unchanged", async () => {
  const api = { marker: "custom" }
  let seen: unknown
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith((ctx) => {
      seen = ctx.api
      return null
    }),
    clientEntry: "/c.js",
    api,
    apiPrefix: "",
  })
  await app.fetch(dataRequest())
  expect(seen).toBe(api)
})
