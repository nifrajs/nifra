import { expect, test } from "bun:test"
import {
  createWebApp,
  defer,
  enumerateStaticRoutes,
  type Manifest,
  type RenderAdapter,
  type RouteEntry,
  redirect,
  revalidate,
} from "../src/index.ts"

// Turn a string into a one-chunk byte stream — the minimal `renderToStream` an adapter returns.
const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

// Stub adapter — exercises createWebApp + routing with no Solid/React/DOM. It emits the chain
// length + the loader data (+ actionData when an action ran), so assertions can see them all.
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(
      `<p>chain=${chain.length}:${JSON.stringify(props.data)}${
        props.actionData === undefined ? "" : `:action=${JSON.stringify(props.actionData)}`
      }</p>`,
    ),
  hydrationHead: () => "",
}

const fullManifest = (): Manifest => ({
  routes: [
    {
      id: "index",
      pattern: "/",
      layoutIds: [],
      file: "index.tsx",
      load: async () => ({ default: "home" }),
    },
    {
      id: "users/[id]",
      pattern: "/users/:id",
      layoutIds: ["_layout"],
      file: "users/[id].tsx",
      load: async () => ({ default: "user", loader: (ctx) => ({ id: ctx.params.id }) }),
    },
  ],
  layouts: { _layout: { file: "_layout.tsx", load: async () => ({ default: "layout" }) } },
  notFound: { file: "_404.tsx", load: async () => ({ default: "not-found" }) },
})

test("createWebApp SSRs a route (no layout, no loader → chain 1, data null)", async () => {
  const app = createWebApp({ adapter: stub, manifest: fullManifest(), clientEntry: "/c.js" })
  const res = await app.fetch(new Request("http://x/"))
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/html")
  expect(await res.text()).toContain("chain=1:null")
})

test("createWebApp resolves params, runs the loader, and wraps in the layout chain", async () => {
  const app = createWebApp({ adapter: stub, manifest: fullManifest(), clientEntry: "/c.js" })
  const html = await (await app.fetch(new Request("http://x/users/42"))).text()
  expect(html).toContain('chain=2:{"id":"42"}') // [layout, page] + loader data
})

test("createWebApp matches a catch-all route end-to-end (params.path = the rest)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "files/[...path]",
        pattern: "/files/*path", // what filePathToPattern produces for files/[...path].tsx
        layoutIds: [],
        file: "files/[...path].tsx",
        load: async () => ({ default: "files", loader: (ctx) => ({ path: ctx.params.path }) }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const html = await (await app.fetch(new Request("http://x/files/a/b/c.txt"))).text()
  expect(html).toContain('chain=1:{"path":"a/b/c.txt"}') // the catch-all captured the full tail
})

test("createWebApp injects window.__NIFRA_PRERENDERED__ when prerenderedPaths given [SSG P2.4]", async () => {
  const withSet = createWebApp({
    adapter: stub,
    manifest: fullManifest(),
    clientEntry: "/c.js",
    prerenderedPaths: ["/", "/users/1"],
  })
  expect(await (await withSet.fetch(new Request("http://x/"))).text()).toContain(
    'window.__NIFRA_PRERENDERED__=["/","/users/1"]',
  )
  // Omitted ⇒ not injected (no bloat for non-SSG apps).
  const without = createWebApp({ adapter: stub, manifest: fullManifest(), clientEntry: "/c.js" })
  expect(await (await without.fetch(new Request("http://x/"))).text()).not.toContain(
    "__NIFRA_PRERENDERED__",
  )
})

test("createWebApp honors a route module's hydrate=false on document responses", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "home",
          hydrate: false,
          loader: () => ({ count: 1 }),
          action: () => ({ ok: true }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({
    adapter: stub,
    manifest,
    clientEntry: "/assets/client.js",
    routePreload: { index: ["/assets/index.js"] },
  })

  const html = await (await app.fetch(new Request("http://x/"))).text()
  expect(html).toContain('<p>chain=1:{"count":1}</p>')
  expect(html).not.toContain("__NIFRA_DATA__")
  expect(html).not.toContain('<script type="module" src="/assets/client.js">')
  expect(html).not.toContain('rel="modulepreload" href="/assets/client.js"')
  expect(html).not.toContain('rel="modulepreload" href="/assets/index.js"')

  const postHtml = await (
    await app.fetch(new Request("http://x/", { method: "POST", body: new FormData() }))
  ).text()
  expect(postHtml).toContain('<p>chain=1:{"count":1}:action={"ok":true}</p>')
  expect(postHtml).not.toContain("__NIFRA_DATA__")
  expect(postHtml).not.toContain('<script type="module" src="/assets/client.js">')
})

