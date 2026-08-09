import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra - Dev & HMR",
  "Use `nifra dev` for a Vite-backed state-preserving HMR loop, or `@nifrajs/web/dev` for a Bun-native HMR loop with no Vite dependency. Production builds use Bun.",
  "/docs/dev",
)

const BUN_DEV = `// doc-check: skip - fragment: routesDir/outDir/clientModule/createApp are your app's dev config.
// dev.ts - Bun-native HMR, no Vite in the process
import { createDevServer } from "@nifrajs/web/dev"
// Bun.serve bundles + hot-reloads the client; Bun's runtime resolves SSR. An edit reloads the
// changed module graph - with React Fast Refresh (state preserved) applied natively by Bun, no plugin.
// CSS + the entry URL come from Bun. Plain CSS/Tailwind work; *.module.css does not (Bun's dev bundler).
const server = await createDevServer({ routesDir, outDir, clientModule, createApp })`

const VITE_DEV = `// doc-check: skip - needs the third-party @vitejs/plugin-react + your ./backend; install it to run this.
// dev.ts - state-preserving HMR for supported UI adapters
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
  port: Number(Bun.env.PORT ?? 4321),                // Nifra's default; --port / PORT override it
  createApp: (clientEntry, importQuery) =>
    createWebApp({
      adapter: reactAdapter,
      manifest: discoverRoutes(routesDir, { importQuery }),
      clientEntry,
      api: inProcessClient(backend),
    }),
})`

const BOUNDARY = `// routes/index.tsx - NOT a Fast Refresh boundary (exports loader/meta), so a save
//                     here does a clean full reload. Keep the view in a child component:
export const meta = { title: "Home" }
export async function loader({ api }) { /* … */ }
export default function Home(props) {
  return <Counter message={props.data.message} />   // ← edit Counter.tsx for state-preserving HMR
}

// components/Counter.tsx - component-only module → a Fast Refresh boundary. Editing this file's
// JSX hot-swaps it with useState/useReducer state PRESERVED (no reload).
import { useState } from "react"
export function Counter(props: { message: string }) {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount((n) => n + 1)}>{count}</button>
}`

const CSS_PIPE = `// Import CSS anywhere in a route or component - a global stylesheet (in _layout) or local:
// routes/_layout.tsx
import "./app.css"

// Dev: Vite injects + HMRs the CSS (no reload). Production: buildClient bundles + content-hashes it
// into manifest.css (aggregate) + manifest.routeStyles (per route); wire both into your server:
// server.ts
const assets = JSON.parse(await Bun.file("dist/manifest.json").text())
export const app = createWebApp({
  adapter, manifest, clientEntry: assets.entry,
  styles: assets.css,              // aggregate - the safe fallback
  routeStyles: assets.routeStyles, // per route - each page links only its chain's CSS
})
// → <link rel="stylesheet"> for just the matched route's CSS in <head>. Serve .css as text/css.`

const VITE_PROD = `// vite.config.ts - a Vite/Rollup PRODUCTION client build (the escape hatch, not the default).
// Only reach for this when an app needs a Vite-only transform with no Bun equivalent; Nifra's default
// production bundler stays Bun (buildClient), which is faster and Bun-native.
import { viteLeakGuard } from "@nifrajs/web/plugins/vite-leak-guard"

export default {
  build: {
    // The SAME two client-leak guards Nifra's Bun build runs - server-only code or a node: builtin
    // reaching the browser fails the build, with the identical error message. A second production
    // pipeline must not ship without them.
    rollupOptions: { plugins: [viteLeakGuard()] },
  },
}`

const DEVTOOLS = `import { server } from "@nifrajs/core/server"
import { devtools } from "@nifrajs/devtools"

// Enabled only when NODE_ENV is "development" unless you say otherwise.
export const app = server().use(devtools())`

