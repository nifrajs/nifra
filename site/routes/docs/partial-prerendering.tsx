import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/partial-prerendering",
  "Nifra - Partial prerendering (experimental)",
  "Serve a page's shared frame from a cached shell at once, then stream each per-visitor part as its own loader settles. Shared holes, server components in holes, a store shared by processes, Deno and Workers, eligibility rules, the no-JavaScript limit, proxies and connection limits.",
)

const SERVER = `import { createCspPolicy, createWebApp } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { compileShells, partialPrerendering } from "@nifrajs/web/ppr"
import { reactAdapter } from "@nifrajs/web-react"

const routesDir = "./routes"
const manifest = discoverRoutes(routesDir)
// The content-hashed client entry from your build; a shell check record is valid for it only.
const clientEntry = "/assets/entry-4c5ndncr.js"

// Fails a route whose shell reaches a module that reads the visitor. That route renders whole.
const shellChecks = await compileShells({
  routesDir,
  manifest,
  deployment: clientEntry,
  requestScoped: (file) => file.endsWith("/lib/session.ts"),
  onFailure: (routeId, error) => console.warn(routeId, error),
})

export const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry,
  // Hashes, not a nonce: a shell is one document for every visitor.
  csp: createCspPolicy({
    header: ({ sources }) => \`script-src 'self' \${sources}; object-src 'none'; base-uri 'none'\`,
  }),
  experimental: {
    ppr: partialPrerendering({ shellChecks, origin: "https://shop.example" }),
  },
})`

const BACKEND = `import { t } from "@nifrajs/schema"
import type { BoundaryRequestCtx } from "@nifrajs/web"
import { defineShellLoader } from "@nifrajs/web/ppr"
import type { Route } from "./+types/[id]"

const titles: Readonly<Record<string, string>> = { "1": "Sencha", "2": "Hojicha" }
const cartCount = (request: Request): number => (request.headers.has("cookie") ? 2 : 0)

// The shell: no request, no cookies. It is built once and shared by every visitor.
export const shellLoader = defineShellLoader(async ({ params }) => ({
  title: titles[params.id ?? ""] ?? "Tea",
}))
export const shellOutput = t.object({ title: t.string() })
export const revalidate = 60
export const revalidateTags = ["catalog"]
export const shellVariations = { search: { size: ["50g", "100g"] } }

// The holes: each runs per request, under its own deadline.
export const boundaryLoaders = {
  cart: {
    load: (ctx: BoundaryRequestCtx) => ({ count: cartCount(ctx.request) }),
    output: t.object({ count: t.number() }),
  },
} satisfies Route.BoundaryLoaders`

const REACT_PAGE = `// routes/tea/[id].tsx
import type { BoundaryStates } from "@nifrajs/web"
import { Hole } from "@nifrajs/web-react/ppr"
import { Cart } from "../../frontend/cart"

// \`as const\` keeps the name literal, so Route.BoundaryLoaders can check the backend half's keys.
const cart = {
  name: "cart",
  mode: "dynamic",
  interactive: true, // ships its props and hydrates as its own root
  render: (data: { readonly count: number }) => <Cart count={data.count} />,
  fallback: <p>Loading your cart</p>,
} as const
export const boundaries = [cart]

export default function Tea(props: { data: { title: string }; boundaries?: BoundaryStates }) {
  return (
    <main>
      <h1>{props.data.title}</h1>
      <Hole of={cart} state={props.boundaries?.cart} />
    </main>
  )
}`

const SVELTE_PAGE = `<!-- routes/tea/[id].svelte -->
<script module>
  import Hole from "@nifrajs/web-svelte/hole"
  import { ui } from "@nifrajs/web-svelte/ppr"
  import Cart from "../../frontend/Cart.svelte"
  import Loading from "../../frontend/Loading.svelte"

  const cart = {
    name: "cart",
    mode: "dynamic",
    interactive: true,
    render: (data) => ui(Cart, { count: data.count }),
    fallback: ui(Loading, { text: "Loading your cart" }),
  }
  export const boundaries = [cart]
</script>

<script>
  let { data, boundaries: states } = $props()
</script>

<main>
  <h1>{data.title}</h1>
  <Hole of={cart} state={states?.cart} />
</main>`

