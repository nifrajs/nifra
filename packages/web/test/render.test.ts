import { expect, test } from "bun:test"
import {
  DATA_GLOBAL,
  defer,
  mergeHeads,
  type RenderAdapter,
  ROUTE_GLOBAL,
  renderPage,
  renderPageResult,
  resolveMeta,
  serializeData,
} from "../src/index.ts"

const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)

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

// A stub adapter — proves the core orchestration is genuinely framework-agnostic (no Solid,
// no React, no DOM). It "folds" the chain trivially: emits the chain length + the data.
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "<!--hydration-head-->",
}

test("renderPage builds an HTML doc: SSR markup, hydration head, data, client entry", async () => {
  const res = await renderPage({
    adapter: stub,
    chain: [() => {}, () => {}], // layout + page
    data: { user: "ada" },
    clientEntry: "/assets/client.js",
    title: "Hi",
  })
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
  const html = await res.text()
  expect(html).toContain("<!doctype html>")
  expect(html).toContain("<title>Hi</title>")
  expect(html).toContain("<!--hydration-head-->")
  expect(html).toContain('<div id="root"><p>chain=2:{"user":"ada"}</p></div>')
  expect(html).toContain(`window.${DATA_GLOBAL}={"user":"ada"}`)
  expect(html).toContain('<script type="module" src="/assets/client.js">')
  expect(html).toContain('<link rel="modulepreload" href="/assets/client.js">') // preloads the entry
})

test("renderPage modulepreloads the matched route's chunks (deduped against the entry)", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [() => {}],
      data: null,
      clientEntry: "/assets/client.js",
      preload: ["/assets/_layout-a.js", "/assets/index-b.js", "/assets/client.js"],
    })
  ).text()
  expect(html).toContain('<link rel="modulepreload" href="/assets/_layout-a.js">')
  expect(html).toContain('<link rel="modulepreload" href="/assets/index-b.js">')
  // The entry preload appears exactly once — the route list's duplicate of it is dropped.
  expect(html.match(/modulepreload" href="\/assets\/client\.js"/g)?.length).toBe(1)
})

test("renderPage injects the matched route's stylesheets as <link> in <head>", async () => {
  const res = await renderPage({
    adapter: stub,
    chain: [() => {}],
    data: null,
    clientEntry: "/assets/client.js",
    styles: ["/assets/_layout-x.css", "/assets/index-y.css"],
  })
  const html = await res.text()
  expect(html).toContain('<link rel="stylesheet" href="/assets/_layout-x.css">')
  expect(html).toContain('<link rel="stylesheet" href="/assets/index-y.css">')
  // In <head>, before the body opens.
  expect(html.indexOf("stylesheet")).toBeLessThan(html.indexOf("<body>"))
})

test("renderPage emits stylesheets even on a non-hydrated page (e.g. _error)", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [() => {}],
      data: null,
      clientEntry: "/assets/client.js",
      styles: ["/assets/app-z.css"],
      hydrate: false,
    })
  ).text()
  expect(html).toContain('<link rel="stylesheet" href="/assets/app-z.css">')
  // ...but no client entry (non-hydrated terminal page).
  expect(html).not.toContain('<script type="module"')
  // Preload links are attribute-escaped (no breakout).
  const esc = await (
    await renderPage({
      adapter: stub,
      chain: [() => {}],
      data: null,
      clientEntry: "/c.js",
      preload: ['/a.js"><script>x'],
    })
  ).text()
  expect(esc).not.toContain('"><script>x')
})

test("renderPage injects the matched route id only when provided", async () => {
  const withId = await (
    await renderPage({
      adapter: stub,
      chain: [() => {}],
      data: null,
      clientEntry: "/c.js",
      routeId: "users/[id]",
    })
  ).text()
  expect(withId).toContain(`window.${ROUTE_GLOBAL}="users/[id]"`)

  const withoutId = await (
    await renderPage({ adapter: stub, chain: [() => {}], data: null, clientEntry: "/c.js" })
  ).text()
  expect(withoutId).not.toContain(ROUTE_GLOBAL)
})

test("renderPage escapes title, rootId, and clientEntry (no attribute/markup breakout)", async () => {
  const res = await renderPage({
    adapter: stub,
    chain: [null],
    data: null,
    clientEntry: '"/x"><script>evil</script>',
    title: "<b>t</b>",
    rootId: 'r"><x',
  })
  const html = await res.text()
  expect(html).toContain("<title>&lt;b&gt;t&lt;/b&gt;</title>")
  expect(html).toContain('id="r&quot;&gt;&lt;x"')
  expect(html).not.toContain('"/x"><script>evil') // attribute can't be broken out of
})

