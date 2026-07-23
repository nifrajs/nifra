import { expect, test } from "bun:test"
import {
  canonical,
  DATA_GLOBAL,
  defer,
  jsonLd,
  mergeHeads,
  openGraph,
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
  // The pre-hydration form guard is inlined in <head> on a hydrating page.
  expect(html).toContain("addEventListener('submit'")
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
  // ...and no pre-hydration guard — a non-hydrating page has no client handlers to race.
  expect(html).not.toContain("addEventListener('submit'")
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

test("renderPage renders LinkDescriptor boolean attrs: true → bare, false/undefined → omitted [#A]", async () => {
  // LinkDescriptor values are `string | boolean | undefined`: a string renders `name="value"`,
  // `true` renders the bare boolean attribute (HTML convention), `false`/`undefined` are skipped
  // entirely. Regression for the typed-partial fix — a `{ rel, href }` interface is now assignable.
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      head: {
        link: [
          { rel: "stylesheet", href: "/print.css", media: "print", disabled: true },
          { rel: "stylesheet", href: "/main.css", disabled: false },
          // A conditionally-absent custom attribute (index-signature path) renders nothing.
          { rel: "preload", href: "/x.woff2", as: "font", "data-when": undefined },
        ],
      },
    })
  ).text()
  // `disabled: true` → bare attribute with no `="..."`.
  expect(html).toContain(
    '<link rel="stylesheet" href="/print.css" media="print" disabled data-nifra>',
  )
  // `disabled: false` → the attribute is omitted (the link is NOT disabled).
  expect(html).toContain('<link rel="stylesheet" href="/main.css" data-nifra>')
  expect(html).not.toContain('href="/main.css" disabled')
  // `data-when: undefined` → omitted, the rest of the tag is intact.
  expect(html).toContain('<link rel="preload" href="/x.woff2" as="font" data-nifra>')
  expect(html).not.toContain("data-when")
})

// --- head <script> slot (JSON-LD) + breakout escaping ---

test("renderPage renders the head <script> slot (JSON-LD), default type, managed (data-nifra)", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      head: {
        script: [{ content: '{"@context":"https://schema.org","@type":"Article"}' }],
      },
    })
  ).text()
  // Default type is application/ld+json; managed so a soft-nav can replace it; content intact.
  expect(html).toContain(
    '<script type="application/ld+json" data-nifra>{"@context":"https://schema.org","@type":"Article"}</script>',
  )
})

test("renderPage head <script>: a </script> (and <!-- / ]]>) payload is breakout-escaped", async () => {
  // The XSS vector: a JSON-LD string field containing `</script>` (or `<!--`, `]]>`) would otherwise
  // close the element early and inject markup. Escaping rewrites `<`/the `]]>` `>` to a JS unicode
  // escape — byte-equivalent JSON after parse, but the raw boundary chars the HTML tokenizer scans for
  // are gone.
  const payload = '{"x":"</script><img src=x onerror=alert(1)> <!-- ]]>"}'
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      head: { script: [{ content: payload }] },
    })
  ).text()
  // The injected breakout `</script><img …>` must NOT appear — every `<` is escaped to `<`.
  expect(html).not.toContain("</script><img")
  expect(html).toContain("\\u003c/script>\\u003cimg")
  // The `<!--` open and the `]]>` close are neutralized too.
  expect(html).toContain("\\u003c!--")
  expect(html).toContain("]]\\u003e")
  // The JSON-LD slot is followed by exactly its OWN real close tag — the escaped one inside the body
  // doesn't add a second close for the slot (isolate to the slot's start to avoid counting the
  // data-global script's own legitimate `</script>`).
  const slotStart = html.indexOf('<script type="application/ld+json"')
  const slot = html.slice(slotStart)
  expect(slot.indexOf("</script>")).toBeGreaterThan(0) // a real close exists
  // No second `</script>` before the (single) real close — i.e. the body didn't smuggle one in.
  const realClose = slot.indexOf("</script>")
  expect(slot.slice(0, realClose)).not.toContain("</script>")
})

test("renderPage head <script>: a custom type is attribute-escaped", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      head: { script: [{ type: "speculationrules", content: '{"prerender":[]}' }] },
    })
  ).text()
  expect(html).toContain('<script type="speculationrules" data-nifra>{"prerender":[]}</script>')
})

// --- SEO helpers ---