const VUE_PAGE = `<!-- routes/tea/[id].vue -->
<script lang="ts">
import { Hole } from "@nifrajs/web-vue/ppr"
import { h } from "vue"
import Cart from "../../frontend/Cart.vue"

// A hole renders h() output; the page around it is an ordinary template.
const cart = {
  name: "cart",
  mode: "dynamic",
  interactive: true,
  render: (data: { readonly count: number }) => h(Cart, { count: data.count }),
  fallback: h("p", "Loading your cart"),
} as const
export const boundaries = [cart]
</script>

<script setup lang="ts">
const props = defineProps(["data", "boundaries"])
</script>

<template>
  <main>
    <h1>{{ props.data.title }}</h1>
    <Hole :of="cart" :state="props.boundaries?.cart" />
  </main>
</template>`

const SOLID_PAGE = `// routes/tea/[id].tsx
import type { BoundaryStates } from "@nifrajs/web"
import { Hole } from "@nifrajs/web-solid/ppr"
import { Cart } from "../../frontend/cart"

const cart = {
  name: "cart",
  mode: "dynamic",
  interactive: true,
  render: (data: { readonly count: number }) => <Cart count={data.count} />,
  // A function: JSX evaluated at import would be one DOM node every page shares.
  fallback: () => <p>Loading your cart</p>,
} as const
export const boundaries = [cart]

export default function Tea(props: { data: { title: string }; boundaries?: BoundaryStates }) {
  return (
    <main>
      <h1>{props.data.title}</h1>
      <Hole of={cart} state={props.boundaries?.cart} />
    </main>
  )
}`

const INVALIDATE = `// doc-check: skip - continues the server snippet above (\`app\`) with an app-owned \`store\`.
import { createInvalidator } from "@nifrajs/web/cdn"
import { pprShells } from "@nifrajs/web/ppr"

const shells = pprShells(app)
const { invalidate } = createInvalidator({ store, origin: "https://shop.example", dataCaches: [shells] })

await invalidate({ tags: ["catalog"] }) // shells listing "catalog" are rebuilt on their next request
console.log(shells.stats()) // admitted, denied and shed holes, aborted slow readers, unsent bytes`

const CANARY = `// doc-check: skip - continues the server snippet above (\`app\`).
import { checkShellCanaries } from "@nifrajs/web/ppr"

// Run before the app serves traffic: a shell already cached was built without the canaries.
const leaks = await checkShellCanaries(app, ["/tea/1", "/tea/2"])
if (leaks.length > 0) throw new Error(\`visitor data in a shared shell: \${JSON.stringify(leaks)}\`)`

const SHARED_PAGE = `// doc-check: skip - an excerpt of the React page above, beside its cart hole.
const price = {
  name: "price",
  mode: "shared", // the same for every visitor: built once, cached on its own
  render: (data: { readonly amount: string }) => <p>{data.amount}</p>,
  fallback: <p>Loading the price</p>,
} as const
export const boundaries = [cart, price]`

const SHARED_BACKEND = `import { t } from "@nifrajs/schema"
import type { ShellCtx } from "@nifrajs/web"
import type { Route } from "./+types/[id]"

const prices: Readonly<Record<string, string>> = { "1": "$12.00", "2": "$9.50" }

export const boundaryLoaders = {
  // Inline, with revalidate: the build checks this loader with the shell, so its frame is stored.
  price: {
    load: async ({ params }: ShellCtx) => ({ amount: prices[params.id ?? ""] ?? "-" }),
    output: t.object({ amount: t.string() }),
    revalidate: 10,
    revalidateTags: ({ params }) => [\`price:\${params.id}\`],
  },
} satisfies Route.BoundaryLoaders`