test("renderPage injects head: title override + managed (data-nifra) meta/link, value-escaped", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      title: "default",
      head: {
        title: "User 7",
        meta: [{ name: "description", content: 'hi <"there"> & you', "bad key": "dropped" }],
        link: [{ rel: "canonical", href: "/users/7" }],
      },
    })
  ).text()
  expect(html).toContain("<title>User 7</title>") // head.title overrides the title option
  expect(html).toContain(
    '<meta name="description" content="hi &lt;&quot;there&quot;&gt; &amp; you" data-nifra>',
  )
  expect(html).toContain('<link rel="canonical" href="/users/7" data-nifra>')
  expect(html).not.toContain("bad key") // invalid attribute names are dropped
})

test("renderPage keeps the full standard <link> attr set (hreflang, crossorigin, …) in <head> [#4]", async () => {
  // Regression: the attribute filter is a name-shape guard, NOT a hardcoded allowlist — so every
  // standard <link> attribute (hreflang/crossorigin/media/sizes/as/integrity/fetchpriority/…) must
  // survive. A hardcoded list previously dropped hreflang/crossorigin.
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      title: "default",
      head: {
        link: [
          { rel: "alternate", hreflang: "es", href: "https://x/es" },
          {
            rel: "preconnect",
            href: "https://cdn.example.com",
            crossorigin: "anonymous",
            fetchpriority: "high",
          },
        ],
      },
    })
  ).text()
  expect(html).toContain('<link rel="alternate" hreflang="es" href="https://x/es" data-nifra>')
  // crossorigin AND fetchpriority both survive (neither is dropped by the name guard).
  expect(html).toContain(
    '<link rel="preconnect" href="https://cdn.example.com" crossorigin="anonymous" fetchpriority="high" data-nifra>',
  )
})

test("renderPage falls back to the title option when head has no title", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      title: "fallback",
      head: { meta: [{ name: "x", content: "y" }] },
    })
  ).text()
  expect(html).toContain("<title>fallback</title>")
})

test("renderPage streams the app between shell and tail, multi-chunk + in order", async () => {
  // An adapter that emits two chunks → exercises the concat pump's forward loop.
  const twoChunk: RenderAdapter = {
    renderToStream: () =>
      new ReadableStream({
        start(c) {
          const e = new TextEncoder()
          c.enqueue(e.encode("AAA"))
          c.enqueue(e.encode("BBB"))
          c.close()
        },
      }),
    hydrationHead: () => "",
  }
  const html = await (
    await renderPage({ adapter: twoChunk, chain: [null], data: null, clientEntry: "/c.js" })
  ).text()
  const root = html.indexOf('<div id="root">')
  const a = html.indexOf("AAA")
  const b = html.indexOf("BBB")
  const close = html.indexOf("</div>")
  expect(root).toBeGreaterThanOrEqual(0)
  expect(root).toBeLessThan(a) // shell before app
  expect(a).toBeLessThan(b) // app chunks in order
  expect(b).toBeLessThan(close) // app before tail
})

test("a mid-stream render error errors the response body (no silent truncation)", async () => {
  const boom: RenderAdapter = {
    renderToStream: () =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("partial"))
          c.error(new Error("render boom")) // fails after the shell + a partial chunk went out
        },
      }),
    hydrationHead: () => "",
  }
  const res = await renderPage({ adapter: boom, chain: [null], data: null, clientEntry: "/c.js" })
  await expect(res.text()).rejects.toThrow() // draining the broken body rejects, not a quiet 200
})

test("a shell-render throw rejects renderPage before any byte is sent (mappable to a 500)", async () => {
  const throws: RenderAdapter = {
    renderToStream: () => {
      throw new Error("shell boom")
    },
    hydrationHead: () => "",
  }
  await expect(
    renderPage({ adapter: throws, chain: [null], data: null, clientEntry: "/c.js" }),
  ).rejects.toThrow("shell boom")
})

test("renderPage with deferred data: client placeholder + the inline registry runtime", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: { now: 1, slow: defer(Promise.resolve("later")) },
      clientEntry: "/c.js",
    })
  ).text()
  // The serialized data carries a numeric-id placeholder (not the promise).
  expect(html).toContain(`window.${DATA_GLOBAL}={"now":1,"slow":{"__nifra_deferred":0}}`)
  // The inline registry runtime is present (settles streamed __nifraResolve scripts).
  expect(html).toContain("window.__nifraResolve")
  expect(html).toContain("window.__nifraDeferred")
})

