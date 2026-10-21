/**
 * The live client against a real server: a real socket, real grants and a real router. A write
 * published on the server reloads exactly the owner that read the key, and a navigation carries the
 * layouts over.
 */
import { afterEach, expect, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { live } from "../src/live.ts"
import { liveClient } from "../src/live-client.ts"
import type { LoaderContext } from "../src/manifest.ts"
import { createClientRouter } from "../src/router.ts"

const stub: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const saved = {
  WebSocket: Reflect.get(globalThis, "WebSocket"),
  location: Reflect.get(globalThis, "location"),
}
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  Reflect.set(globalThis, "WebSocket", saved.WebSocket)
  if (saved.location === undefined) Reflect.deleteProperty(globalThis, "location")
  else Reflect.set(globalThis, "location", saved.location)
})

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 50_000; turn++) {
    if (ok()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`[test] never: ${what}`)
}

function serve() {
  const runs = { root: 0, post: 0, about: 0 }
  const values = { post: 1 }
  const runtime = live({ secret: "client-e2e-secret-0123456789abcdef", subject: () => null })
  const manifest: Manifest = {
    routes: [
      {
        id: "posts/[id]",
        pattern: "/posts/:id",
        layoutIds: ["_layout"],
        layoutParams: [[]],
        file: "posts/[id].tsx",
        load: async () => ({
          default: "post",
          loader: (ctx: LoaderContext) => {
            runs.post++
            ctx.live(`post:${ctx.params.id}`)
            return { id: ctx.params.id, value: values.post }
          },
        }),
      },
      {
        id: "about",
        pattern: "/about",
        layoutIds: ["_layout"],
        layoutParams: [[]],
        file: "about.tsx",
        load: async () => ({
          default: "about",
          loader: (ctx: LoaderContext) => {
            runs.about++
            ctx.live("about")
            return { about: true }
          },
        }),
      },
    ],
    layouts: {
      _layout: {
        file: "root.tsx",
        load: async () => ({
          default: "root",
          loader: (ctx: LoaderContext) => {
            runs.root++
            ctx.live("site:nav")
            return { root: runs.root }
          },
        }),
      },
    },
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js", live: runtime })
  const running = app.listen(0, { hostname: "127.0.0.1" })
  stops.push(() => running.stop(true))
  const base = `http://127.0.0.1:${running.port}`
  // What a browser on the page's origin sends: the socket and every POST carry its `Origin`.
  const Native = WebSocket
  Reflect.set(globalThis, "WebSocket", function WithOrigin(url: string) {
    return Reflect.construct(Native, [url, { headers: { origin: base } }])
  })
  Reflect.set(globalThis, "location", { href: `${base}/`, origin: base })
  const loads: string[] = []
  const client = liveClient({
    layoutIdsOf: { "posts/[id]": ["_layout"], about: ["_layout"] },
    fetch: (input, init) => {
      loads.push(input)
      const headers = new Headers(init.headers)
      headers.set("origin", base)
      return fetch(new URL(input, base), { ...init, headers })
    },
  })
  const router = createClientRouter({
    patterns: [
      { routeId: "posts/[id]", pattern: "/posts/:id" },
      { routeId: "about", pattern: "/about" },
    ],
    initial: {
      routeId: "posts/[id]",
      params: { id: "1" },
      path: "/posts/1",
      data: { id: "1", value: 0 },
      layoutData: [{ root: 0 }],
      pending: false,
    },
    fetchData: client.fetchData,
  })
  return { runtime, runs, values, router, client, loads }
}

test("a published write reloads just the page that read it, and a navigation keeps the layout", async () => {
  const s = serve()
  stops.push(s.client.attach(s.router))
  // Hydrated from the document, the page has no grant: one live load fetches it.
  await until(() => s.runs.post === 1 && !s.router.snapshot().pending, "first live load")
  expect(s.runs).toEqual({ root: 1, post: 1, about: 0 })
  // The grant is watched once the socket's `ready` arrives, which the page cannot observe: publish
  // until the change lands, as a writer would keep writing.
  s.values.post = 2
  let delivered = false
  for (let attempt = 0; attempt < 50 && !delivered; attempt++) {
    await s.runtime.publish("post:1")
    for (let turn = 0; turn < 2_000 && !delivered; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
      delivered = s.runs.post >= 2 && !s.router.snapshot().pending
    }
  }
  expect(delivered).toBe(true)
  // Only the page's loader ran again; the root layout stayed as shown.
  expect(s.runs.root).toBe(1)
  expect(s.router.snapshot().data).toEqual({ id: "1", value: 2 })
  expect(s.router.snapshot().layoutData).toEqual([{ root: 1 }])

  await s.router.navigate("/about")
  expect(s.runs).toMatchObject({ root: 1, about: 1 })
  expect(s.router.snapshot().layoutData).toEqual([{ root: 1 }])
  expect(s.loads.every((path) => path === "/_nifra/live/load")).toBe(true)
})