const LIVE = `// doc-check: skip - an excerpt of a backend half, on an app created with \`live\`.
export const boundaryLoaders = {
  cart: {
    load: async ({ api, params, live }: BoundaryRequestCtx) => {
      live(\`cart:\${params.id}\`)
      return api.cart.get({ id: params.id })
    },
    output: t.object({ count: t.number() }),
  },
  price: {
    // Kept with the stored entry: publish this key with a purge of the price tag.
    load: async ({ params, live }: SharedHoleCtx) => {
      live(\`price:\${params.id}\`)
      return { amount: await priceOf(params.id) }
    },
    output: t.object({ amount: t.string() }),
    revalidate: 10,
    revalidateTags: ({ params }) => [\`price:\${params.id}\`],
  },
} satisfies Route.BoundaryLoaders`

const COMPONENT_HOLE = `// doc-check: skip - excerpts of a component file, a page, its backend half and both entries.
// Basket.component.server.tsx
export const Basket = defineServerComponent({
  input: t.object({ id: t.string() }),
  props: t.object({ title: t.string(), count: t.number() }),
  authorize: ({ request }) => requireVisitor(request),
  load: async ({ request }, input) => basketOf(request, input.id),
  view: ({ props }) => (
    <section>
      <h2>{props.title}</h2>
      <AddButton count={props.count} /> {/* a "use client" island */}
    </section>
  ),
})

// routes/tea/[id].tsx
const basket = { name: "basket", mode: "dynamic", render: serverHole(Basket) } as const
export const boundaries = [cart, basket]

// routes/tea/[id].backend.ts: the hole's loader returns the component's input
export const boundaryLoaders = {
  basket: {
    load: ({ params }: BoundaryRequestCtx) => ({ id: params.id ?? "" }),
    output: t.object({ id: t.string() }),
  },
} satisfies Route.BoundaryLoaders

// The server entry: the components each route's holes may show.
createServerComponents({ build, adapter, owners: {}, holes: { "tea/[id]": { components: [Basket] } } })

// The client entry, before the router mounts.
holeComponents(reactComponentClient())`

const STORE = `// doc-check: skip - a Worker's partialPrerendering call, with the server snippet's records.
import { KVCacheStore } from "@nifrajs/web"

partialPrerendering({
  shellChecks,
  store: new KVCacheStore(env.SHELLS),
  storeSecret: env.PPR_STORE_SECRET, // at least 32 characters, the same in every process
  deployment: env.CF_VERSION_METADATA.id,
})`

const DENO = `// doc-check: skip - continues the server snippet above (\`app\`) on Deno.
import { serve } from "@nifrajs/deno"

await serve(app, { port: 8000 })`

const OPTIONS = `// doc-check: skip - an excerpt of the server snippet's partialPrerendering call.
partialPrerendering({
  shellChecks,
  options: { holeTimeoutMs: 3_000, maxHoleWork: 256, holeHtmlValidation: "always" },
})`

