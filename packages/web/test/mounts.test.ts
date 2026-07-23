import { expect, test } from "bun:test"
import { NIFRA_BACKEND_MOUNT } from "@nifrajs/core/mount"
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
  // request 404s inside it, and the workaround is a Proxy rewriting each URL — which two apps wrote
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
  // better-auth is not a `backend` route — the starter registers it on stack.routes. Without a mount
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
      // Broad one FIRST — a declaration-order implementation would let it swallow the specific one.
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