// A dynamic-route manifest used by the SSG fallback tests — `/users/:id` with a loader echoing the id.
const dynManifest = (): Manifest => ({
  routes: [
    {
      id: "users/[id]",
      pattern: "/users/:id",
      layoutIds: [],
      file: "users/[id].tsx",
      load: async () => ({ default: "user", loader: (ctx) => ({ id: ctx.params.id }) }),
    },
  ],
  layouts: {},
  notFound: { file: "_404.tsx", load: async () => ({ default: "not-found" }) },
})

test('SSG fallback:"404" — an unlisted dynamic path 404s; listed paths still serve', async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: dynManifest(),
    clientEntry: "/c.js",
    prerenderedPaths: ["/users/1"],
    staticFallbacks: { "/users/:id": "404" },
  })
  // A prerendered (listed) path exists → 200.
  expect((await app.fetch(new Request("http://x/users/1"))).status).toBe(200)
  // An unlisted path under a "404" route doesn't exist → the _404 page (404).
  const miss = await app.fetch(new Request("http://x/users/999"))
  expect(miss.status).toBe(404)
  expect(await miss.text()).toContain("chain=1:null") // the [_404] chain, not the user page
  // A client soft-nav's data fetch for it also 404s (the client then throws → full-page nav → here).
  const dataMiss = await app.fetch(
    new Request("http://x/users/999", { headers: { "x-nifra-data": "1" } }),
  )
  expect(dataMiss.status).toBe(404)
})

test('SSG fallback:"ssr" (and unmapped) renders unlisted dynamic paths on-demand', async () => {
  // Unmapped → default "ssr": an unlisted path renders live (the hybrid default).
  const unmapped = createWebApp({
    adapter: stub,
    manifest: dynManifest(),
    clientEntry: "/c.js",
    prerenderedPaths: ["/users/1"],
  })
  const live = await unmapped.fetch(new Request("http://x/users/999"))
  expect(live.status).toBe(200)
  expect(await live.text()).toContain('chain=1:{"id":"999"}') // SSR'd with the live param
  // Explicit "ssr" behaves identically (no 404 enforcement).
  const explicit = createWebApp({
    adapter: stub,
    manifest: dynManifest(),
    clientEntry: "/c.js",
    prerenderedPaths: ["/users/1"],
    staticFallbacks: { "/users/:id": "ssr" },
  })
  expect((await explicit.fetch(new Request("http://x/users/999"))).status).toBe(200)
})

test("enumerateStaticRoutes collects prerendered paths + each dynamic route's fallback", async () => {
  const routes: RouteEntry[] = [
    {
      id: "index",
      pattern: "/",
      layoutIds: [],
      file: "index.tsx",
      load: async () => ({ default: "home", prerender: true }),
    },
    {
      id: "blog/[slug]",
      pattern: "/blog/:slug",
      layoutIds: [],
      file: "blog/[slug].tsx",
      load: async () => ({
        default: "post",
        getStaticPaths: async () => ({
          paths: [{ params: { slug: "a" } }, { params: { slug: "b" } }],
          fallback: "404",
        }),
      }),
    },
    {
      id: "users/[id]",
      pattern: "/users/:id",
      layoutIds: [],
      file: "users/[id].tsx",
      // No `fallback` → defaults to "ssr".
      load: async () => ({
        default: "user",
        getStaticPaths: async () => ({ paths: [{ params: { id: "1" } }] }),
      }),
    },
    {
      id: "search/[q]",
      pattern: "/search/:q",
      layoutIds: [],
      file: "search/[q].tsx",
      // Dynamic but no getStaticPaths → omitted from both paths and fallbacks.
      load: async () => ({ default: "search" }),
    },
  ]
  const { paths, fallbacks } = await enumerateStaticRoutes(routes)
  expect([...paths].sort()).toEqual(["/", "/blog/a", "/blog/b", "/users/1"])
  expect(fallbacks).toEqual({ "/blog/:slug": "404", "/users/:id": "ssr" })
})

test("a route's `revalidate` rides the x-nifra-isr-revalidate header (ISR P3.3)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "isr",
        pattern: "/isr",
        layoutIds: [],
        file: "isr.tsx",
        load: async () => ({ default: "isr", revalidate: 60 }),
      },
      {
        id: "plain",
        pattern: "/plain",
        layoutIds: [],
        file: "plain.tsx",
        load: async () => ({ default: "plain" }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const isr = await app.fetch(new Request("http://x/isr"))
  expect(isr.headers.get("x-nifra-isr-revalidate")).toBe("60") // seconds, distinct channel
  expect(isr.headers.get("x-nifra-revalidate")).toBeNull() // never aliases the action path-list header
  // A route without `revalidate` emits no header (the withISR default TTL applies).
  const plain = await app.fetch(new Request("http://x/plain"))
  expect(plain.headers.get("x-nifra-isr-revalidate")).toBeNull()
})

