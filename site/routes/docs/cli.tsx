import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — CLI",
  "The zero-config Nifra CLI (`nifra dev`, `nifra build`, `nifra start`): true HMR, hashed client builds, and SSR serve.",
)

const COMMANDS = `nifra dev      # true-HMR dev server (Vite middleware + nifra SSR) — http://localhost:3000
nifra build    # bundle the client (content-hashed, code-split) + write dist/manifest.json (incl. CSS)
nifra start    # serve the built client + SSR on Bun (assets, <link> stylesheets, matched-route preload)

# flags: --port <n> (dev/start) · --out <dir> (build/start) · --poll (dev; containers/sandboxes)`

const FRAMEWORK = `// framework.ts — the one place an app names its framework. The CLI reads these:
import react from "@vitejs/plugin-react"
import { reactAdapter } from "@nifrajs/web-react"

export const adapter = reactAdapter
export const clientModule = "@nifrajs/web-react/client"
export const vitePlugins = [react()]          // dev HMR (Fast Refresh)
// Vue/Svelte/Solid also export:
//   clientPlugins = [vueBunPlugin("dom")]     // compile routes for the client build
//   serverPlugins = [vueBunPlugin("ssr")]     // compile routes for SSR (nifra start registers them)
//   conditions    = ["solid"]                 // Solid: resolve solid-js to its source
//   define        = { __VUE_OPTIONS_API__: "true", ... }   // Vue feature flags`

const STRUCTURE = `my-app/
  routes/            # file-based routes (index.tsx, _layout.tsx, [id].tsx, …)
  framework.ts       # adapter + clientModule + plugins (above)
  backend.ts         # export const backend = server()...   (optional — the typed contract)`

export default function Cli() {
  return (
    <div className="prose">
      <h1 className="page">CLI</h1>
      <p className="lead">
        <code>Nifra</code> is zero-config: it reads <code>routes/</code>, <code>framework.ts</code>, and
        (optionally) <code>backend.ts</code> from your project and wires the right{" "}
        <code>@nifrajs/web</code> entrypoint — no <code>dev.ts</code>/<code>build.ts</code>/
        <code>server.ts</code> to hand-write. (`create-nifra` scaffolds the conventions.)
      </p>
      <CodeBlock code={COMMANDS} />

      <h2>The conventions</h2>
      <p>
        Three files at the project root. <code>nifra dev</code> runs the Vite-backed{" "}
        <a href="/docs/dev">HMR dev server</a>; <code>nifra build</code> runs the Bun-native production
        build (content-hashed, code-split, CSS bundled); <code>nifra start</code> serves the built
        client and SSRs on Bun — assets with immutable caching + correct MIME, the matched route's
        chunks preloaded, and the CSS bundle linked in every <code>&lt;head&gt;</code>.
      </p>
      <CodeBlock code={STRUCTURE} />

      <h2>framework.ts — naming the framework once</h2>
      <p>
        The single framework-specific file. Only <code>adapter</code> + <code>clientModule</code> are
        required; the plugin/condition fields are extras the compiler frameworks need (React/Preact's
        JSX is Bun-native, so they need none beyond the Vite plugin for dev HMR).
      </p>
      <CodeBlock code={FRAMEWORK} />

      <h2>Scope</h2>
      <p>
        <code>nifra build</code> + <code>nifra start</code> target a Bun (or Node) long-running server —
        the common self-hosted case. For the edge (Cloudflare Workers / Vercel Edge / Deno Deploy),
        use the per-target build entries from <code>create-nifra</code>'s <code>site</code> template (see{" "}
        <a href="/docs/deployment">Deployment</a>) — <code>buildServer</code> bundles a disk-less
        worker those targets need. A <code>nifra build --target</code> for edge is a future addition.
      </p>
    </div>
  )
}
