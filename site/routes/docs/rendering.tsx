import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Rendering: SSG & ISR",
  "Prerender static routes, enumerate dynamic ones, and cache rendered pages with stale-while-revalidate — on every runtime including the edge.",
)

const PRERENDER = `// A static route: render it to a static index.html at build time.
export const prerender = true

export async function loader({ api }: LoaderArgs<typeof app>) {
  return { posts: (await api.posts.get()).data } // runs at BUILD (no per-request secrets)
}`

const STATIC_PATHS = `// A dynamic route (/posts/:slug): enumerate which pages to prerender.
export async function getStaticPaths(): Promise<StaticPaths> {
  const slugs = await loadAllSlugs()
  return {
    paths: slugs.map((slug) => ({ params: { slug } })),
    fallback: "ssr", // an unlisted slug renders on-demand (the worker); "404" = only these exist
  }
}`

const BUILD = `// build.ts — buildClient, then prerender opted-in routes to static HTML.
import { buildClient, prerenderRoutes, cloudflarePagesRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

await buildClient({ routesDir: "./routes", outDir: "./dist", clientModule: "@nifrajs/web-react/client" })
const { app } = await import("./server")
const { prerendered } = await prerenderRoutes({
  app,
  routes: discoverRoutes("./routes").routes,
  outDir: "./dist", // writes <path>/index.html + <path>/_data.json per prerendered route
})

// Hybrid deploy (Cloudflare Pages): serve prerendered HTML + _data.json from the CDN; everything
// else falls through to the SSR worker.
const paths = prerendered.map((p) => p.path)
Bun.write("./dist/_routes.json", JSON.stringify(cloudflarePagesRoutes({ prerendered: paths })))`

const ISR = `// server.ts — wrap the app with Incremental Static Regeneration.
import { createWebApp, withISR, MemoryCacheStore } from "@nifrajs/web"

const app = createWebApp({ adapter, manifest, clientEntry, api })
const store = new MemoryCacheStore() // dev / single-instance only

// GET text/html responses are cached + served stale-while-revalidate. Default freshness 60s.
const isr = withISR(app, { store, revalidate: 60, now: () => Date.now() })
Bun.serve({ fetch: (req) => isr(req) })`

const REVALIDATE = `// A per-route freshness window (seconds) — overrides the wrapper default.
export const revalidate = 300 // this page is fresh for 5 min, then regenerates on the next hit`

const KV = `// worker.ts — production uses a SHARED store so the cache + purges hold across instances.
import { withISR, KVCacheStore, revalidateEndpoint } from "@nifrajs/web"

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const store = new KVCacheStore(env.ISR_CACHE, { expirationTtl: 86_400 }) // Workers KV
    if (new URL(req.url).pathname === "/__nifra/revalidate") {
      return revalidateEndpoint({ store, secret: env.REVALIDATE_SECRET })(req)
    }
    const isr = withISR(app, { store, revalidate: 60, now: () => Date.now() })
    // waitUntil keeps the worker alive while a stale page regenerates behind the response.
    return isr(req, { env, waitUntil: (p) => ctx.waitUntil(p) })
  },
}`

const PURGE = `# On-demand revalidation: purge a path so the next request re-renders it.
curl -X POST 'https://example.com/__nifra/revalidate?path=/posts/hello' \\
  -H 'x-nifra-revalidate-token: $REVALIDATE_SECRET'
# → { "revalidated": "/posts/hello" }   (the token is checked in constant time)`

const DRAFT = `// 1. A route you gate yourself flips draft mode on for the editor.
import { enableDraft, disableDraft } from "@nifrajs/web"

app.get("/api/preview", async (c) => {
  if (c.query.token !== env.PREVIEW_TOKEN) return new Response("nope", { status: 401 })
  await enableDraft(c, env.DRAFT_SECRET) // signed, HttpOnly cookie
  return redirect(String(c.query.to ?? "/"))
})
app.get("/api/preview/exit", (c) => (disableDraft(c), redirect("/")))

// 2. Loaders branch on ctx.draft to load unpublished content.
export async function loader({ api, draft }: LoaderArgs<typeof app>) {
  return { post: (await api.posts.get({ query: { slug, includeDrafts: draft } })).data }
}

// 3. Wire the SAME secret so loaders see ctx.draft + editors bypass the ISR cache.
createWebApp({ adapter, manifest, clientEntry, api, draftSecret: env.DRAFT_SECRET })
withISR(app, { store, revalidate: 60, now: () => Date.now(), draftSecret: env.DRAFT_SECRET })`

const FONTS = `// fonts.css — a CLS-safe @font-face for a self-hosted font (the pipeline bundles + hashes it).
import { fontFace } from "@nifrajs/web"
export default fontFace({
  family: "Inter",
  src: [{ url: "/fonts/inter-var.woff2" }], // self-host it — never hotlink a CDN
  weight: "100 900",                        // variable font
  sizeAdjust: "100.06%", ascentOverride: "90%", // optional: stop fallback->web-font layout shift
})

// a root layout — preload the file so it downloads WITH the document (not after CSS parse):
import { fontPreload } from "@nifrajs/web"
export const meta = { link: [fontPreload({ href: "/fonts/inter-var.woff2" })] }`