test("renderPage omits the deferred runtime when nothing is deferred", async () => {
  const html = await (
    await renderPage({ adapter: stub, chain: [null], data: { a: 1 }, clientEntry: "/c.js" })
  ).text()
  expect(html).not.toContain("__nifraResolve") // non-deferred output is unchanged
  expect(html).toContain(`window.${DATA_GLOBAL}={"a":1}`)
})

test("renderPage streams __nifraReject for a deferred that rejects (no broken body)", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: { slow: defer(Promise.reject(new Error("boom secret detail"))) },
      clientEntry: "/c.js",
    })
  ).text()
  // A rejected deferred streams __nifraReject (no broken body) — REDACTED to a stable opaque code,
  // never the raw error text ("boom secret detail" is logged server-side, not leaked). [AUDIT H3]
  expect(html).toContain('window.__nifraReject(0,"deferred_error")')
  expect(html).not.toContain("boom secret detail")
})

test("renderPage streams deferred resolutions out-of-order — a slow defer() doesn't block a fast one [AUDIT H1]", async () => {
  // #0 resolves slowly, #1 quickly. The fast one's resolve script must stream FIRST (not FIFO).
  const res = await renderPage({
    adapter: stub,
    chain: [null],
    data: {
      slow: defer(new Promise<string>((r) => setTimeout(() => r("SLOW"), 80))),
      fast: defer(new Promise<string>((r) => setTimeout(() => r("FAST"), 5))),
    },
    clientEntry: "/c.js",
  })
  const body = res.body
  if (body === null) throw new Error("expected a streamed body")
  const reader = body.getReader()
  const dec = new TextDecoder()
  const order: number[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const m of dec.decode(value).matchAll(/__nifraResolve\((\d+),/g)) order.push(Number(m[1]))
  }
  expect(order).toEqual([1, 0]) // fast (id 1) settled + streamed before slow (id 0)
})

test("resolveMeta: undefined → {}, static passthrough, function of data + params", () => {
  expect(resolveMeta(undefined, { data: null, params: {} })).toEqual({})
  expect(resolveMeta({ title: "Static" }, { data: null, params: {} })).toEqual({ title: "Static" })
  const meta = resolveMeta((a) => ({ title: `id=${a.params.id}` }), {
    data: null,
    params: { id: "7" },
  })
  expect(meta).toEqual({ title: "id=7" })
})

test("mergeHeads: title nearest-wins, meta/link concatenated outermost→page [#3]", () => {
  // heads order = outermost layout → … → page. title is nearest-wins (later overrides);
  // meta/link arrays concatenate in that order.
  const merged = mergeHeads([
    { title: "Outer", link: [{ rel: "preconnect", href: "https://a" }] },
    { title: "Inner", meta: [{ name: "theme-color", content: "#000" }] },
    { title: "Page", link: [{ rel: "canonical", href: "/p" }] },
  ])
  expect(merged.title).toBe("Page") // page wins
  expect(merged.meta).toEqual([{ name: "theme-color", content: "#000" }])
  expect(merged.link).toEqual([
    { rel: "preconnect", href: "https://a" }, // layout first
    { rel: "canonical", href: "/p" }, // page last
  ])
})

test("mergeHeads: an undefined-title page keeps the layout's title; single head is identity [#3]", () => {
  expect(mergeHeads([{ title: "Layout" }, {}]).title).toBe("Layout") // page silent → keep layout's
  const only = { title: "Solo", link: [{ rel: "canonical", href: "/" }] }
  expect(mergeHeads([only])).toBe(only) // single-head fast path returns by reference (memo-friendly)
})

test("serializeData neutralizes </script>, comments, and line separators (XSS-safe)", () => {
  const out = serializeData({ x: "</script><!--", y: LINE_SEP + PARA_SEP })
  expect(out).not.toContain("</script>")
  expect(out).not.toContain("<!--")
  expect(out).not.toContain(LINE_SEP)
  expect(out).not.toContain(PARA_SEP)
  expect(out).toContain("\\u003c")
  const restored = out
    .replaceAll("\\u003c", "<")
    .replaceAll("\\u003e", ">")
    .replaceAll("\\u2028", LINE_SEP)
    .replaceAll("\\u2029", PARA_SEP)
  expect(JSON.parse(restored)).toEqual({ x: "</script><!--", y: LINE_SEP + PARA_SEP })
})