test("createWebApp renders _404 (status 404) for unmatched paths", async () => {
  const app = createWebApp({ adapter: stub, manifest: fullManifest(), clientEntry: "/c.js" })
  const res = await app.fetch(new Request("http://x/nope/whatever"))
  expect(res.status).toBe(404)
  expect(await res.text()).toContain("chain=1:null") // the [_404] chain
})

test("createWebApp falls back to a plain 404 when no _404 exists", async () => {
  const base = fullManifest()
  const app = createWebApp({
    adapter: stub,
    manifest: { routes: base.routes, layouts: base.layouts },
    clientEntry: "/c.js",
  })
  const res = await app.fetch(new Request("http://x/missing"))
  expect(res.status).toBe(404)
  expect(await res.text()).toBe("Not Found")
})

test("createWebApp injects the api into the loader context", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "page",
          loader: (ctx) => ({ tag: (ctx.api as { tag: string }).tag }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js", api: { tag: "API!" } })
  const html = await (await app.fetch(new Request("http://x/"))).text()
  expect(html).toContain('chain=1:{"tag":"API!"}') // the injected api reached the loader
})

test("createWebApp forwards the platform env into the loader context (args.env)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "page",
          loader: (ctx) => ({ token: (ctx.env as { TOKEN: string }).TOKEN }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const html = await (
    await app.fetch(new Request("http://x/"), { env: { TOKEN: "edge-secret" } })
  ).text()
  expect(html).toContain('chain=1:{"token":"edge-secret"}') // c.env reached the loader's args.env
})

// --- I1: actions (POST) + progressive enhancement ---

test("createWebApp runs an action on POST and re-renders with actionData + the loader", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "page",
          loader: () => ({ count: 1 }), // re-runs after the action for fresh data
          action: async (ctx) => {
            const body = await ctx.request.formData()
            return { saved: body.get("name") }
          },
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(
    new Request("http://x/", { method: "POST", body: new URLSearchParams({ name: "Ada" }) }),
  )
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('chain=1:{"count":1}') // loader re-ran
  expect(html).toContain(':action={"saved":"Ada"}') // action data reached the component
  expect(html).toContain('window.__NIFRA_ACTION__={"saved":"Ada"}') // serialized so hydration matches
})

test("a deferred action streams NDJSON on a data-mode submit (critical first, then the deferred)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "page",
          action: () => ({ ok: true, recs: defer(Promise.resolve(["x", "y"])) }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(
    new Request("http://x/", { method: "POST", headers: { "x-nifra-data": "1" } }),
  )
  expect(res.headers.get("content-type")).toContain("application/x-ndjson")
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  expect(lines[0]).toEqual({ ok: true, recs: { __nifra_deferred: 0 } }) // critical data first
  expect(lines.slice(1).find((m) => m.i === 0)).toEqual({ i: 0, v: ["x", "y"] }) // then the deferred
})

test("a non-deferred action still returns one JSON on a data-mode submit (unchanged fast path)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({ default: "page", action: () => ({ saved: true }) }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(
    new Request("http://x/", { method: "POST", headers: { "x-nifra-data": "1" } }),
  )
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ saved: true })
})

test("an action's revalidate() sets X-Nifra-Revalidate and the body is the unwrapped inner data", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "page",
          action: () => revalidate(["/", "/other"], { saved: true }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(
    new Request("http://x/", { method: "POST", headers: { "x-nifra-data": "1" } }),
  )
  expect(res.headers.get("x-nifra-revalidate")).toBe("/,/other") // declared paths ride the header
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ saved: true }) // body is the inner data; wrapper stripped
})

test("a deferred action streams mid-page on a no-JS full-page POST (placeholder + resolve script)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "page",
          action: () => ({ recs: defer(Promise.resolve(["x"])) }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const html = await (await app.fetch(new Request("http://x/", { method: "POST" }))).text()
  // The action result is split like loader data: __NIFRA_ACTION__ carries the placeholder (id 0 — the
  // null loader contributes none), and the value streams in a __nifraResolve script after the body.
  expect(html).toContain('window.__NIFRA_ACTION__={"recs":{"__nifra_deferred":0}}')
  expect(html).toContain("window.__nifraResolve(0,")
  expect(html).toContain('["x"]') // the resolved value, streamed (not awaited inline)
})

test("an action's Response (redirect) passes straight through (Post/Redirect/Get)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({ default: "page", action: () => redirect("/thanks") }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(new Request("http://x/", { method: "POST" }))
  expect(res.status).toBe(303)
  expect(res.headers.get("location")).toBe("/thanks")
})

test("POST to a route without an action is 405 (not a stray 404), with Allow: GET", async () => {
  const app = createWebApp({ adapter: stub, manifest: fullManifest(), clientEntry: "/c.js" })
  const res = await app.fetch(new Request("http://x/users/42", { method: "POST" }))
  expect(res.status).toBe(405)
  expect(res.headers.get("allow")).toBe("GET")
})

