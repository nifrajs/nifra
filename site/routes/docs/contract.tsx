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

// Static OR a function of { data, params }. Static meta is serialized once; function meta
// recomputes per request (its content can vary with loader data).
export const meta = ({ data, params }) => ({
  title: \`User \${data.user.name}\`,
  meta: [{ name: "description", content: data.user.bio }],
  link: [{ rel: "canonical", href: \`/users/\${params.id}\` }],
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
// <link> attributes are name-validated (any letter/digit/hyphen name) and value-escaped against
// XSS — so rel/href/hreflang/crossorigin/media/sizes/as/integrity/fetchpriority/… all survive.`

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
//     file — the bundler pulls it into the client chunk and it crashes / leaks.
//  2. A client soft-nav re-runs the loader over the network (X-Nifra-Data) and re-merges the
//     same layout-chain head, so sitewide tags persist across navigation — no page-only flash.`

const BUILD_OUTPUT = `// \`nifra build\` → buildClient (Bun.build) writes dist/ + manifest.json. The contract:
{
  "entry": "/assets/_nifra-entry-HASH.js",        // the bootstrap module script
  "assets": ["/assets/…"],                          // every emitted chunk URL
  "routes": { "users/[id]": ["/assets/_layout-H.js", "/assets/_slug_-H.js"] },
  "css": ["/assets/app-H.css"],                     // aggregate stylesheets (fallback)
  "routeStyles": { "users/[id]": ["/assets/_layout-H.css"] }  // per-route CSS (chain only)
}

// Three invariants worth knowing:
//  • Chunk names are URL-PATH-SAFE. A dynamic-route file [slug].tsx would emit \`[slug]-H.js\`,
//    whose [ ] make a static server 400 the request. The build renames it (\`[slug]\` → \`_slug_\`)
//    and rewrites every reference, so the lazy import resolves and the route hydrates.
//  • \`process.env\` is compiled away. \`process.env\` → \`({})\` and \`process.env.NODE_ENV\` → the
//    build mode; every other \`process.env.X\` becomes undefined. No \`process is not defined\`
//    crash in the browser, no server env leaking into the client bundle.
//  • Assets are content-hashed + immutable. Serve /assets/* with a long-lived cache header.`

export default function Contract() {
  return (
    <div className="prose">
      <h1 className="page">Framework contract</h1>
      <p className="lead">
        Everything you'd otherwise read the source to learn, on one page: the{" "}
        <code>LoaderContext</code> shape, the loader / action / meta / head signatures, what runs on
        the server vs the client, and the build-output contract. Every signature here is verified
        against the <code>@nifrajs/web</code> source.
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
        <code>meta</code> / <code>link</code> arrays (outermost layout first, page last). Every{" "}
        <code>&lt;link&gt;</code> attribute with a normal name — <code>rel</code>, <code>href</code>,{" "}
        <code>hreflang</code>, <code>crossorigin</code>, <code>media</code>, <code>sizes</code>,{" "}
        <code>type</code>, <code>as</code>, <code>integrity</code>, <code>referrerpolicy</code>,{" "}
        <code>fetchpriority</code>, <code>imagesrcset</code> — survives into the SSR'd tag; values are
        HTML-escaped against XSS.
      </p>

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
      <p>
        See <a href="/docs/rendering">SSG &amp; ISR</a> for prerendering, <a href="/docs/dev">Dev &amp; HMR</a> for the
        two dev loops and the <code>--port</code> flag, and <a href="/docs/data">Loaders &amp; actions</a> for the
        data layer in depth.
      </p>
    </div>
  )
}