const CSS_SCOPED = `// CSS Modules - *.module.css gives a hashed, collision-free class map:
// Counter.module.css  →  .box { padding: 1rem }
import styles from "./Counter.module.css"
// then: <div className={styles.box}>…</div>   →   class="box_a1b2c3" at runtime

// TS needs ambient types for CSS imports - declare them once (e.g. src/css.d.ts):
declare module "*.module.css" { const c: Readonly<Record<string, string>>; export default c }
declare module "*.css" {}

// Vue / Svelte SFCs - <style scoped> just works. The framework compiler scopes the selectors
// (#page[data-v-…] for Vue, .page.svelte-… for Svelte) and folds them into the same app stylesheet.`

const CONFIG_SPLIT = `// doc-check: skip - fragment: two files from one app, shown together.
// framework.ts - imported by your SERVER and edge entries. Adapter only, nothing else.
import { svelteAdapter } from "@nifrajs/web-svelte"
export const adapter = svelteAdapter

// nifra.config.ts - imported ONLY by the CLI, which runs on Bun. Compilers and Vite plugins
// belong here. Re-export the adapter; never define it here, or the dev toolchain it pulls in
// (Vite, the SFC compiler, their native bindings) is bundled into your production server.
import { svelte } from "@sveltejs/vite-plugin-svelte"
export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-svelte/client"
export const vitePlugins = [svelte()]`

const PIPELINE_BANNER = `# doc-check: skip - fragment: terminal output, not source.
$ nifra dev
nifra dev (bun) → http://localhost:3000
  bundler: bun (default; --vite to switch)

$ nifra build
nifra build (node, vite) → dist/server/server.js
  bundler: vite (auto: this app's only transforms are \`vitePlugins\` (svelte), which the Bun build cannot run)

$ nifra check
• bundler: vite (auto: this app's only transforms are \`vitePlugins\` (svelte), which the Bun build cannot run)`

const CONDITIONS_FLAG = `# Resolve conditions on the Bun dev pipeline.
# SSR honours \`conditions\` - nifra passes them to the runtime when it re-execs.
# The CLIENT bundle does not: Bun's dev-server bundler takes no resolve conditions,
# from bunfig.toml or anywhere else. nifra warns once at startup when it matters.
nifra dev --vite            # exact dev/prod client resolution, if your app needs it

# If you invoke bun yourself: ONE FLAG PER CONDITION.
bun --conditions=browser --conditions=development ./app.ts   # correct
bun --conditions=browser,development ./app.ts                # ONE condition named "browser,development"`

