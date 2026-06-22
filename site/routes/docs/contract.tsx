import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Framework contract",
  "The one-page contract: LoaderContext shape, loader/action/meta/head signatures, the client↔server boundary, and the build-output contract — every signature verified against the source.",
)

const LOADER_CTX = `// The single context object passed to every loader AND action (@nifrajs/web).
interface LoaderContext {
  params:  Record<string, string>  // matched route params (:id, *path)
  request: Request                 // the standard Web Request — read headers/body/URL off it
  api:     unknown                 // the in-process backend client createWebApp was given
  env:     unknown                 // platform bindings forwarded from c.env (Workers KV/D1/…)
  draft:   boolean                 // true only when a valid draft cookie is present (draftSecret set)
}

// api + env are typed per-route via @nifrajs/client's LoaderArgs<Api, Env>; the agnostic core
// keeps them \`unknown\`. Branch on \`draft\` to load unpublished content for preview/editors.`

const SIGNATURES = `// routes/users/[id].tsx — a route module's full contract (every export optional but \`default\`).
// doc-check: skip — full-contract sketch; ctx.api's routes and meta's loader-data shape come from
// the reader's own backend type, so it can't compile standalone (see the typed examples elsewhere).
import type { LoaderContext } from "@nifrajs/web"

// GET → data for the page. Runs in-process on the server during SSR (no HTTP hop).
export async function loader(ctx: LoaderContext) {
  return { user: await ctx.api.users.get({ id: ctx.params.id }) }
}

// POST → a mutation. Same context. Return a Response (e.g. a redirect — passed straight
// through) OR data, which reaches the component as \`actionData\`.
export async function action(ctx: LoaderContext) {
  const form = await ctx.request.formData()
  return { ok: true }
}

// Static OR a function of { data, params, origin }. Static meta is serialized once; function meta
// recomputes per request (its content can vary with loader data). \`origin\` is the request's
// scheme+host (server-resolved, matches the client's location.origin) — use it for ABSOLUTE
// canonical / og:url / og:image URLs without threading siteUrl through loader data.
export const meta = ({ data, params, origin }) => ({
  title: \`User \${data.user.name}\`,
  meta: [{ name: "description", content: data.user.bio }],
  link: [{ rel: "canonical", href: \`\${origin}/users/\${params.id}\` }],
})

export const hydrate = false   // opt out of full-document hydration (static / island pages)
export default function User(props) { /* props.data, props.actionData, props.params */ }`

const HEAD_MERGE = `// routes/_layout.tsx — a layout can export \`meta\` too. Its tags are SITEWIDE: they land in
// the <head> of every page below it — the home for hreflang / preconnect / a section <title>.
export const meta = {
  link: [
    { rel: "preconnect", href: "https://cdn.example.com", crossorigin: "anonymous" },
    { rel: "alternate", hreflang: "es", href: "https://example.com/es" },
  ],
  title: "Docs",   // section default — a child page's title overrides it
}

// The route's final <head> = its LAYOUT CHAIN's meta merged with the page's:
//   • title (and other scalars): NEAREST-WINS — page overrides inner layout overrides outer.
//     An undefined page title keeps the layout's.
//   • meta / link arrays: CONCATENATED outermost-layout → … → page (so the page's canonical
//     comes after the layout's links).
// <link> attributes are typed (LinkDescriptor: a partial like { rel, href, hreflang } is assignable),
// name-validated (any letter/digit/hyphen name) and value-escaped against XSS — so
// rel/href/hreflang/crossorigin/media/sizes/as/integrity/fetchpriority/… all survive. A boolean
// attribute (e.g. \`disabled: true\`) renders bare; \`false\`/\`undefined\` is omitted.`

const BOUNDARY = `// What runs WHERE:
//
//   SERVER (Bun / edge)            CLIENT (browser)
//   ─────────────────────          ──────────────────────────
//   loader / action                event handlers, useState/effects
//   meta / head resolution         soft-nav re-fetch of loader data
//   SSR of the layout chain        hydration + Fast Refresh (dev)
//   backend (api, env, draft)      —
//
// The client gets the loader's RETURN VALUE (serialized into the document), never the loader
// itself, the api, or env. So:
//  1. Never import server-only modules (Bun, a DB client, secrets) at the top level of a route
//     file — the bundler pulls it into the client chunk and it crashes / leaks. (The build now
//     FAILS with a named error if a \`node:\` built-in reaches a client chunk — see below.)
//  2. A client soft-nav re-runs the loader over the network (X-Nifra-Data) and re-merges the
//     same layout-chain head, so sitewide tags persist across navigation — no page-only flash.`