export default function PartialPrerendering() {
  return (
    <div className="prose">
      <h1 className="page">Partial prerendering</h1>
      <p className="lead">
        Most of a product page is the same for everyone: the title, the description, the layout. A
        partially prerendered route serves that part from a cached shell at once, then streams each
        per-visitor part, a hole, into it as its own loader settles.
      </p>
      <blockquote>
        [!WARNING] Experimental. It is enabled through <code>experimental.ppr</code>, and its API may
        change in any release.
      </blockquote>

      <h2>Set it up</h2>
      <p>
        <code>compileShells</code> bundles each route's shell and refuses one whose emitted code
        reaches a module that reads the visitor. The shell is the page's and its layouts' whole
        modules, <code>meta</code> included, and the backend half's <code>shellLoader</code>. A route missing from its record, or from a record
        made for another deployment, renders whole. Run it in your build (Bun), and pass the record
        to <code>partialPrerendering</code>. A Svelte, Vue or Solid app passes its server plugin, such
        as <code>plugins: [svelteBunPlugin("ssr")]</code>.
      </p>
      <CodeBlock code={SERVER} lang="ts" />
      <p>
        The route's backend half exports the shell loader and one loader per hole. The shell loader
        gets params, locale, the declared variations, <code>origin</code> from config and the
        in-process <code>api</code>, never the request. With{" "}
        <code>satisfies Route.BoundaryLoaders</code>, a misspelt or missing hole is a type error
        when the page is a <code>.tsx</code> file whose boundary names are literal types; the
        manifest refuses an unknown key at startup either way.
      </p>
      <CodeBlock code={BACKEND} lang="ts" />
      <p>The page places each hole with the adapter's hole component.</p>
      <CodeBlock code={REACT_PAGE} lang="tsx" />
      <p>
        A Preact page is the same, with <code>/** @jsxImportSource preact */</code> at the top and{" "}
        <code>Hole</code> from <code>@nifrajs/web-preact/ppr</code>. Svelte places a hole with its
        own component and wraps each render in <code>ui(Component, props)</code>.
      </p>
      <CodeBlock code={SVELTE_PAGE} lang="svelte" />
      <p>
        A Vue page builds its holes with <code>h()</code> and places them in its template; the
        hole's <code>error</code> slot shows when its loader failed.
      </p>
      <CodeBlock code={VUE_PAGE} lang="vue" />
      <p>
        A Solid page's <code>fallback</code> is a function returning JSX, so each place that shows
        it gets its own nodes.
      </p>
      <CodeBlock code={SOLID_PAGE} lang="tsx" />
      <p>
        <code>nifra scaffold hole &lt;route&gt; &lt;name&gt;</code> writes a hole into both halves:
        its definition, its <code>boundaries</code> entry and the <code>Hole</code> in a JSX page,
        and a loader with its output schema in the backend half. <code>--shared</code>,{" "}
        <code>--interactive</code> and <code>--timeout &lt;ms&gt;</code> shape it, and{" "}
        <code>--server</code> makes it show a new React server component. A Vue or Svelte page gets
        the code to paste. <code>nifra check</code> reports a page that calls{" "}
        <code>getContext()</code> or <code>tryGetContext()</code> (NF-C053), and{" "}
        <code>nifra fix --code NF-C053</code> moves a read held in one <code>const</code>, with the
        one element that uses it, into a new dynamic hole whose loader makes the read.
      </p>
      <p>
        The import check cannot see visitor data an app keeps in module state, such as a variable
        middleware writes. <code>checkShellCanaries</code> requests each path once with unique values
        in a cookie, <code>Authorization</code>, a header and the query, and reports each value found
        in the shared shell or in a shared hole's frame (the finding names the hole).
      </p>
      <CodeBlock code={CANARY} lang="ts" />

      <h2>Which routes qualify</h2>
      <ul>
        <li>
          The backend half exports <code>shellLoader</code>, and not <code>loader</code> or{" "}
          <code>prerender = true</code>.
        </li>
        <li>
          It declares 1 to 32 <code>dynamic</code> or <code>shared</code> boundaries, each with a{" "}
          <code>boundaryLoaders</code> entry. Names are 1-32 lowercase letters, digits and single
          hyphens, start with a letter and do not end with a hyphen.
        </li>
        <li>
          A hole's <code>timeout</code> is 1 to 30000 ms (default 5000). The response ends by the
          largest timeout plus one second, at most 30 seconds.
        </li>
        <li>
          A layout above it may have a loader only as a <code>gate</code>: the gate runs to redirect
          or refuse, and its data reaches no response. Intercepting boundaries are not supported.
        </li>
        <li>
          <code>shellVariations</code> lists closed sets of query values that each select their own
          shell. Any other parameter or value shares the default shell.
        </li>
        <li>
          The app uses <code>csp: createCspPolicy(...)</code>, not <code>nonce</code>. Under enforced
          Trusted Types, its <code>trusted-types</code> directive lists <code>nifra-ppr</code>,
          beside any policy the UI framework creates (Svelte's is <code>svelte-trusted-html</code>,
          Vue's <code>vue</code>). Solid's client renders new DOM from plain strings under no policy,
          so a Solid app cannot enforce Trusted Types.
        </li>
      </ul>

      <h2>What each request gets</h2>
      <table>
        <thead>
          <tr>
            <th>Request</th>
            <th>Response</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>A browser's first load</td>
            <td>The shell at once, each hole's fallback in place, then each hole as it settles</td>
          </tr>
          <tr>
            <td>A client navigation</td>
            <td>The shell data, then each hole as a streamed value; leaving cancels the rest</td>
          </tr>
          <tr>
            <td>A hover prefetch</td>
            <td>The shell data only; no hole loader starts</td>
          </tr>
          <tr>
            <td>
              A listed bot (<code>blockingFor</code>), a draft, or a route whose shell is unchecked
              or at its build limit
            </td>
            <td>The whole page, every hole rendered in place</td>
          </tr>
          <tr>
            <td>
              Once the shell store is full, a page whose shell key has had fewer requests than{" "}
              <code>shellAfterRequests</code> (default 2)
            </td>
            <td>The whole page streamed, each hole as it settles; no shell is built</td>
          </tr>
        </tbody>
      </table>
      <p>
        A hole cannot redirect or set a status: the shell's status and headers are already sent, so a
        hole whose loader returns or throws a redirect or a status renders its error state. A page
        cache such as <code>withISR</code> never stores the route's response, however it rendered.
      </p>
      <p>
        A shell older than <code>revalidate</code> is served while one rebuild runs; a failing
        rebuild keeps the old one for up to ten times <code>revalidate</code>, at most a day. A shell
        loader's <code>notFound()</code> is remembered for 60 seconds. A shell or shared hole build
        that runs past <code>maxHoleTimeoutMs</code> fails every request waiting on it and keeps
        nothing it returns later; until its loader does end, it still counts against the route's{" "}
        <code>shellBuildConcurrency</code>.
      </p>

      <h2>Shared holes</h2>
      <p>
        A part that is the same for every visitor but changes faster than the shell, such as a price
        or a stock level, is a <code>shared</code> hole. Its loader gets the shell's context, never
        the request, so a hole that should have been per visitor shows generic content, never one
        visitor's data to another. It is built once per route, params, locale and variations, and
        kept on its own <code>revalidate</code> (required, in seconds) and{" "}
        <code>revalidateTags</code>, apart from the shell.
      </p>
      <CodeBlock code={SHARED_PAGE} lang="tsx" />
      <CodeBlock code={SHARED_BACKEND} lang="ts" />
      <ul>
        <li>
          A frame this process holds goes out with the shell, in its first write. On a miss the
          visitor waits up to the hole's <code>timeout</code>, then gets the error slot while the
          build finishes for the next visitor.
        </li>
        <li>
          An older frame is served while one rebuild runs. A failed build is never stored: the old
          frame stays for up to ten times <code>revalidate</code>, at most a day.
        </li>
        <li>
          Builds count against the route's <code>shellBuildConcurrency</code>; past it, a missing
          frame is built anyway as hole work under <code>maxHoleWork</code>, and stored.
        </li>
        <li>
          <code>compileShells</code> bundles each shared loader with the shell and refuses the route
          if it reaches a module that reads the visitor. It finds an entry written inline in{" "}
          <code>boundaryLoaders</code> with <code>revalidate</code>; any other shared hole loads for
          every visitor and warns once in development.
        </li>
        <li>A draft loads it fresh and never reads or fills the cache.</li>
      </ul>

      <h2>When the page reloads</h2>
      <p>
        After an action posted from the page, and when a live key its holes read changes (
        <code>createWebApp(&#123; live &#125;)</code>), the router reloads the page on screen. A page
        the partially prerendered document filled keeps its holes where they are: each hole's new
        HTML, with props for an interactive one, goes into its host in place.
      </p>
      <ul>
        <li>
          An interactive hole's own root renders the new props and keeps its state. A Solid root gets
          object props through a store, so a component that reads them in JSX updates; Svelte keeps
          the root while the render picks the same component.
        </li>
        <li>
          The old content stays until the new arrives. A hole whose reload fails shows its error
          slot, never content from before the action. A reload overtaken by a newer one is dropped,
          and leaving the page aborts its hole loaders on the server.
        </li>
        <li>
          After a client navigation the holes render as streamed boundaries, and reload as they do.
        </li>
      </ul>
      <p>
        A hole loader declares its live keys with <code>ctx.live(...)</code>, as a page loader does.
        A change reloads only the holes whose keys changed; the live load keeps the rest. The page's
        grant comes after its holes, in one trailing frame of the reload, and holds each hole that
        loaded: a hole that failed or timed out is not watched until it loads again. The shell and
        the first document carry no grant. A shared hole's keys are kept with its stored entry, and
        the entry answers the reload until it is dropped, so publish a shared hole's key together
        with a purge of its tag.
      </p>
      <CodeBlock code={LIVE} lang="ts" />

      <h2>Server components in holes</h2>
      <p>
        A <code>dynamic</code> hole can show a server component: <code>serverHole(Basket)</code>, from{" "}
        <code>@nifrajs/web/server-components/hole</code>, is its <code>render</code>. The hole's loader
        returns the component's input; the component authorizes, loads and renders on the server for
        each request. The browser gets its HTML and the code of its client islands, never its view or
        anything its loader returned beyond its props. Like every server component, it needs the
        coordinated compiler (<code>buildServerComponents</code>).
      </p>
      <CodeBlock code={COMPONENT_HOLE} lang="tsx" />
      <ul>
        <li>
          List each route's hole components in <code>createServerComponents(&#123; holes &#125;)</code>.
          A route that shows a server component the list leaves out fails, and a route either owns
          server components or shows them in holes, never both.
        </li>
        <li>
          The hole is not interactive. Its loader declares an <code>output</code> like any hole's: its
          value reaches the browser as the component's input.
        </li>
        <li>
          The component reads the visitor's request, under the hole's timeout and admission. It cannot
          set a cookie or a header, since the shell sent them already: a component that tries shows
          the error slot, as does an input or authorization it refuses.
        </li>
        <li>
          Call <code>holeComponents</code> in the client entry before the router mounts, with the
          adapter's component client, such as <code>reactComponentClient()</code> or{" "}
          <code>vueComponentClient(&#123; islands &#125;)</code>. Without it the hole shows its error
          slot.
        </li>
        <li>
          The hole is a host on every load: a client navigation mounts it from its fill, and a
          crawler's blocking render has its HTML in the host. A reload puts the new HTML in and mounts
          its islands afresh, so they do not keep their state.
        </li>
      </ul>

      <h2>Across processes</h2>
      <p>
        Each process keeps its own shells and shared frames. Give <code>partialPrerendering</code> a{" "}
        <code>store</code> the processes share, such as Workers KV, and a process that has not built
        an entry reads it from there. Every entry is signed with <code>storeSecret</code> over its key,
        deployment and contents, so a store other services can write cannot hand visitors a page this
        app did not build; one that fails the check is a miss. Entries are kept apart per deployment:
        the client build, each route's checked shell code and the optional <code>deployment</code>{" "}
        name all go into the key. A route whose tags the store cannot drop keeps its entries in the
        process, with one warning. A process reads an entry it holds from the store again once{" "}
        <code>sharedRecheckMs</code> (default 1000) has passed, so a purge made on another process
        reaches it within that time; a store that does not answer within <code>holeTimeoutMs</code>{" "}
        counts as a miss.
      </p>
      <CodeBlock code={STORE} lang="ts" />

      <h2>Runtimes</h2>
      <ul>
        <li>Bun and Node serve it as they serve any nifra app.</li>
        <li>
          Deno serves it through <code>@nifrajs/deno</code>; a hang-up aborts the holes still
          running.
        </li>
        <li>
          On Cloudflare Workers, the shell store defaults to 8 MB and the cancel beacon is off, since
          it would reach another isolate: a hole the visitor left stops at its deadline. Rebuilds and
          store writes run through <code>waitUntil</code>. Workers compress responses themselves, so{" "}
          <code>compression()</code> leaves them alone there. A shell that imports{" "}
          <code>cloudflare:workers</code> fails its check: that module hands any code the Worker's{" "}
          <code>env</code>.
        </li>
      </ul>
      <CodeBlock code={DENO} lang="ts" />

      <h2>Without JavaScript</h2>
      <p>
        A hole's HTML arrives as inert data that the inline runtime inserts, so a browser with
        scripts off sees the shell and each hole's fallback, never the hole. Nothing in a single
        streamed response can fill a hole without script. Listed bots get the whole page instead. If
        a route's per-visitor part must work without JavaScript, do not partially prerender it. In
        development, a hole whose fallback renders empty warns once per route.
      </p>

      <h2>Behind a proxy</h2>
      <ul>
        <li>
          The stream must reach the browser as it is written. Responses carry{" "}
          <code>X-Accel-Buffering: no</code>, which nginx honors; turn response buffering off for
          other proxies.
        </li>
        <li>
          Compression in front of the app must flush after every write, or the holes arrive with the
          last one. <code>compression()</code> from <code>@nifrajs/middleware</code> does.
        </li>
        <li>
          Responses are <code>Cache-Control: private, no-store</code>: the holes are per visitor. The
          shell is cached in the server process, keyed by deployment, route, locale, path and
          declared variations.
        </li>
        <li>
          Leaving a page posts a cancel beacon to <code>/__nifra/ppr/cancel</code>; forward it.
        </li>
        <li>
          Set <code>origin</code>: the shell and its <code>meta</code> never read the Host header.
        </li>
        <li>
          A proxy's read timeout must exceed the response deadline: the largest hole timeout plus
          one second, plus <code>writeGraceMs</code> (5 s) for a slow reader.
        </li>
      </ul>

      <h2>Connection limits are yours to set</h2>
      <p>
        Each document holds its connection open until its slowest hole ends. nifra bounds the work
        behind those connections: <code>maxHoleWork</code> responses with hole loaders running per
        process; a loader that ignores its abort stops being admitted; a response whose client stops
        reading sends its later holes as errors once 1 MB is unsent, and the slowest readers are cut
        off when the process's unsent bytes pass 64 MB. It does not bound the number of open
        sockets. Set a connection limit at the proxy or load balancer, or
        in the runtime where it offers one (Node's <code>server.maxConnections</code>).
      </p>

      <h2>Limits and defaults</h2>
      <p>
        Every number above is a default in <code>PPR_DEFAULTS</code>, overridden per app through{" "}
        <code>options</code>; contradicting limits throw at startup.
      </p>
      <CodeBlock code={OPTIONS} lang="ts" />

      <h2>Invalidation and metrics</h2>
      <p>
        <code>pprShells(app)</code> is the app's shell cache. Give it to{" "}
        <code>createInvalidator</code> as a data cache, so a purge by tag also drops the shells
        built from the purged data; a shell build already running when the purge lands is not kept.
      </p>
      <CodeBlock code={INVALIDATE} lang="ts" />
    </div>
  )
}
