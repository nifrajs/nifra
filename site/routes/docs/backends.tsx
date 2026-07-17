import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Backends & API (dev and prod)",
  "How a Nifra backend reaches your app: inProcessClient feeds ctx.api to loaders, and createWebApp auto-mounts the backend over HTTP at /api/* — in `nifra dev` and production alike, no hand-dispatch.",
)

// The backend: an @nifrajs/core server defining its routes at the FULL /api/... path (the mount does
// no path stripping). The handler returns a plain object → JSON; `c.req` is the Web Request.
const BACKEND = `// backend.ts — a normal @nifrajs/core server. Routes live at the full /api/... path.
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const backend = server()
  .post("/api/sync", { body: t.object({ cursor: t.string() }) }, async (c) => {
    // validated body; runs the same whether called in-process (a loader) or over HTTP (a client fetch)
    return { applied: 12, nextCursor: c.body.cursor }
  })
  .get("/api/me", (c) => ({ id: c.cookies.session ?? null }))`

// inProcessClient(backend) is BOTH the typed loader client (ctx.api) AND the mount target: createWebApp
// auto-serves it at apiPrefix (default /api). One backend, two call paths, zero hand-dispatch.
const WIRE = `// server.ts (prod) — createWebApp serves pages AND auto-mounts the backend at /api/*.
import { inProcessClient } from "@nifrajs/client"
import { createWebApp } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend"
import { clientEntry, manifest } from "./server-manifest"

export const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry,
  api: inProcessClient(backend), // → ctx.api in loaders/actions AND auto-mounted at /api/*
  // apiPrefix: "/api",          // the default; pass "" to disable the HTTP mount (pages only)
})

// Bun: Bun.serve({ fetch: app.fetch }). No \`if (pathname.startsWith("/api/")) …\` branch needed —
// POST /api/sync, GET /api/me, etc. are dispatched to the backend BEFORE the page router sees them.`

// The loader path: ctx.api is the SAME inProcessClient, called in-process during SSR (no HTTP hop).
const LOADER = `// routes/index.tsx — a loader calls the backend IN-PROCESS via ctx.api (no network).
import type { LoaderContext } from "@nifrajs/web"

export async function loader(ctx: LoaderContext) {
  const api = ctx.api as { me: { get(): Promise<{ data: { id: string | null } }> } }
  const res = await api.me.get() // in-process: full validation/middleware, no HTTP round-trip
  return { me: res.data }
}`

// The browser path: the client calls the SAME /api/* routes over HTTP — now that they're mounted.
const CLIENT = `// A browser island / client component hits the mounted HTTP routes with the typed client.
import { client } from "@nifrajs/client"
import type { backend } from "./backend"

const api = client<typeof backend>("") // same-origin: /api/sync is served by createWebApp's mount
export async function runSync(cursor: string) {
  const { data, error } = await api.api.sync.post({ cursor })
  return error ? { applied: 0 } : data
}`

// Composition is prefix-LESS. `.merge()` copies each group's routes at the paths they were DEFINED into
// one shared path space - no base path is added, nothing is stripped - and `c.req.url` inside a merged
// (or /api-mounted) route is the ORIGINAL request URL, full path included. So groups own their absolute
// paths (`/api/listings`), and the mount only SELECTS which requests reach the backend; it never rewrites.
const COMPOSE = `// backend.ts - compose domains with .merge(). Each group owns its FULL absolute paths.
import { server } from "@nifrajs/core/server"

const listings = server().get("/api/listings", (c) => {
  // c.req.url is the ORIGINAL request URL - .merge() and the /api mount never strip the prefix.
  const path = new URL(c.req.url).pathname // GET /api/listings  ->  "/api/listings"
  return { path }
})

const agents = server().get("/api/agents", (c) => ({ ok: new URL(c.req.url).pathname }))

// merge() folds both groups into ONE flat path space at their defined paths; a path+method clash
// throws a RouteConfigError right here at merge time (fail-closed), never a silent shadow at runtime.
export const backend = server().merge(listings).merge(agents)`