const DUAL_API = `// TWO ways to handle a request — pick by who is calling.
import type { LoaderContext } from "@nifrajs/web"

// (1) A page's own data + mutations → route exports. A PUBLIC POST is a route ACTION
//     (routes/contact.tsx) — the browser POSTs the route's own URL, nifra runs \`action\`:
export async function action(ctx: LoaderContext) {
  const form = await ctx.request.formData()        // the browser POSTed this route
  return { ok: true, body: String(form.get("body")) } // → props.actionData on re-render
}

// (2) ctx.api is the IN-PROCESS backend client (the inProcessClient(server) the app was given).
//     It is LOADERS-ONLY: the SSR backend registers GET handlers, so a .post() to ctx.api 405s.
export async function loader(ctx: LoaderContext) {
  // ✅ a GET in-process — no HTTP hop. (A .post() to ctx.api would 405; write an \`action\` instead.)
  return { id: ctx.params.id }
}

// Rule of thumb: data INTO a page → loader + ctx.api (GET). A mutation FROM the browser
// (a form/fetch POST) → an \`action\` export on the route. Don't \`inProcessClient(api).post()\`.`

const PARAM_404 = `// routes/users/[id].tsx — plain SSR runs the loader for ANY :id value. \`fallback: "404"\`
// only takes effect under prerender/CDN, so on on-demand SSR you MUST guard and 404 yourself.
import type { LoaderContext } from "@nifrajs/web"

declare function lookupUser(id: string): Promise<{ id: string } | null>

export async function loader(ctx: LoaderContext) {
  // ctx.params.id is \`string | undefined\` (an optional segment) — default it before the lookup.
  const user = await lookupUser(ctx.params.id ?? "")
  if (!user) {
    // CONTROL FLOW: a thrown Response is an INTENTIONAL HTTP response — it propagates untouched
    // (no _error boundary, no 500). This is how you 404 a missing record.
    throw new Response("Not Found", { status: 404 })
  }
  return { user }
}

declare function lookupUser(id: string): Promise<{ name: string } | null>

// The throw contract, stated once:
//   • throw a Response  → that exact HTTP response is sent (404 / redirect() / 403 / …). Control flow.
//   • throw an Error    → renders the nearest _error boundary if one exists, else a 500. A bug.
// So NEVER \`throw new Error("not found")\` to mean 404 — that is a 500. Throw a 404 Response.`

const PUBLIC_ENV = `// process.env in the CLIENT bundle is compiled at build time:
//   process.env             → ({})          (a bare read won't crash hydration)
//   process.env.NODE_ENV    → "production"  (the build mode — frameworks' prod/dev branch)
//   process.env.SECRET_KEY  → undefined     (unprefixed → never exposed; no secret leak)
//   process.env.PUBLIC_API_URL → "https://api.example.com"  (PUBLIC_-prefixed → baked in by value)
//
// So to ship a value to the browser, give it a PUBLIC_ prefix in the BUILD environment:
//   PUBLIC_API_URL=https://api.example.com  bun run build
// then read process.env.PUBLIC_API_URL in app code — it becomes a string literal after the build.
import { buildClient } from "@nifrajs/web/build"

// Override the prefix (or disable auto-exposure) via buildClient:
await buildClient({
  routesDir: "./routes",
  outDir: "./dist",
  clientModule: "@nifrajs/web-react/client",
  publicEnvPrefix: "NIFRA_PUBLIC_", // default "PUBLIC_"; "" disables auto-exposure entirely
})`