export default function Rendering() {
  return (
    <div className="prose">
      <h1 className="page">Rendering: SSG &amp; ISR</h1>
      <p className="lead">
        Nifra renders on one framework-agnostic seam, so the same app can be server-rendered per
        request (the default), <b>prerendered</b> to static files at build (SSG), or cached and served{" "}
        <b>stale-while-revalidate</b> (ISR) — and every strategy works on Bun, Node, Deno, <b>and</b>{" "}
        the edge.
      </p>

      <h2>SSG — prerender at build</h2>
      <p>
        Opt a static route into prerendering with <code>export const prerender = true</code>. Its
        loader runs at <i>build</i> time (build-safe data only — no per-request cookies or secrets),
        and the route is baked to a static <code>index.html</code> plus a <code>_data.json</code> the
        client fetches on soft-navigation.
      </p>
      <CodeBlock code={PRERENDER} />
      <p>
        For dynamic routes (<code>/posts/:slug</code>), enumerate the param sets with{" "}
        <code>getStaticPaths</code>. <code>fallback</code> decides what happens to a path you didn't
        list: <code>"ssr"</code> renders it on-demand (the natural hybrid), <code>"404"</code> means
        only the listed paths exist.
      </p>
      <CodeBlock code={STATIC_PATHS} />
      <p>
        At build, <code>prerenderRoutes</code> drives the app's own <code>fetch</code> to render each
        page to bytes — agnostic, because it sits above the adapter seam. The output is turnkey for a
        hybrid CDN deploy: static files served by the edge, everything else falling through to the SSR
        worker.
      </p>
      <CodeBlock code={BUILD} />

      <h2>ISR — cache with stale-while-revalidate</h2>
      <p>
        When data changes but not on every request, ISR gives static-like speed with background
        freshness. <code>withISR</code> wraps the app: a cacheable page (a <code>GET</code> document,{" "}
        <code>200</code>, <code>text/html</code>) is served from the store when fresh, served{" "}
        <b>stale while a fresh copy regenerates behind it</b>, or rendered + stored on a miss.
        Regeneration is single-flight per key, so a hot stale page regenerates once. Every response
        carries an <code>x-nifra-isr: hit | stale | miss</code> header.
      </p>
      <CodeBlock code={ISR} />
      <p>
        Set a route's freshness with <code>export const revalidate</code> (seconds) — nifra emits it as
        the <code>x-nifra-isr-revalidate</code> header, which the wrapper reads to set that page's TTL.
      </p>
      <CodeBlock code={REVALIDATE} />

      <h2>A shared store for production</h2>
      <p>
        <code>MemoryCacheStore</code> is per-instance — fine for dev, but it refuses to run under{" "}
        <code>NODE_ENV=production</code> unless you opt in, because the cache and on-demand purges
        wouldn't propagate across instances. In production use a shared, durable store. On Cloudflare,{" "}
        <code>KVCacheStore</code> wraps a Workers KV namespace; any backend that fits the small{" "}
        <code>CacheStore</code> interface (Redis, the Cache API) works too. Every read is validated
        before it's trusted, so a corrupt or version-skewed entry is treated as a miss, not served
        broken.
      </p>
      <CodeBlock code={KV} />

      <h2>On-demand revalidation</h2>
      <p>
        Purge a path the moment its data changes (a CMS webhook, an admin action) with{" "}
        <code>revalidateEndpoint</code> — a <code>POST</code> that drops the cached entry so the next
        request re-renders. The token is compared in constant time; a wrong or missing token is{" "}
        <code>401</code>, a missing or relative path is <code>400</code>.
      </p>
      <CodeBlock code={PURGE} />

      <h2>Draft / preview mode</h2>
      <p>
        Let an editor preview unpublished content without exposing it to the world.{" "}
        <code>enableDraft(c, secret)</code> sets a <b>signed, HttpOnly</b> cookie (gate the route
        yourself — behind a login or a token, like Next's <code>draftMode()</code>); loaders then read{" "}
        <code>ctx.draft</code> to fetch drafts, and <code>withISR</code> <b>bypasses the cache</b> for
        that request — so the editor always renders fresh and a draft is never written to the public
        cache. Pass the same <code>draftSecret</code> to <code>createWebApp</code> and{" "}
        <code>withISR</code>; a forged or tampered cookie fails the constant-time signature check.
      </p>
      <CodeBlock code={DRAFT} />

      <h2>Fonts</h2>
      <p>
        Self-host your fonts (hotlinking a CDN is a privacy leak and an extra connection).{" "}
        <code>fontFace()</code> generates a <b>CLS-safe</b> <code>@font-face</code> — it defaults to{" "}
        <code>font-display: swap</code> and supports the <code>size-adjust</code> /{" "}
        <code>ascent-override</code> metric overrides that stop the fallback→web-font layout shift; put
        it in a CSS file your app imports. <code>fontPreload()</code> returns a{" "}
        <code>&lt;link rel="preload" as="font"&gt;</code> for a layout's <code>meta.link</code>, so the
        file downloads with the document instead of waiting on CSS parse.
      </p>
      <CodeBlock code={FONTS} />

      <h2>Which one?</h2>
      <p>
        Content that's the same for everyone and changes rarely → <b>SSG</b>. Content that changes
        occasionally and can tolerate seconds-to-minutes of staleness → <b>ISR</b>. Per-request or
        per-user content → plain <b>SSR</b> (the default). You can mix all three in one app, route by
        route.
      </p>
    </div>
  )
}
