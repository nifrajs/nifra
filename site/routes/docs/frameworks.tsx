import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Frameworks",
  "One agnostic core, five UI frameworks: React, Solid, Vue, Preact, and Svelte — same loaders, streaming, islands, and routing, unchanged.",
)

// Same minimal counter app (a layout + a $state/useState counter), each bundled minified for the
// browser via Bun.build. Apples-to-apples — see examples/web-{react,solid,vue,preact,svelte}.
const FRAMEWORKS: ReadonlyArray<{
  name: string
  pkg: string
  idiom: string
  plugin: string
  bundle: string
}> = [
  { name: "Solid", pkg: "@nifrajs/web-solid", idiom: "primitives", plugin: "Babel", bundle: "~15 KB" },
  { name: "Preact", pkg: "@nifrajs/web-preact", idiom: "hooks (React-compat)", plugin: "none", bundle: "~18 KB" },
  { name: "Svelte 5", pkg: "@nifrajs/web-svelte", idiom: "stores + runes", plugin: ".svelte compiler", bundle: "~49 KB" },
  { name: "Vue 3", pkg: "@nifrajs/web-vue", idiom: "composables", plugin: ".vue SFC (or render fns)", bundle: "~66 KB" },
  { name: "React 19", pkg: "@nifrajs/web-react", idiom: "hooks", plugin: "none (Bun JSX)", bundle: "~182 KB" },
]

const SWAP = `// Server — pick an adapter. Everything else is identical across all five frameworks:
// the same routes, loaders, actions, streaming, <Await>, fetchers, query cache.
import { createWebApp } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"   // ← or web-solid · web-vue · web-preact · web-svelte

const app = createWebApp({
  adapter: reactAdapter,   // the one line that changes per framework
  manifest,
  clientEntry,             // the built client bundle (from buildClient's manifest)
  api,
})`

const BINDINGS = `// The data primitives — same names + behaviour everywhere, each in the framework's idiom.
// React / Preact — hooks:
const fetcher = useFetcher("save")          // fetcher.submit(...), fetcher.pending
const q = useQuery(["todos"], loadTodos)    // q.data, q.isFetching, q.refetch()

// Vue — composables (refs):           const f = useFetcher("save"); f.state.value.pending
// Solid — signals:                    const q = useQuery(...);       q().data
// Svelte — stores (read with $):      const f = useFetcher("save");  $f.pending`

const SCAFFOLD = `# Scaffold a multi-target SSR site in any of the five (react is the default):
bun create nifra my-app --framework solid      # or react · preact · vue · svelte

# Composes with the deploy preset — pick a framework AND a default deploy target:
bun create nifra my-app --framework svelte --deploy vercel`

const VUE_SFC = `<!-- routes/index.vue — a nifra route authored as a Vue Single-File Component -->
<script lang="ts">
// The plain <script> carries nifra's route convention (server-only named exports):
export const meta = { title: "Home" }
export async function loader({ api }) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}
</script>

<script setup lang="ts">
defineProps(["data"])          // nifra passes the loader data in as \`data\`
</script>

<template>
  <h1>Count: {{ data.count }}</h1>
</template>`

