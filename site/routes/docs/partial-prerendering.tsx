import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/partial-prerendering",
  "Nifra - Partial prerendering (experimental)",
  "Serve a page's shared frame from a cached shell at once, then stream each per-visitor part as its own loader settles. Eligibility rules, the no-JavaScript limit, proxies and connection limits.",
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
        reaches a module that reads the visitor. A route missing from its record, or from a record
        made for another deployment, renders whole. Run it in your build (Bun), and pass the record
        to <code>partialPrerendering</code>. A Svelte app passes its server plugin as{" "}
        <code>plugins: [svelteBunPlugin("ssr")]</code>.
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
      <CodeBlock code={SVELTE_PAGE} lang="svelte" />
      <p>
        The import check cannot see visitor data an app keeps in module state, such as a variable
        middleware writes. <code>checkShellCanaries</code> requests each path once with unique values
        in a cookie, <code>Authorization</code>, a header and the query, and reports each value found
        in the shared shell.
      </p>
      <CodeBlock code={CANARY} lang="ts" />

      <h2>Which routes qualify</h2>
      <ul>
        <li>
          The backend half exports <code>shellLoader</code>, and not <code>loader</code> or{" "}
          <code>prerender = true</code>.
        </li>
        <li>
          It declares 1 to 32 <code>dynamic</code> boundaries, each with a{" "}
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
          beside any policy the UI framework creates (Svelte's is <code>svelte-trusted-html</code>).
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
              <code>shellAfterRequests</code> (default 1)
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
        loader's <code>notFound()</code> is remembered for 60 seconds.
      </p>

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
        off when the process's unsent bytes pass 256 MB. It does not bound the number of open
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