export default function Dev() {
  return (
    <div className="prose">
      <h1 className="page">Dev & HMR</h1>
      <p className="lead">
        Nifra gives you two local development loops, and the rule between them is that one
        toolchain owns a whole phase. <strong>Both</strong> give you React Fast Refresh with state
        preserved. Bun is the default; Vite takes over automatically when your config's only
        transforms are <code>vitePlugins</code>. Both serve your real SSR app locally, and neither
        mixes the two bundlers in one process.
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
            <td>one bundler dev+prod, no Vite dep; CSS Modules included</td>
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

      <h2>Which pipeline runs, when</h2>
      <p>
        One rule decides the bundler, and it decides it the same way for <code>nifra dev</code> and{" "}
        <code>nifra build</code> - your dev loop and your production build are never on different
        toolchains.
      </p>
      <table>
        <thead>
          <tr>
            <th>your config</th>
            <th>command</th>
            <th>pipeline</th>
            <th>why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>no plugins at all</td>
            <td>
              <code>nifra dev</code> / <code>nifra build</code>
            </td>
            <td>Bun</td>
            <td>the default: no Vite dependency, one bundler across dev and prod</td>
          </tr>
          <tr>
            <td>
              <code>clientPlugins</code> and/or <code>serverPlugins</code>
            </td>
            <td>
              <code>nifra dev</code> / <code>nifra build</code>
            </td>
            <td>Bun</td>
            <td>those slots are Bun.build plugins; Vite would never call them</td>
          </tr>
          <tr>
            <td>
              <code>vitePlugins</code> only
            </td>
            <td>
              <code>nifra dev</code> / <code>nifra build</code>
            </td>
            <td>Vite (automatic)</td>
            <td>the Bun build cannot run them, so staying on Bun would silently drop your transforms</td>
          </tr>
          <tr>
            <td>
              <code>vitePlugins</code> only
            </td>
            <td>
              <code>--bun</code>
            </td>
            <td>error</td>
            <td>nifra refuses rather than build an app with its compiler switched off</td>
          </tr>
          <tr>
            <td>any</td>
            <td>
              <code>--vite</code>
            </td>
            <td>Vite (forced)</td>
            <td>
              exact dev/prod client resolution for <code>conditions</code>, or a Vite-only plugin
            </td>
          </tr>
          <tr>
            <td>any</td>
            <td>
              <code>--bun</code>
            </td>
            <td>Bun (forced)</td>
            <td>allowed whenever no transform would be lost</td>
          </tr>
        </tbody>
      </table>
      <p>
        You never have to work this out from the table. Every <code>nifra dev</code> and{" "}
        <code>nifra build</code> run prints the answer under its banner, and{" "}
        <code>nifra check</code> and <code>nifra doctor</code> report it - with the config hazards
        below - without starting a server:
      </p>
      <CodeBlock code={PIPELINE_BANNER} />

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
        For <strong>Solid and Svelte</strong>, the module hot-swaps live (no full reload - scroll,
        route, and other components are kept), but the edited component re-runs, so its own local state
        resets. For Solid, use <code>{`solid({ ssr: true })`}</code> and the <code>"solid"</code>{" "}
        resolve condition. Working examples for all five live in <code>examples/hmr-*</code>.
      </p>

      <h2>The Fast Refresh boundary rule</h2>
      <p>
        React Fast Refresh (and the other frameworks' equivalents) only hot-swap a module when{" "}
        <em>every</em> export is a component. Nifra route files co-locate <code>loader</code>,{" "}
        <code>action</code>, and <code>meta</code> next to the component - so a route file isn't a
        refresh boundary, and saving it does a clean full reload. Keep the view in a child component
        and edits hot-swap with state intact.
      </p>
      <CodeBlock code={BOUNDARY} />

      <h2>DevTools overlay</h2>
      <p>
        <code>@nifrajs/devtools</code> is a plugin that streams what each request actually did - loader
        traces, ISR status, route metadata - over a secured SSE endpoint, with an overlay to read it
        in the browser.
      </p>
      <CodeBlock code={DEVTOOLS} lang="ts" />
      <p>
        It is off outside development by default, refuses remote connections unless you allow them, and
        caps both the buffered event count and the number of live connections - a dev tool that streams
        request internals has to be closed by default rather than merely quiet in production.
      </p>

      <h2>Containers & sandboxes</h2>
      <p>
        In Docker, networked volumes, and some sandboxes, pass{" "}
        <code>poll: true</code> (or set <code>CHOKIDAR_USEPOLLING=1</code>) to use a polling watcher
        instead.
      </p>

      <h2>The zero-dep alternative</h2>
      <p>
        <code>nifra dev --bun</code> (library: <code>@nifrajs/web/dev</code>) is self-contained -
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
      <p>
        <strong>
          Server functions and <code>*.server</code> modules work under <code>--bun</code>
        </strong>{" "}
        - and the plumbing is worth knowing. The client build strips them: a <code>*.fn</code> module
        is replaced with an RPC stub and a <code>*.server</code> module is emptied, so their bodies
        (DB handles, secrets, imports) never reach a browser. Bun's dev-server bundling accepts
        plugins only through <code>bunfig.toml</code> (<code>[serve.static] plugins</code>) - not
        programmatically, and a runtime <code>Bun.plugin</code> never reaches it (upstream ask:
        oven-sh/bun#36830). So <code>nifra dev --bun</code> generates a config under{" "}
        <code>.nifra/dev-bun/</code> carrying the <em>same</em> production boundary plugins, merges
        your own bunfig's <code>[serve.static] plugins</code> and <code>preload</code> entries, and
        re-launches itself once with <code>--config=</code> pointing at it. Same stubs as{" "}
        <code>nifra build</code>, byte for byte - one implementation, three pipelines.
      </p>
      <p>
        Two pipelines, one contract: what keeps them honest is not hope but guards. Both loops serve{" "}
        <code>public/</code> through the same handler production uses, the build dedupes the UI
        framework to one physical copy on both paths, SSR verifies at render time that the renderer
        and your components share one core (naming both directories if not), and{" "}
        <code>nifra doctor</code> flags a stale workspace <code>dist</code> before it can shadow
        source. A divergence between the loops is treated as a bug, not a caveat.
      </p>
      <CodeBlock code={BUN_DEV} />

      <h2>Production is Bun - with a Vite escape hatch</h2>
      <p>
        Production builds default to <strong>Bun</strong> (<code>buildClient</code> /{" "}
        <code>nifra build</code>): faster, Bun-native, and the profile Nifra is tuned for. If an app
        genuinely needs a <strong>Vite-only transform</strong> with no Bun equivalent, you can run a
        Vite/Rollup production client build instead - but it must carry the same client-leak guards the
        Bun build enforces, or a second pipeline becomes a way for server-only code to reach the
        browser unnoticed. Add <code>viteLeakGuard()</code>: it runs the <em>same</em> detection and
        emits the <em>same</em> error as the Bun build (one implementation, adapted to Rollup's graph),
        so <code>node:</code> builtins and <code>server-only</code> modules fail the build either way.
      </p>
      <CodeBlock code={VITE_PROD} />
      <p>
        For the full deploy, <code>nifra build --vite --target &lt;t&gt;</code> builds{" "}
        <em>both</em> halves - client and SSR worker - with Vite and assembles the identical per-target
        deploy dir the Bun build produces (same <code>_worker.js</code> / <code>server.js</code>, same{" "}
        <code>_routes.json</code>, same prerender + size report). Only the bundler differs: both go
        through one orchestrator, so the deploy shape can't drift between pipelines. The leak guards run
        automatically.
      </p>
      <p>
        You usually don't need the flag. <code>nifra build</code> picks the bundler from your config:
        Bun by default, but Vite when your <em>only</em> transforms are <code>vitePlugins</code>, and it
        prints the reason. That case is the one where the phase defaults would otherwise bite - dev runs
        Vite, so your plugins run; the Bun build reads <code>clientPlugins</code>/
        <code>serverPlugins</code> and never <code>vitePlugins</code>, so it would drop them and still
        succeed. An app declaring both slots has supplied the Bun equivalent on purpose, so it keeps the
        faster Bun default. <code>--vite</code> and <code>--bun</code> force the choice; <code>--bun</code>{" "}
        is refused for a <code>vitePlugins</code>-only app rather than silently building without your
        transforms.
      </p>

      <h2>Styling (CSS)</h2>
      <p>
        Import a stylesheet anywhere - <code>import "./app.css"</code> in a route, layout, or component.
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
        common case - a global stylesheet or Tailwind output).
      </p>

      <h3>Scoped styles - CSS Modules &amp; SFC &lt;style&gt;</h3>
      <p>
        For component-local styles you have two collision-free options, both bundled into that same
        stylesheet:
      </p>
      <ul>
        <li>
          <strong>CSS Modules</strong> (<code>*.module.css</code>) - works in any framework.{" "}
          <code>buildClient</code> (Bun) and the dev server (Vite) both hash the class names and hand
          you a <code>Record&lt;string, string&gt;</code> map. Add an ambient declaration once so
          TypeScript types the import.
        </li>
        <li>
          <strong>SFC <code>&lt;style scoped&gt;</code></strong> (Vue) and{" "}
          <strong><code>&lt;style&gt;</code></strong> (Svelte - scoped by default) - the framework's
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

      <h2>Gotchas</h2>
      <p>
        The rule "one toolchain owns a whole phase" is what keeps the two loops honest, and most of
        what follows is a consequence of it. None of these are things you have to memorise before you
        start - they are the edges you can hit later, collected in one place.
      </p>

      <h3>Keep the adapter out of your config file</h3>
      <p>
        Split <code>framework.ts</code> (the adapter, imported by your server and edge entries) from{" "}
        <code>nifra.config.ts</code> (the CLI's config, where the Vite plugins and SFC compilers live).
        If your server entry reaches the adapter <em>through</em> the config, everything the config
        imports is bundled into your production server - the Vite plugin, the framework compiler, and
        their native bindings. It builds without complaint and then fails at startup with a missing
        native binding, which reads like a broken install rather than a config-shape problem.
      </p>
      <CodeBlock code={CONFIG_SPLIT} />

      <h3>Plugins go in the slot that matches the pipeline</h3>
      <p>
        <code>vitePlugins</code> run on the Vite pipeline; <code>clientPlugins</code> and{" "}
        <code>serverPlugins</code> run on the Bun one. A plugin in the wrong slot is not an error, it
        is a <em>no-op</em> - your transform silently does not run. Nifra classifies each plugin by its
        hook shape and refuses a mismatch rather than letting the build succeed without it. The same
        check is why <code>--bun</code> throws for an app whose only transforms are{" "}
        <code>vitePlugins</code>, instead of building without them.
      </p>

      <h3><code>conditions</code> does not reach the Bun dev client bundle</h3>
      <p>
        On the Bun pipeline, <code>conditions</code> governs SSR - <code>nifra dev</code> passes them
        to the runtime when it re-execs - and it governs the production client bundle. It cannot govern
        the client bundle the dev server serves: Bun's dev-server bundler accepts no resolve
        conditions, and there is no <code>bunfig.toml</code> key for them either (a top-level{" "}
        <code>conditions</code>, or one under <code>[run]</code>, <code>[serve.static]</code> or{" "}
        <code>[bundle]</code>, parses and is ignored). So a package with an <code>exports</code> map
        can resolve to one file in dev and another in <code>nifra build</code>. Nifra says so once at
        startup rather than letting you find out in production. If your app depends on exact dev/prod
        client resolution, run <code>nifra dev --vite</code>.
      </p>
      <p>
        Related, if you ever pass the flag to <code>bun</code> yourself: it takes{" "}
        <strong>one condition per flag</strong>. The comma form is accepted and matches nothing,
        because Bun reads the whole string as a single condition name.
      </p>
      <CodeBlock code={CONDITIONS_FLAG} />

      <h3>Editing a non-route file updates SSR too</h3>
      <p>
        On the Bun pipeline the dev server tracks the module graph your routes import, so editing a
        component, a helper, or a server module several levels down is reflected in the next SSR
        render - not just in the browser bundle. Modules you did <em>not</em> touch keep their
        identity, so a module-level singleton stays single across the reload. Two limits are
        deliberate: files under <code>node_modules</code> are not tracked (they are dependencies, not
        your source), and a specifier only participates if it is relative and written literally - a
        computed or aliased specifier is invisible to a static graph. A third-party Bun plugin that
        rewrites imports needs to call <code>rewriteSsrImports</code> for its output to stay tracked.
      </p>

      <h3>An adapter with a compiled asset needs the dev server's loader</h3>
      <p>
        This one matters only if you are writing a render adapter. On the Vite pipeline Vite owns SSR
        resolution, which is what lets <code>resolve.dedupe</code> reach the server and keeps your app
        on one copy of the framework. Adapter packages themselves stay external to that graph, because
        the adapter's context object has to be the one instance your app imported. If such an adapter
        must load a <em>compiled</em> asset on the server - Svelte's chain component is one - a plain{" "}
        <code>import</code> reaches a runtime with no compiler for it, and registering a second
        compiler in the runtime is worse: the tree then holds two copies of the framework runtime, and
        context written by one half is invisible to the other. Load it through{" "}
        <code>ssrModuleLoader()</code> instead, and take the framework's <em>server renderer</em> from
        there as well - a component compiled by one toolchain has to render through the renderer that
        toolchain resolved.
      </p>

      <h3>Scoped class names are identical across pipelines</h3>
      <p>
        A CSS Modules class hashes to the same scoped name whichever pipeline produced it, and across
        machines - the hash is keyed on the class name plus the module's <em>package-relative</em>
        path, never an absolute one. A selector written against a generated name behaves the same under{" "}
        <code>nifra dev</code>, <code>nifra dev --bun</code>, and <code>nifra build</code>.
      </p>
    </div>
  )
}