test("serializeData maps null and undefined to null", () => {
  expect(serializeData(undefined)).toBe("null")
  expect(serializeData(null)).toBe("null")
  expect(serializeData({ a: 1 })).toBe('{"a":1}')
})

// An adapter offering BOTH a sync `renderToString` and a streaming `renderToStream` — proves
// renderPage picks the buffered (sync) path for non-deferred pages and the streaming path when
// anything defer()s. Each method tags its output so the test can tell which one ran.
const dual: RenderAdapter = {
  renderToString: (chain, props) =>
    `<p>string:chain=${chain.length}:${JSON.stringify(props.data)}</p>`,
  renderToStream: (chain, props) =>
    streamOf(`<p>stream:chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "",
}

test("renderPage uses the sync renderToString fast path when nothing defers", async () => {
  const res = renderPage({
    adapter: dual,
    chain: [null, null],
    data: { a: 1 },
    clientEntry: "/c.js",
  })
  expect(res).toBeInstanceOf(Response)
  if (!(res instanceof Response)) throw new Error("renderPage should return a sync Response")
  const html = await res.text()
  expect(html).toContain('<div id="root"><p>string:chain=2:{"a":1}</p></div>') // buffered, NOT streamed
  expect(html).not.toContain("stream:")
  expect(html).toContain(`window.${DATA_GLOBAL}={"a":1}`) // same tail/data as the streaming path
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8") // a real Response, headers intact
})

test("renderPageResult exposes a node-direct body for sync non-deferred pages", async () => {
  const page = renderPageResult({
    adapter: dual,
    chain: [null, null],
    data: { a: 1 },
    clientEntry: "/c.js",
    status: 202,
  })
  expect(page).not.toBeInstanceOf(Response)
  if (page instanceof Promise) throw new Error("sync page should not be async")
  const body = page.toNodeBody?.()
  expect(body?.status).toBe(202)
  expect(body?.headers?.["content-type"]).toBe("text/html; charset=utf-8")
  if (typeof body?.body !== "string") throw new Error("expected string body")
  expect(body.body).toContain('<div id="root"><p>string:chain=2:{"a":1}</p></div>')
  expect(await page.toResponse().text()).toBe(body.body)
})

test("renderPage falls back to the streaming path when a value defers (needs progressive Await)", async () => {
  const html = await (
    await renderPage({
      adapter: dual,
      chain: [null],
      data: { slow: defer(Promise.resolve("later")) },
      clientEntry: "/c.js",
    })
  ).text()
  expect(html).toContain("stream:") // streaming renderer ran, not the sync one
  expect(html).not.toContain("string:")
  expect(html).toContain("window.__nifraResolve") // deferred runtime present
})

test("renderPage still streams for an adapter without renderToString (back-compat)", async () => {
  // `stub` (defined above) has no renderToString — the streaming path must remain the default.
  const html = await (
    await renderPage({ adapter: stub, chain: [null], data: { a: 1 }, clientEntry: "/c.js" })
  ).text()
  expect(html).toContain('<div id="root"><p>chain=1:{"a":1}</p></div>')
})

test("renderPage propagates a sync-render throw (so the _error boundary can map it)", async () => {
  const boom: RenderAdapter = {
    renderToString: () => {
      throw new Error("render boom")
    },
    renderToStream: () => streamOf("unused"),
    hydrationHead: () => "",
  }
  expect(() =>
    renderPage({ adapter: boom, chain: [null], data: { a: 1 }, clientEntry: "/c.js" }),
  ).toThrow("render boom")
})

test("renderPage loads islandScripts on a STATIC page (hydrate:false) with no framework client", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: { a: 1 },
      clientEntry: "/c.js",
      hydrate: false,
      islandScripts: ["/assets/island.js"],
    })
  ).text()
  expect(html).toContain('<script type="module" src="/assets/island.js"></script>') // island bundle
  // …preloaded in <head> so the (often heavy) island bundle downloads in parallel with parsing instead
  // of only being discovered at end-of-body — the fix for "static page stuck on its placeholder until
  // the late island fetch lands" on a cold first load.
  expect(html).toContain('<head><meta charset="utf-8"')
  expect(html.split("<body>")[0]).toContain('<link rel="modulepreload" href="/assets/island.js">')
  expect(html).not.toContain("/c.js") // no framework client entry on a static page
  expect(html).not.toContain("__NIFRA_DATA__") // no serialized loader data either
})

test("renderPage escapes islandScripts URLs (no attribute breakout)", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      hydrate: false,
      islandScripts: ['/a.js"></script><script>evil'],
    })
  ).text()
  expect(html).not.toContain('"></script><script>evil')
})
