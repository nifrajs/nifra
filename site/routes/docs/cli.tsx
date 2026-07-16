import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — CLI",
  "The zero-config Nifra CLI (`nifra dev`, `nifra build`, `nifra start`): true HMR and complete target-specific deploy builds.",
)

const COMMANDS = `nifra dev      # true-HMR dev server (Vite middleware + nifra SSR) — http://localhost:4321
nifra build    # full Bun deploy → dist/server.js + content-hashed dist/assets/ (default target: bun)
nifra start    # run dist/server.js on Bun
nifra build --target cf-pages  # also: node | deno | vercel | static; add --report for chunk sizes

# dev + start share the default port 4321. Override per run: --port <n> (alias -p) or the PORT env var.
# flags: --port <n> (dev/start) · --out <dir> (build/start) · --target <t> (build) · --poll (dev)`

const FRAMEWORK = `// framework.ts — deploy-safe; generated server entries import this file.
import { reactAdapter } from "@nifrajs/web-react"

export const adapter = reactAdapter

// nifra.config.ts — CLI-only build/dev tooling; never imported by a deployed server.
// doc-check: skip — needs the third-party @vitejs/plugin-react; install it to run this.
import react from "@vitejs/plugin-react"
export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-react/client"
export const vitePlugins = [react()]          // dev HMR (Fast Refresh)
// Vue/Svelte/Solid also export:
//   clientPlugins = [vueBunPlugin("dom")]     // compile routes for the client build
//   serverPlugins = [vueBunPlugin("ssr")]     // compile routes into the target's server bundle
//   conditions    = ["solid"]                 // Solid: resolve solid-js to its source
//   define        = { __VUE_OPTIONS_API__: "true", ... }   // Vue feature flags`

const STRUCTURE = `my-app/
  routes/            # file-based routes (index.tsx, _layout.tsx, [id].tsx, …)
  framework.ts       # deploy-safe render adapter
  nifra.config.ts    # CLI-only client module + dev/build plugins
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
        Four conventions at the project root. <code>nifra dev</code> runs the Vite-backed{" "}
        <a href="/docs/dev">HMR dev server</a>; <code>nifra build</code> runs the Bun-native production
        build (content-hashed client assets plus a target-specific server); <code>nifra start</code>
        runs the default Bun output. The generated server serves assets and SSR with matched-route
        chunks preloaded and route CSS linked in each <code>&lt;head&gt;</code>.
      </p>
      <CodeBlock code={STRUCTURE} />

      <h2>framework.ts — naming the framework once</h2>
      <p>
        Keep the render <code>adapter</code> in deploy-safe <code>framework.ts</code>. Put{" "}
        <code>clientModule</code>, Vite plugins, compiler plugins, conditions, and defines in CLI-only{" "}
        <code>nifra.config.ts</code>. This prevents build tooling and native dependencies from entering
        generated server bundles.
      </p>
      <CodeBlock code={FRAMEWORK} />

      <h2>Scope</h2>
      <p>
        <code>nifra build</code> defaults to a self-hosted Bun server. Use <code>--target node</code>,{" "}
        <code>deno</code>, <code>cf-pages</code>, <code>vercel</code>, or <code>static</code> for another
        complete deploy shape (see <a href="/docs/deployment">Deployment</a>). Run non-Bun outputs with
        the command printed by the build.
      </p>
    </div>
  )
}
