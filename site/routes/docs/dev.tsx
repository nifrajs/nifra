import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Dev & HMR",
  "Use `nifra dev` for a Vite-backed state-preserving HMR loop, or `@nifrajs/web/dev` for a Bun-native HMR loop with no Vite dependency. Production builds use Bun.",
)

const BUN_DEV = `// doc-check: skip — fragment: routesDir/outDir/clientModule/createApp are your app's dev config.
// dev.ts — Bun-native HMR, no Vite in the process
import { createDevServer } from "@nifrajs/web/dev"
// Bun.serve bundles + hot-reloads the client; Bun's runtime resolves SSR. An edit reloads the
// changed module graph — with React Fast Refresh (state preserved) applied natively by Bun, no plugin.
// CSS + the entry URL come from Bun. Plain CSS/Tailwind work; *.module.css does not (Bun's dev bundler).
const server = await createDevServer({ routesDir, outDir, clientModule, createApp })`

const VITE_DEV = `// doc-check: skip — needs the third-party @vitejs/plugin-react + your ./backend; install it to run this.
// dev.ts — state-preserving HMR for supported UI adapters
import react from "@vitejs/plugin-react"            // your framework's official Vite plugin
import { createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { createViteDevServer } from "@nifrajs/web/vite"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend"

const routesDir = \`\${import.meta.dir}/routes\`
const server = await createViteDevServer({
  root: import.meta.dir,
  routesDir,
  clientModule: "@nifrajs/web-react/client",
  plugins: [react()],                                // Vue: @vitejs/plugin-vue, Svelte: …, etc.
  port: Number(Bun.env.PORT ?? 4321),                // nifra's default; --port / PORT override it
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: reactAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }),
      clientEntry,
      api: inProcessClient(backend),
    }),
})`

const BOUNDARY = `// routes/index.tsx — NOT a Fast Refresh boundary (exports loader/meta), so a save
//                     here does a clean full reload. Keep the view in a child component:
export const meta = { title: "Home" }
export async function loader({ api }) { /* … */ }
export default function Home(props) {
  return <Counter message={props.data.message} />   // ← edit Counter.tsx for state-preserving HMR
}

// components/Counter.tsx — component-only module → a Fast Refresh boundary. Editing this file's
// JSX hot-swaps it with useState/useReducer state PRESERVED (no reload).
import { useState } from "react"
export function Counter(props: { message: string }) {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount((n) => n + 1)}>{count}</button>
}`

const CSS_PIPE = `// Import CSS anywhere in a route or component — a global stylesheet (in _layout) or local:
// routes/_layout.tsx
import "./app.css"

// Dev: Vite injects + HMRs the CSS (no reload). Production: buildClient bundles + content-hashes it
// into manifest.css (aggregate) + manifest.routeStyles (per route); wire both into your server:
// server.ts
const assets = JSON.parse(await Bun.file("dist/manifest.json").text())
export const app = createWebApp({
  adapter, manifest, clientEntry: assets.entry,
  styles: assets.css,              // aggregate — the safe fallback
  routeStyles: assets.routeStyles, // per route — each page links only its chain's CSS
})
// → <link rel="stylesheet"> for just the matched route's CSS in <head>. Serve .css as text/css.`

const VITE_PROD = `// vite.config.ts — a Vite/Rollup PRODUCTION client build (the escape hatch, not the default).
// Only reach for this when an app needs a Vite-only transform with no Bun equivalent; nifra's default
// production bundler stays Bun (buildClient), which is faster and Bun-native.
import { viteLeakGuard } from "@nifrajs/web/plugins/vite-leak-guard"

export default {
  build: {
    // The SAME two client-leak guards nifra's Bun build runs — server-only code or a node: builtin
    // reaching the browser fails the build, with the identical error message. A second production
    // pipeline must not ship without them.
    rollupOptions: { plugins: [viteLeakGuard()] },
  },
}`

const CSS_SCOPED = `// CSS Modules — *.module.css gives a hashed, collision-free class map:
// Counter.module.css  →  .box { padding: 1rem }
import styles from "./Counter.module.css"
// then: <div className={styles.box}>…</div>   →   class="box_a1b2c3" at runtime

// TS needs ambient types for CSS imports — declare them once (e.g. src/css.d.ts):
declare module "*.module.css" { const c: Readonly<Record<string, string>>; export default c }
declare module "*.css" {}

// Vue / Svelte SFCs — <style scoped> just works. The framework compiler scopes the selectors
// (#page[data-v-…] for Vue, .page.svelte-… for Svelte) and folds them into the same app stylesheet.`