test("canonical() builds a rel=canonical LinkDescriptor that renders in <head>", async () => {
  const link = canonical("https://site.com/posts/hello")
  expect(link).toEqual({ rel: "canonical", href: "https://site.com/posts/hello" })
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      head: { link: [link] },
    })
  ).text()
  expect(html).toContain('<link rel="canonical" href="https://site.com/posts/hello" data-nifra>')
})

test("openGraph() emits only the provided og:* properties, with og:type defaulting to website", async () => {
  const tags = openGraph({ title: "Nifra", image: "https://site.com/og.png" })
  // No description/url provided → not emitted; og:type defaults to website.
  expect(tags).toEqual([
    { property: "og:title", content: "Nifra" },
    { property: "og:image", content: "https://site.com/og.png" },
    { property: "og:type", content: "website" },
  ])
  // An explicit type is honored, and url/description flow through.
  const full = openGraph({ description: "d", url: "https://site.com", type: "article" })
  expect(full).toContainEqual({ property: "og:description", content: "d" })
  expect(full).toContainEqual({ property: "og:url", content: "https://site.com" })
  expect(full).toContainEqual({ property: "og:type", content: "article" })
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      head: { meta: tags },
    })
  ).text()
  expect(html).toContain('<meta property="og:title" content="Nifra" data-nifra>')
})

test("jsonLd() builds an application/ld+json script entry; head renderer escapes a </script> payload", async () => {
  const entry = jsonLd({ "@type": "Article", headline: "A </script> in the title" })
  expect(entry.type).toBe("application/ld+json")
  expect(entry.content).toBe('{"@type":"Article","headline":"A </script> in the title"}')
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [null],
      data: null,
      clientEntry: "/c.js",
      head: { script: [entry] },
    })
  ).text()
  // The `</script>` inside the JSON-LD is escaped — no early close.
  expect(html).not.toContain("</script> in the title")
  expect(html).toContain("\\u003c/script> in the title")
})

test("mergeHeads concatenates the script slot (layout chain first, page last)", () => {
  const merged = mergeHeads([
    { script: [{ content: "A" }] },
    { script: [{ content: "B" }] },
    { meta: [{ name: "x", content: "y" }] },
  ])
  expect(merged.script).toEqual([{ content: "A" }, { content: "B" }])
  // A single head returns by reference (the existing fast path) — unaffected by the new slot.
  const one = { script: [{ content: "solo" }] }
  expect(mergeHeads([one])).toBe(one)
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
      // Reject on a LATER macrotask, after the render pipeline attached its handlers. An eager
      // rejection raced Bun's unhandled-rejection reporter under full-suite load (a pre-armed no-op
      // handler covers the original promise, but not the pipeline's derived promises).
      data: {
        slow: defer(
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("boom secret detail")), 1)
          }),
        ),
      },
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
  expect(resolveMeta(undefined, { data: null, params: {}, origin: "" })).toEqual({})
  expect(resolveMeta({ title: "Static" }, { data: null, params: {}, origin: "" })).toEqual({
    title: "Static",
  })
  const meta = resolveMeta((a) => ({ title: `id=${a.params.id}` }), {
    data: null,
    params: { id: "7" },
    origin: "",
  })
  expect(meta).toEqual({ title: "id=7" })
})

test("resolveMeta: function meta builds an absolute canonical from the origin arg [#1]", () => {
  // The Item-1 contract: a `meta(({ origin }) => …)` reads the server-resolved origin to build an
  // absolute URL without threading siteUrl through loader data.
  const meta = resolveMeta(
    ({ origin, params }) => ({ link: [canonical(`${origin}/x/${params.id}`)] }),
    {
      data: null,
      params: { id: "9" },
      origin: "https://news.example.com",
    },
  )
  expect(meta.link).toEqual([{ rel: "canonical", href: "https://news.example.com/x/9" }])
})