test("an action receives the route params + the injected api", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "users/[id]",
        pattern: "/users/:id",
        layoutIds: [],
        file: "users/[id].tsx",
        load: async () => ({
          default: "page",
          action: (ctx) => ({ id: ctx.params.id, tag: (ctx.api as { tag: string }).tag }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js", api: { tag: "API!" } })
  const html = await (await app.fetch(new Request("http://x/users/7", { method: "POST" }))).text()
  expect(html).toContain(':action={"id":"7","tag":"API!"}')
})

// --- I2: loader-as-JSON (client navigation fetches the loader data, not HTML) ---

test("GET with the X-Nifra-Data header returns loader JSON, not the HTML document", async () => {
  const app = createWebApp({ adapter: stub, manifest: fullManifest(), clientEntry: "/c.js" })
  const res = await app.fetch(
    new Request("http://x/users/42", { headers: { "x-nifra-data": "1" } }),
  )
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ id: "42" }) // the loader's data, raw — no chain/markup
})

test("a data-only GET on a loaderless route returns null", async () => {
  const app = createWebApp({ adapter: stub, manifest: fullManifest(), clientEntry: "/c.js" })
  const res = await app.fetch(new Request("http://x/", { headers: { "x-nifra-data": "1" } }))
  expect(await res.json()).toBeNull()
})

test("a data-only GET streams NDJSON when the route defers (critical first, then resolutions)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({
          default: "page",
          loader: () => ({ now: 1, slow: defer(Promise.resolve("done")) }),
        }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(new Request("http://x/", { headers: { "x-nifra-data": "1" } }))
  expect(res.headers.get("content-type")).toContain("application/x-ndjson")
  const lines = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  expect(lines[0]).toEqual({ now: 1, slow: { __nifra_deferred: 0 } }) // critical data + placeholder
  expect(lines[1]).toEqual({ i: 0, v: "done" }) // the deferred value streamed after
})

// --- I4: data-mode action POST (client submit) ---

test("POST with X-Nifra-Data returns the action data as JSON (client submit, no HTML)", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({ default: "page", action: () => ({ saved: true }) }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(
    new Request("http://x/", { method: "POST", headers: { "x-nifra-data": "1" } }),
  )
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ saved: true })
})

test("POST with X-Nifra-Data converts an action redirect into an X-Nifra-Redirect header", async () => {
  const manifest: Manifest = {
    routes: [
      {
        id: "index",
        pattern: "/",
        layoutIds: [],
        file: "index.tsx",
        load: async () => ({ default: "page", action: () => redirect("/thanks") }),
      },
    ],
    layouts: {},
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  const res = await app.fetch(
    new Request("http://x/", { method: "POST", headers: { "x-nifra-data": "1" } }),
  )
  expect(res.status).toBe(204)
  expect(res.headers.get("x-nifra-redirect")).toBe("/thanks")
})

test("createWebApp modulepreloads the matched route's chunks when routePreload is given", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: fullManifest(),
    clientEntry: "/c.js",
    routePreload: {
      index: ["/assets/_layout-x.js", "/assets/index-y.js"],
      "users/[id]": ["/assets/u.js"],
    },
  })
  const home = await (await app.fetch(new Request("http://x/"))).text()
  expect(home).toContain('<link rel="modulepreload" href="/assets/_layout-x.js">')
  expect(home).toContain('<link rel="modulepreload" href="/assets/index-y.js">')
  // The other route's chunk is NOT preloaded on this page.
  expect(home).not.toContain("/assets/u.js")
  // A route with no entry in the map preloads only the entry (no per-route links, no crash).
  const user = await (await app.fetch(new Request("http://x/users/7"))).text()
  expect(user).toContain('<link rel="modulepreload" href="/assets/u.js">')
})

test("redirect() allows same-origin paths; numeric + options 2nd arg [AUDIT Sec-4]", () => {
  expect(redirect("/thanks").status).toBe(303)
  expect(redirect("/thanks").headers.get("location")).toBe("/thanks")
  expect(redirect("/x", 307).status).toBe(307) // back-compat numeric 2nd arg
  expect(redirect("/x", { status: 308 }).status).toBe(308) // options form
})

test("redirect() rejects off-origin destinations unless { external: true } [AUDIT Sec-4]", () => {
  // Open-redirect guard: an absolute URL, protocol-relative "//host", a scheme, or a bare relative.
  for (const bad of ["https://evil.com", "//evil.com", "http://x", "javascript:alert(1)", "foo"]) {
    expect(() => redirect(bad)).toThrow(/same-origin/)
  }
  // Explicit opt-in is honored.
  const r = redirect("https://example.com/ok", { external: true })
  expect(r.status).toBe(303)
  expect(r.headers.get("location")).toBe("https://example.com/ok")
})