const STATIC_EMIT = `// build.ts — emit static HTML for opted-in routes. prerenderRoutes + cloudflarePagesRoutes
// are PUBLIC (exported from @nifrajs/web/build) — no need to boot a server and curl it.
import { buildClient, prerenderRoutes, cloudflarePagesRoutes } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"

// 1. Build the client bundle first (so the app references the hashed entry).
await buildClient({ routesDir: "./routes", outDir: "./dist", clientModule: "@nifrajs/web-react/client" })

// 2. Drive the app's own fetch to render each opted-in route → dist/<path>/index.html + _data.json.
//    Static routes opt in with \`export const prerender = true\`; dynamic routes enumerate concrete
//    params with \`export const getStaticPaths\` (+ a \`fallback: "ssr" | "404"\`).
const { app } = await import("./server")
const { prerendered } = await prerenderRoutes({
  app,                                       // the built createWebApp (a { fetch } is enough)
  routes: discoverRoutes("./routes").routes,
  outDir: "./dist",
})

// 3. Hybrid deploy: a Cloudflare Pages _routes.json that serves the prerendered HTML + _data.json
//    from the CDN and falls everything else through to the SSR worker.
const paths = prerendered.map((p) => p.path)
await Bun.write("./dist/_routes.json", JSON.stringify(cloudflarePagesRoutes({ prerendered: paths })))`

const SEO_EXAMPLE = `// routes/articles/[slug].tsx — a complete SEO head: canonical + Open Graph + Twitter + JSON-LD,
// with ABSOLUTE URLs built from \`origin\`. The three helpers (canonical/openGraph/jsonLd) are public
// exports of @nifrajs/web; \`origin\` is the third MetaArgs field (after data + params).
import { canonical, jsonLd, openGraph, type MetaArgs } from "@nifrajs/web"

// CAVEAT: meta() runs in BOTH SSR and client navigation, so it has NO server env — never read
// \`process.env\` or the request here. The framework injects \`origin\` (the site's scheme+host, e.g.
// "https://news.example.com") server-side from the request AND on the client from location.origin, so
// the two match and an absolute og:url/canonical/og:image never drifts between SSR and a soft-nav. For
// anything else server-only (an API base, a CDN host), thread it through the LOADER, not meta().
export const meta = ({ data, params, origin }: MetaArgs) => {
  const article = data as { title: string; summary: string; image: string; published: string }
  const url = \`\${origin}/articles/\${params.slug}\`        // absolute, from the injected origin
  const image = \`\${origin}\${article.image}\`              // og:image MUST be absolute for crawlers
  return {
    title: article.title,
    meta: [
      { name: "description", content: article.summary },
      // og:* — openGraph emits only the props you pass (+ og:type, here "article").
      ...openGraph({
        title: article.title,
        description: article.summary,
        url,
        image,
        type: "article",
      }),
      // twitter:* — a large-image summary card sharing the same absolute image.
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: article.title },
      { name: "twitter:description", content: article.summary },
      { name: "twitter:image", content: image },
    ],
    link: [canonical(url)],                              // <link rel="canonical"> — the authoritative URL
    // JSON-LD structured data — escaped for safe <script> embedding by the head renderer.
    script: [
      jsonLd({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: article.title,
        image,
        datePublished: article.published,
        mainEntityOfPage: url,
      }),
    ],
  }
}`

const BUILD_OUTPUT = `// \`nifra build\` → buildClient (Bun.build) writes dist/ + manifest.json. The contract:
{
  "entry": "/assets/_nifra-entry-HASH.js",        // the bootstrap module script
  "assets": ["/assets/…"],                          // every emitted chunk URL
  "routes": { "users/[id]": ["/assets/_layout-H.js", "/assets/_slug_-H.js"] },
  "css": ["/assets/app-H.css"],                     // aggregate stylesheets (fallback)
  "routeStyles": { "users/[id]": ["/assets/_layout-H.css"] }  // per-route CSS (chain only)
}

// Invariants worth knowing:
//  • Chunk names are URL-PATH-SAFE. A dynamic-route file [slug].tsx would emit \`[slug]-H.js\`,
//    whose [ ] make a static server 400 the request. The build renames it (\`[slug]\` → \`_slug_\`)
//    and rewrites every reference, so the lazy import resolves and the route hydrates.
//  • \`process.env\` is compiled away. \`process.env\` → \`({})\` and \`process.env.NODE_ENV\` → the
//    build mode; every other \`process.env.X\` becomes undefined — EXCEPT names you opt in with the
//    PUBLIC_ prefix (Vite/Next convention), which are baked in with their value (see below). No
//    \`process is not defined\` crash, and no unprefixed (secret) env leaking into the client bundle.
//  • A \`node:\` built-in in the CLIENT bundle FAILS the build with a named error (move it behind a
//    loader/action — server-only). It builds via a browser polyfill otherwise, then breaks at runtime.
//  • Assets are content-hashed + immutable. Serve /assets/* with a long-lived cache header.`