test("MetaArgs.origin: SSR (URL.origin) and client (location.origin) resolve an IDENTICAL head — no drift [#1]", () => {
  // The drift proof: SSR derives the origin via `new URL(req.url).origin`; the client passes
  // `location.origin`. Both are the standard `URL.origin` for the SAME page URL, so a function meta
  // re-resolves byte-identical absolute tags on a soft-nav. Model both sides off one URL.
  const url = "https://news.example.com:8443/articles/hello?ref=x#frag"
  const ssrOrigin = new URL(url).origin // what createWebApp's originOf(req) computes
  const clientOrigin = new URL(url).origin // what the browser exposes as location.origin
  expect(ssrOrigin).toBe(clientOrigin) // the invariant the no-drift contract rests on
  const meta = (a: { origin: string; params: Record<string, string> }) => ({
    link: [canonical(`${a.origin}/articles/${a.params.slug}`)],
    meta: [
      ...openGraph({ url: `${a.origin}/articles/${a.params.slug}`, image: `${a.origin}/og.png` }),
    ],
  })
  const params = { slug: "hello" }
  const ssrHead = resolveMeta(meta, { data: null, params, origin: ssrOrigin })
  const clientHead = resolveMeta(meta, { data: null, params, origin: clientOrigin })
  expect(clientHead).toEqual(ssrHead) // identical resolved head → no hydration drift in <head>
  expect(ssrHead.link).toEqual([
    { rel: "canonical", href: "https://news.example.com:8443/articles/hello" },
  ])
})

test("MetaArgs.origin: a STATIC meta is origin-independent and serializes once (memo stays sound) [#1]", async () => {
  // The memo (headTagsCache, keyed by resolved-Meta identity) must stay correct now that meta is "a
  // function of origin". A STATIC meta is an object returned by reference every request — it can't
  // depend on origin, so the same identity recurs → one cache hit, serialized once. A FUNCTION meta
  // builds a fresh object per request (new identity) → always a miss → recompute, so it never serves a
  // stale/cross-origin head. Prove the static side: the SAME resolved object is reused across renders,
  // and the head renders identically regardless of which request origin the page was served from.
  const STATIC = { link: [canonical("https://site.com/about")] } as const
  // `resolveMeta` returns a static meta BY REFERENCE (the memo-key contract) — so the cache hits.
  expect(resolveMeta(STATIC, { data: null, params: {}, origin: "https://a.example" })).toBe(STATIC)
  expect(resolveMeta(STATIC, { data: null, params: {}, origin: "https://b.example" })).toBe(STATIC)
  // And the rendered <head> is the same whichever host served the page (a static meta ignores origin).
  const render = async (origin: string): Promise<string> => {
    const page = await renderPageResult({
      adapter: stub,
      chain: ["page"],
      data: null,
      clientEntry: "/c.js",
      head: resolveMeta(STATIC, { data: null, params: {}, origin }),
    })
    return page.toResponse().text()
  }
  expect(await render("https://a.example")).toContain(
    '<link rel="canonical" href="https://site.com/about" data-nifra>',
  )
  expect(await render("https://b.example")).toContain(
    '<link rel="canonical" href="https://site.com/about" data-nifra>',
  )
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

test("mergeHeads: lang/dir are nearest-wins, like title", () => {
  const merged = mergeHeads([{ lang: "en" }, { lang: "ur", dir: "rtl" }])
  expect(merged.lang).toBe("ur") // page overrides the layout default
  expect(merged.dir).toBe("rtl")
  // A page that says nothing keeps the layout's — so a site-wide `lang` in `_layout` reaches every page.
  expect(mergeHeads([{ lang: "hi" }, {}]).lang).toBe("hi")
  // Neither contributed ⇒ the keys are absent, so the shell applies its own defaults.
  expect(mergeHeads([{ title: "a" }, { title: "b" }]).lang).toBeUndefined()
  expect(mergeHeads([{ title: "a" }, { title: "b" }]).dir).toBeUndefined()
})

test("renderPage: <html> defaults to lang=en with no dir (unchanged for a monolingual app)", async () => {
  const html = await (
    await renderPage({ adapter: stub, chain: [() => {}], data: null, clientEntry: "/c.js" })
  ).text()
  expect(html).toContain('<html lang="en">')
  expect(html).not.toContain("dir=") // absent IS html's ltr default; emitting it would change every app
})

test("renderPage: head.lang/head.dir drive <html> — the only way to localize the document", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [() => {}],
      data: null,
      clientEntry: "/c.js",
      head: { title: "اردو", lang: "ur", dir: "rtl" },
    })
  ).text()
  expect(html).toContain('<html lang="ur" dir="rtl">')
})

test("renderPage: html lang is attribute-escaped (no breakout from loader-derived copy)", async () => {
  const html = await (
    await renderPage({
      adapter: stub,
      chain: [() => {}],
      data: null,
      clientEntry: "/c.js",
      head: { lang: '"><script>alert(1)</script>' },
    })
  ).text()
  expect(html).not.toContain("<script>alert(1)</script>")
  expect(html).toContain("&quot;")
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

test("renderPage streams for an adapter without renderToString", async () => {
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