export default function Frameworks() {
  return (
    <div className="prose">
      <h1 className="page">Frameworks</h1>
      <p className="lead">
        Nifra renders <b>five UI frameworks on one agnostic core</b>. The render seam, file-based
        routes, typed loaders/actions, streaming, islands, prefetch, and the client router are
        shared across adapters, while each page still uses its framework's normal component style.
      </p>

      <h2>Scaffold any of them</h2>
      <p>
        <code>create-nifra</code>'s <code>--framework</code> flag scaffolds the multi-target SSR site
        with the adapter, routes, build wiring, and deps for your pick. It composes with{" "}
        <code>--deploy</code>, so one command gives you a framework + a default deploy target.
      </p>
      <CodeBlock code={SCAFFOLD} />

      <h2>The adapters</h2>
      <table>
        <thead>
          <tr>
            <th>Framework</th>
            <th>Package</th>
            <th>UI idiom</th>
            <th>Build plugin</th>
            <th className="num">Hydration bundle</th>
          </tr>
        </thead>
        <tbody>
          {FRAMEWORKS.map((f) => (
            <tr key={f.pkg}>
              <td>{f.name}</td>
              <td>
                <code>{f.pkg}</code>
              </td>
              <td>{f.idiom}</td>
              <td>{f.plugin}</td>
              <td className="num">{f.bundle}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="caveat">
        <b>Bundle</b> = the same minimal counter app, minified (not gzipped), for each framework —
        see <code>examples/web-*</code>. Indicative payload, not a benchmark.
      </div>

      <h2>Authoring routes</h2>
      <p>
        A route's <code>default</code> export is the component; its <code>loader</code>/
        <code>action</code>/<code>meta</code> are named exports. Most adapters write <code>.tsx</code>,
        but the compiled frameworks use their native single-file format — <b>Svelte</b>{" "}
        <code>.svelte</code> (loader/meta in <code>&lt;script module&gt;</code>) and <b>Vue</b>{" "}
        <code>.vue</code> SFCs (loader/meta in the plain <code>&lt;script&gt;</code>; the component in{" "}
        <code>&lt;script setup&gt;</code> + <code>&lt;template&gt;</code>) — each compiled by its
        package's Bun plugin (<code>@nifrajs/web-vue/plugin</code>, <code>@nifrajs/web-svelte/plugin</code>).
      </p>
      <CodeBlock code={VUE_SFC} />
      <div className="caveat">
        Component <code>&lt;style scoped&gt;</code> (Vue) and <code>&lt;style&gt;</code> (Svelte —
        scoped by default) are compiled and scoped into the app stylesheet — no runtime, no FOUC — plus
        CSS Modules and global imports. See <a href="/docs/dev">Dev &amp; HMR → Styling</a>.{" "}
        <code>examples/routing-vue-sfc</code> is a full SSR + hydration + client-nav demo.
      </div>

      <h2>Same features, every framework</h2>
      <p>Every adapter gets Nifra's full feature set — not a subset:</p>
      <ul>
        <li>Streaming SSR + hydration (islands), with component-level Suspense.</li>
        <li>
          File-based routing, nested layouts, typed <code>loader</code>/<code>action</code>, and
          progressive-enhancement forms (work with JS off).
        </li>
        <li>
          <code>&lt;Await&gt;</code> for deferred data (<code>defer()</code>), a keyed query cache (
          <code>useQuery</code>), and concurrent <code>useFetcher</code> mutations.
        </li>
        <li>Optimistic UI, targeted revalidation, hover-prefetch, and scroll restoration.</li>
        <li>
          True HMR in dev for all five (<code>@nifrajs/web/vite</code>) — see{" "}
          <a href="/docs/dev">Dev &amp; HMR</a>.
        </li>
      </ul>

      <h2>One line changes</h2>
      <p>
        The adapter is the only framework-specific choice on the server. Swap it and the entire app —
        routes, data, streaming — runs on a different framework, unchanged.
      </p>
      <CodeBlock code={SWAP} />

      <h2>Idiomatic, not lowest-common-denominator</h2>
      <p>
        The bindings share names and behaviour across frameworks, but each is expressed the native
        way — React/Preact hooks, Vue composables, Solid signals, Svelte stores.
      </p>
      <CodeBlock code={BINDINGS} />

      <h2>Deferred data behavior</h2>
      <p>
        React, Preact, and Solid <b>stream</b> a <code>&lt;Await&gt;</code> boundary — the fallback
        flushes in the SSR HTML, then the resolved content streams in (it works with JS off). Vue and
        Svelte resolve deferred data on the <b>client</b>, so JS-off users see the fallback for that
        deferred boundary. Put critical page data in the route <code>loader</code>; use{" "}
        <code>defer()</code> for slower, non-critical data.
      </p>

      <h2>Dev HMR support</h2>
      <p>
        Dev HMR works for all five adapters through <code>createViteDevServer</code> and the
        framework&apos;s Vite plugin. React, Preact, and Vue preserve edited component state. Solid
        and Svelte update live without a full page reload, and the edited component may remount. Full
        matrix in <a href="/docs/dev">Dev &amp; HMR</a>.
      </p>
    </div>
  )
}