export default function Backends() {
  return (
    <div className="prose">
      <h1 className="page">Backends &amp; API (dev and prod)</h1>
      <p className="lead">
        Your <code>@nifrajs/core</code> backend reaches a Nifra app two ways from a single wiring.{" "}
        <code>inProcessClient(backend)</code> is fed to every loader and action as{" "}
        <code>ctx.api</code> — and <code>createWebApp</code> now <strong>auto-mounts</strong> that
        backend over HTTP at <code>/api/*</code>, so the browser can call the very same routes. No
        hand-written <code>if (pathname.startsWith("/api/"))</code> branch in your server entry.
      </p>

      <h2>One backend, two call paths</h2>
      <p>
        Write the backend once. It defines its routes at the full <code>/api/…</code> path (the mount
        does no path stripping). Loaders call it <em>in-process</em> during SSR; the browser calls it
        <em>over HTTP</em>. Both run the identical lifecycle — validation, middleware, contracts.
      </p>
      <CodeBlock code={BACKEND} />

      <h2>ctx.api — the in-process loader client</h2>
      <p>
        Pass <code>inProcessClient(backend)</code> as <code>createWebApp</code>'s <code>api</code>.
        Inside a loader or action, <code>ctx.api</code> is that typed client, and a call goes{" "}
        <strong>straight to the backend's <code>fetch</code> in-process</strong> — no network hop, no
        port, the full real lifecycle. This is the SSR data path; it never touches the HTTP mount.
      </p>
      <CodeBlock code={LOADER} />

      <h2>The auto-mounted /api/* (the new part)</h2>
      <p>
        Before, <code>inProcessClient</code> fed <code>ctx.api</code> but did <em>not</em> serve the
        backend over HTTP — so a browser <code>POST /api/sync</code> hit the page router and 404/405'd
        until you hand-wrote a dispatch branch in <code>server-bun.ts</code>. Now{" "}
        <code>createWebApp</code> mounts it for you: a request whose pathname is exactly{" "}
        <code>apiPrefix</code> (default <code>/api</code>) or starts with{" "}
        <code>apiPrefix + "/"</code> is dispatched through Nifra's platform-aware backend mount
        interface <strong>before</strong> page routing. The backend receives the same Workers{" "}
        <code>env</code> bindings and <code>waitUntil</code> lifetime as the web app, and its{" "}
        <code>Response</code> is returned untouched (the request body is passed through, never pre-read).
      </p>
      <CodeBlock code={WIRE} />
      <p>
        The dispatch runs in <code>createWebApp</code>'s request lifecycle, ahead of the page wildcard,
        for <strong>every method</strong> — so <code>GET</code>/<code>POST</code>/<code>PUT</code>/… all
        reach the backend, and an unknown <code>/api/…</code> path returns the <em>backend's</em> 404,
        not the page's. A sibling path that merely shares the prefix string (e.g.{" "}
        <code>/apidocs</code>) is <strong>not</strong> captured — only the <code>/api</code> boundary
        is. Pass <code>apiPrefix: ""</code> to turn the mount off and keep <code>ctx.api</code> as a
        loader-only client.
      </p>

      <blockquote>
        [!NOTE] The mount lives in <code>createWebApp</code>, and <code>nifra dev</code> (the
        Vite-backed dev server) routes every request through that same app's <code>fetch</code>. So
        the <code>/api/*</code> routes are served identically in development and production — there is
        nothing extra to wire for the dev loop.
      </blockquote>

      <h2>Mounting, composition &amp; path semantics</h2>
      <p>
        A useful thing to know up front, because it is the opposite of some frameworks: in Nifra{" "}
        <strong>composition and mounting are prefix-less, and paths stay absolute</strong>. There is no
        per-mount base path, and nothing rewrites the request URL. Two mechanisms are involved and both
        leave the path untouched:
      </p>
      <ul>
        <li>
          <strong>
            <code>.merge()</code> (and contract-first <code>implement()</code>)
          </strong>{" "}
          - the composition escape hatch for large apps. <code>merge()</code> folds another server's
          routes into this one <em>at the exact paths they were defined</em>, into a single shared path
          space. It takes no prefix argument; a path+method collision throws a{" "}
          <code>RouteConfigError</code> at merge time (fail-closed), so groups never silently shadow
          each other. Each domain therefore owns its full absolute paths (<code>/api/listings</code>,{" "}
          <code>/api/agents</code>), exactly as it would standalone.
        </li>
        <li>
          <strong>the <code>/api/*</code> auto-mount</strong> - a path <em>guard</em>, not a rewrite.{" "}
          <code>createWebApp</code> hands the <em>same</em> <code>Request</code> (its URL and body
          intact) to the backend when the pathname is exactly <code>apiPrefix</code> or under{" "}
          <code>apiPrefix + "/"</code>. The backend's own router then matches on{" "}
          <code>new URL(c.req.url).pathname</code> - the full, original path.
        </li>
      </ul>
      <p>
        The consequence for a handler: <strong>
          <code>c.req.url</code> always carries the full, original path
        </strong>{" "}
        - the same URL the caller sent. The <code>/api</code> prefix is <em>not</em> stripped before a
        merged or mounted route sees it, and there is no <code>pathOf</code>-style helper that strips
        it. Whether a route was defined inline, merged in from a group, or reached through the HTTP
        mount, the pathname it observes is the request's own.
      </p>
      <CodeBlock code={COMPOSE} />
      <p>
        <strong>The one gotcha:</strong> because nothing strips the prefix, a backend that will be
        mounted (or merged) under <code>/api</code> must <strong>declare its routes at the full path</strong>{" "}
        - <code>server().post("/api/sync", …)</code>, <em>not</em> <code>.post("/sync", …)</code> in the
        hope that <code>/api</code> gets peeled off. Define <code>/sync</code> and a browser{" "}
        <code>POST /api/sync</code> returns the backend's 404: the router looks up{" "}
        <code>/api/sync</code> and finds only <code>/sync</code>. <code>apiPrefix</code> chooses{" "}
        <em>which</em> requests are handed to the backend; it does not rewrite them, so the route paths
        and the caller's paths are one and the same.
      </p>

      <h2>Calling /api/* from the browser</h2>
      <p>
        With the routes mounted, a client island or component hits them with the same typed{" "}
        <code>client&lt;typeof backend&gt;</code> — same-origin, no separate API server.
      </p>
      <CodeBlock code={CLIENT} />

      <h2>Route actions vs the in-process backend (for mutations)</h2>
      <p>
        Two valid ways to mutate; pick by where the call originates.
      </p>
      <ul>
        <li>
          <strong>Route <code>action</code></strong> — the form/SSR path. A{" "}
          <code>{`<form method="post">`}</code> (or the client submit) runs the route's{" "}
          <code>action(ctx)</code>, which typically calls <code>ctx.api</code> in-process and returns{" "}
          <code>actionData</code> (or a <code>redirect</code>). Progressive-enhancement: works with JS
          off, and the loader revalidates after. Reach for this for page-driven mutations tied to a
          route's UI.
        </li>
        <li>
          <strong>The mounted <code>/api/*</code> backend</strong> — the programmatic path. A browser
          island, a third party, a webhook, or a non-page client calls the HTTP route directly. Reach
          for this when the caller isn't a Nifra route's form — an RPC the page makes on an
          interaction, an external integration, a mobile client.
        </li>
      </ul>
      <p>
        They share the backend: a route <code>action</code> and a browser <code>fetch</code> can both
        call <code>POST /api/sync</code> — one in-process, one over the mount — and get identical
        validation and behavior.
      </p>
    </div>
  )
}