export default function Dev() {
  return (
    <div className="prose">
      <h1 className="page">Dev & HMR</h1>
      <p className="lead">
        Nifra gives you two local development loops, and the rule between them is that one
        toolchain owns a whole phase. <strong>Both</strong> give you React Fast Refresh with state
        preserved. Use <code>nifra dev</code> (Vite) for the plugin ecosystem, or{" "}
        <code>nifra dev --bun</code> for one bundler across dev and prod with no Vite dependency.
        Both serve your real SSR app locally, and neither mixes the two bundlers in one process.
      </p>

      <h2>Two loops, same app</h2>
      <table>
        <thead>
          <tr>
            <th>import</th>
            <th>watcher → update</th>
            <th>dependencies</th>
            <th>use when</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>@nifrajs/web/dev</code>
            </td>
            <td>Bun HMR + Fast Refresh (native)</td>
            <td>none (Bun only)</td>
            <td>one bundler dev+prod; no Vite dep (no CSS Modules)</td>
          </tr>
          <tr>
            <td>
              <code>@nifrajs/web/vite</code>
            </td>
            <td>true HMR (Fast Refresh / framework HMR)</td>
            <td>
              <code>vite</code> + your framework's plugin
            </td>
            <td>state-preserving UI iteration</td>
          </tr>
        </tbody>
      </table>

      <h2>State-preserving HMR</h2>
      <p>
        Use <code>createViteDevServer</code> when you want component edits to update the browser
        without a full page reload. Pass the official plugin for your UI framework, keep the same
        Nifra routes and loaders, and run the dev server during local development.
      </p>
      <CodeBlock code={VITE_DEV} />
      <p>
        Start it with <code>bun run dev</code>. The server reads your route source directly, so you
        can edit routes, components, loaders, actions, and styles in one local loop.
      </p>

      <h2>Framework coverage</h2>
      <p>
        All five adapters have a dev setup. Pass the framework's official Vite plugin and you are
        done: under <code>nifra dev</code> the Vite pipeline compiles both halves, so the same plugin
        that transforms your components for the browser also transforms them for SSR. No separate
        server-side compiler plugin to preload, and no way for the two halves to disagree about a
        specifier.
      </p>
      <table>
        <thead>
          <tr>
            <th>framework</th>
            <th>Vite plugin (client + SSR)</th>
            <th>local state on edit</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>React</td>
            <td>
              <code>@vitejs/plugin-react</code>
            </td>
            <td>preserved (Fast Refresh)</td>
          </tr>
          <tr>
            <td>Preact</td>
            <td>
              <code>@preact/preset-vite</code>
            </td>
            <td>preserved (prefresh)</td>
          </tr>
          <tr>
            <td>Vue</td>
            <td>
              <code>@vitejs/plugin-vue</code>
            </td>
            <td>preserved (rerender)</td>
          </tr>
          <tr>
            <td>Solid</td>
            <td>
              <code>vite-plugin-solid</code> (<code>{`{ ssr: true }`}</code>)
            </td>
            <td>resets (solid-refresh)</td>
          </tr>
          <tr>
            <td>Svelte</td>
            <td>
              <code>@sveltejs/vite-plugin-svelte</code>
            </td>
            <td>resets (svelte HMR)</td>
          </tr>
        </tbody>
      </table>
      <p>
        For <strong>React, Preact, and Vue</strong>, an edit hot-swaps with component state preserved.
        For <strong>Solid and Svelte</strong>, the module hot-swaps live (no full reload — scroll,
        route, and other components are kept), but the edited component re-runs, so its own local state
        resets. For Solid, use <code>{`solid({ ssr: true })`}</code> and the <code>"solid"</code>{" "}
        resolve condition. Working examples for all five live in <code>examples/hmr-*</code>.
      </p>

      <h2>The Fast Refresh boundary rule</h2>
      <p>
        React Fast Refresh (and the other frameworks' equivalents) only hot-swap a module when{" "}
        <em>every</em> export is a component. Nifra route files co-locate <code>loader</code>,{" "}
        <code>action</code>, and <code>meta</code> next to the component — so a route file isn't a
        refresh boundary, and saving it does a clean full reload. Keep the view in a child component
        and edits hot-swap with state intact.
      </p>
      <CodeBlock code={BOUNDARY} />

      <h2>Containers & sandboxes</h2>
      <p>
        In Docker, networked volumes, and some sandboxes, pass{" "}
        <code>poll: true</code> (or set <code>CHOKIDAR_USEPOLLING=1</code>) to use a polling watcher
        instead.
      </p>

      <h2>The zero-dep alternative</h2>
      <p>
        <code>nifra dev --bun</code> (library: <code>@nifrajs/web/dev</code>) is self-contained —
        no Vite anywhere. <code>Bun.serve</code>'s native HMR bundles and hot-reloads the client while
        Bun's runtime resolves SSR, and it applies <strong>React Fast Refresh natively</strong>: editing
        a component-only module swaps its markup with <code>useState</code> state intact, no reload. The
        boundary rule is the same as Vite's (see below). The real prize is that dev and production use
        the <em>same bundler</em>, so the dev/prod seam disappears.
      </p>
      <p>
        One gap: <strong>CSS Modules</strong>. Bun's dev-server bundler has no{" "}
        <code>*.module.css</code> transform (its production <code>Bun.build</code> does), so the CLI
        refuses <code>--bun</code> for a CSS-Modules app rather than serving a broken client. Plain CSS
        and Tailwind work normally.
      </p>
      <CodeBlock code={BUN_DEV} />

      <h2>Production is Bun — with a Vite escape hatch</h2>
      <p>
        Production builds default to <strong>Bun</strong> (<code>buildClient</code> /{" "}
        <code>nifra build</code>): faster, Bun-native, and the profile Nifra is tuned for. If an app
        genuinely needs a <strong>Vite-only transform</strong> with no Bun equivalent, you can run a
        Vite/Rollup production client build instead — but it must carry the same client-leak guards the
        Bun build enforces, or a second pipeline becomes a way for server-only code to reach the
        browser unnoticed. Add <code>viteLeakGuard()</code>: it runs the <em>same</em> detection and
        emits the <em>same</em> error as the Bun build (one implementation, adapted to Rollup's graph),
        so <code>node:</code> builtins and <code>server-only</code> modules fail the build either way.
      </p>
      <CodeBlock code={VITE_PROD} />
      <p>
        For the full deploy, <code>nifra build --vite --target &lt;t&gt;</code> builds{" "}
        <em>both</em> halves — client and SSR worker — with Vite and assembles the identical per-target
        deploy dir the Bun build produces (same <code>_worker.js</code> / <code>server.js</code>, same{" "}
        <code>_routes.json</code>, same prerender + size report). Only the bundler differs: both go
        through one orchestrator, so the deploy shape can't drift between pipelines. The leak guards run
        automatically.
      </p>
      <p>
        You usually don't need the flag. <code>nifra build</code> picks the bundler from your config:
        Bun by default, but Vite when your <em>only</em> transforms are <code>vitePlugins</code>, and it
        prints the reason. That case is the one where the phase defaults would otherwise bite — dev runs
        Vite, so your plugins run; the Bun build reads <code>clientPlugins</code>/
        <code>serverPlugins</code> and never <code>vitePlugins</code>, so it would drop them and still
        succeed. An app declaring both slots has supplied the Bun equivalent on purpose, so it keeps the
        faster Bun default. <code>--vite</code> and <code>--bun</code> force the choice; <code>--bun</code>{" "}
        is refused for a <code>vitePlugins</code>-only app rather than silently building without your
        transforms.
      </p>

      <h2>Styling (CSS)</h2>
      <p>
        Import a stylesheet anywhere — <code>import "./app.css"</code> in a route, layout, or component.
        In <strong>dev</strong>, Vite injects and hot-reloads it (no page reload). In{" "}
        <strong>production</strong>, <code>buildClient</code> bundles + minifies + content-hashes the
        CSS and records it as <code>manifest.css</code>; pass that to <code>createWebApp</code>'s{" "}
        <code>styles</code> and Nifra links it in every page's <code>&lt;head&gt;</code> as a
        render-blocking <code>&lt;link rel="stylesheet"&gt;</code> (no FOUC). Serve <code>.css</code>{" "}
        assets as <code>text/css</code>.
      </p>
      <CodeBlock code={CSS_PIPE} />
      <p>
        This is the <em>global imports</em> tier: one bundled stylesheet linked on every page (the
        common case — a global stylesheet or Tailwind output).
      </p>

      <h3>Scoped styles — CSS Modules &amp; SFC &lt;style&gt;</h3>
      <p>
        For component-local styles you have two collision-free options, both bundled into that same
        stylesheet:
      </p>
      <ul>
        <li>
          <strong>CSS Modules</strong> (<code>*.module.css</code>) — works in any framework.{" "}
          <code>buildClient</code> (Bun) and the dev server (Vite) both hash the class names and hand
          you a <code>Record&lt;string, string&gt;</code> map. Add an ambient declaration once so
          TypeScript types the import.
        </li>
        <li>
          <strong>SFC <code>&lt;style scoped&gt;</code></strong> (Vue) and{" "}
          <strong><code>&lt;style&gt;</code></strong> (Svelte — scoped by default) — the framework's
          compiler plugin rewrites the selectors to a unique scope (<code>[data-v-…]</code> /{" "}
          <code>.svelte-…</code>) and bakes the matching marker into the SSR markup, so the server HTML
          already matches the bundled CSS. No runtime, no FOUC.
        </li>
      </ul>
      <CodeBlock code={CSS_SCOPED} />

      <h3>Per-route CSS splitting</h3>
      <p>
        <code>buildClient</code> splits CSS per route: each page links only its layout chain and its
        own stylesheet. Pass <code>manifest.routeStyles</code> to <code>createWebApp</code> alongside{" "}
        <code>styles</code>, and Nifra links the matched route's CSS during SSR. In{" "}
        <strong>dev</strong>, Vite injects per-module CSS.
      </p>
    </div>
  )
}