export default function Contract() {
  return (
    <div className="prose">
      <h1 className="page">Framework contract</h1>
      <p className="lead">
        Everything you'd otherwise read the source to learn, on one page: the{" "}
        <code>LoaderContext</code> shape, the loader / action / meta / head signatures, what runs on
        the server vs the client, the two ways to handle a request, the dynamic-route 404 rule, and
        the build-output contract. Every signature here is verified against the{" "}
        <code>@nifrajs/web</code> source.
      </p>

      <h2>LoaderContext</h2>
      <p>
        One context object is passed to every <code>loader</code> and every <code>action</code>. The
        same five fields, always — <code>params</code>, <code>request</code>, <code>api</code>,{" "}
        <code>env</code>, and <code>draft</code>.
      </p>
      <CodeBlock code={LOADER_CTX} />

      <h2>Loader, action &amp; meta signatures</h2>
      <p>
        A route module co-locates its data, mutation, head, and view. Only the{" "}
        <code>default</code> export (the component) is required; <code>loader</code>,{" "}
        <code>action</code>, <code>meta</code>, and <code>hydrate</code> are all optional. A{" "}
        <code>loader</code> runs on <strong>GET</strong> and feeds <code>props.data</code>; an{" "}
        <code>action</code> runs on <strong>POST</strong> and feeds <code>props.actionData</code>.
      </p>
      <CodeBlock code={SIGNATURES} />
      <blockquote>
        [!NOTE] An <code>action</code> may return a <code>Response</code> (a <code>redirect()</code>,
        say) — it's passed through untouched. Any other return is serialized as{" "}
        <code>actionData</code>.
      </blockquote>

      <h2>Two ways to handle a request</h2>
      <p>
        A page's data comes from a <code>loader</code> calling the <strong>in-process backend</strong>{" "}
        (<code>ctx.api</code>) — but that backend is <strong>loaders-only</strong>: it registers{" "}
        <code>GET</code> handlers, so a <code>.post()</code> to <code>ctx.api</code> answers{" "}
        <strong>405</strong>. A <strong>public POST</strong> (a browser form or <code>fetch</code>) is
        a route <strong>action</strong> export, not an <code>inProcessClient(backend).post()</code>{" "}
        call.
      </p>
      <CodeBlock code={DUAL_API} />

      <h2>Dynamic routes &amp; the 404 / control-flow rule</h2>
      <p>
        A <code>[param]</code> route's loader runs for <em>any</em> value on plain SSR —{" "}
        <code>getStaticPaths</code>'s <code>fallback: "404"</code> is enforced only by the prerender /
        CDN layer, never by the on-demand worker. So a loader that can't find its record{" "}
        <strong>must</strong> 404 itself. The mechanism is the throw contract:
      </p>
      <CodeBlock code={PARAM_404} />
      <p>
        <strong>Throwing a <code>Response</code> is control flow</strong> — that exact HTTP response
        (a 404, a <code>redirect()</code>, a 403) is sent untouched, bypassing the{" "}
        <code>_error</code> boundary. <strong>Throwing an <code>Error</code> is a fault</strong> — it
        renders the nearest <code>_error</code> boundary (or a 500 if there is none). Never throw an{" "}
        <code>Error</code> to signal a 404.
      </p>

      <h2>Meta &amp; head rendering rules</h2>
      <p>
        A route's <code>&lt;head&gt;</code> is its <strong>layout chain's</strong> head merged with
        the page's — so a <code>_layout.tsx</code> can export <code>meta</code> to put sitewide tags
        (<code>hreflang</code>, <code>preconnect</code>, a section <code>&lt;title&gt;</code>) on every
        page below it.
      </p>
      <CodeBlock code={HEAD_MERGE} />
      <p>
        The merge is <strong>nearest-wins</strong> for scalars (the page's <code>title</code> beats an
        inner layout's, which beats an outer one) and <strong>concatenated</strong> for the{" "}
        <code>meta</code> / <code>link</code> arrays (outermost layout first, page last). A{" "}
        <code>link</code> entry is a typed <code>LinkDescriptor</code> — a partial like{" "}
        <code>{"{ rel, href, hreflang }"}</code> is assignable, custom / <code>data-*</code> attrs
        pass through, and every <code>&lt;link&gt;</code> attribute with a normal name —{" "}
        <code>rel</code>, <code>href</code>, <code>hreflang</code>, <code>crossorigin</code>,{" "}
        <code>media</code>, <code>sizes</code>, <code>type</code>, <code>as</code>,{" "}
        <code>integrity</code>, <code>referrerpolicy</code>, <code>fetchpriority</code>,{" "}
        <code>imagesrcset</code> — survives into the SSR'd tag; values are HTML-escaped against XSS.
      </p>

      <h2>SEO: Open Graph, Twitter cards &amp; JSON-LD</h2>
      <p>
        A route's <code>meta</code> emits the full social / structured-data head with three public
        helpers — <code>canonical()</code>, <code>openGraph()</code>, and <code>jsonLd()</code> — and
        builds <strong>absolute</strong> URLs from the <code>origin</code> argument. Because{" "}
        <code>meta()</code> runs in <strong>both</strong> SSR and client navigation it has{" "}
        <strong>no server env</strong>: never read <code>process.env</code> or the request inside it.
        The framework injects <code>origin</code> (the site's scheme + host, e.g.{" "}
        <code>https://news.example.com</code>) from the request on the server and from{" "}
        <code>location.origin</code> on the client, so the two match and an absolute{" "}
        <code>og:url</code> / <code>canonical</code> / <code>og:image</code> never drifts between the
        server-rendered <code>&lt;head&gt;</code> and a soft-nav. Anything else server-only (an API
        base, a CDN host) belongs in the <code>loader</code>, not <code>meta()</code>.
      </p>
      <CodeBlock code={SEO_EXAMPLE} />
      <blockquote>
        [!NOTE] <code>og:image</code> (and the Twitter image) <strong>must be absolute</strong> for
        crawlers — build it from <code>origin</code>. <code>openGraph()</code> emits only the
        properties you pass (plus <code>og:type</code>); <code>jsonLd()</code>'s payload is escaped for
        safe <code>&lt;script&gt;</code> embedding by the head renderer.
      </blockquote>

      <h2>The client ↔ server boundary</h2>
      <p>
        Loaders, actions, and head resolution run on the server. The client receives the loader's{" "}
        <em>return value</em> (serialized into the document), never the loader, the <code>api</code>,
        or <code>env</code>. Keep server-only imports out of a route file's top level.
      </p>
      <CodeBlock code={BOUNDARY} />

      <h2>The build-output contract</h2>
      <p>
        <code>nifra build</code> emits a content-hashed <code>dist/</code> plus a{" "}
        <code>manifest.json</code> you hand to <code>createWebApp</code> (<code>entry</code>,{" "}
        <code>routes</code> for per-route preload, <code>css</code> + <code>routeStyles</code> for{" "}
        <code>&lt;link&gt;</code> injection).
      </p>
      <CodeBlock code={BUILD_OUTPUT} />

      <h2>Public env in the client bundle</h2>
      <p>
        <code>process.env</code> is compiled away in the browser bundle, so a bare read can't crash
        hydration and an unprefixed (secret) var resolves to <code>undefined</code> — it never reaches
        the client. To expose a value, give it the <code>PUBLIC_</code> prefix (the Vite / Next
        convention) in the build environment and it's baked in by value. The prefix is overridable via{" "}
        <code>buildClient</code>'s <code>publicEnvPrefix</code> (<code>""</code> disables it).
      </p>
      <CodeBlock code={PUBLIC_ENV} />

      <h2>Static emit (prerender)</h2>
      <p>
        Opt a static route into SSG with <code>export const prerender = true</code> (or a dynamic
        route with <code>export const getStaticPaths</code>), then call <code>prerenderRoutes</code> —{" "}
        a <strong>public</strong> export of <code>@nifrajs/web/build</code>. It drives the app's own{" "}
        <code>fetch</code> to write <code>index.html</code> + <code>_data.json</code> per route;{" "}
        <code>cloudflarePagesRoutes</code> emits the <code>_routes.json</code> for a hybrid CDN +
        worker deploy. No need to boot a server and curl it.
      </p>
      <CodeBlock code={STATIC_EMIT} />

      <p>
        See <a href="/docs/rendering">SSG &amp; ISR</a> for prerendering, <a href="/docs/dev">Dev &amp; HMR</a> for the
        two dev loops and the <code>--port</code> flag, and <a href="/docs/data">Loaders &amp; actions</a> for the
        data layer in depth.
      </p>
    </div>
  )
}
