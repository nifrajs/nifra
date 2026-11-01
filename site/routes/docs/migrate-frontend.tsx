import { ssrMultiplier } from "../../shared/data/benchmarks"
import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/migrate-frontend",
  "Nifra - Migrating React, Preact, Solid, Vue & Svelte apps",
  "Migrate a Next.js, Remix, Preact, SolidStart, Nuxt, or SvelteKit frontend to Nifra while keeping React, Preact, Solid, Vue, or Svelte.",
)

const SHARED_LOADER = `// routes/users/[id].backend.ts - server-only data work, shared by every UI adapter
import { t } from "@nifrajs/schema"
import { notFound } from "@nifrajs/web"
import type { Route } from "./+types/[id]"

export const loaderOutput = t.object({ id: t.string(), name: t.string() })
export const loader: Route.Loader = async ({ params, api }) => {
  const result = await api.users({ id: params.id }).get()
  if (!result.ok) throw notFound()
  return result.data
}`

const REACT_PAGE = `// routes/users/[id].tsx - React page, data is inferred from loaderOutput
import type { Route } from "./+types/[id]"

export default function User({ data }: Route.ComponentProps) {
  return <h1>{data.name}</h1>
}`

const PREACT_PAGE = `/** @jsxImportSource preact */
// routes/users/[id].tsx - Preact uses the same route and loader shape
import type { Route } from "./+types/[id]"

export default function User({ data }: Route.ComponentProps) {
  return <h1>{data.name}</h1>
}`

const SOLID_PAGE = `// routes/users/[id].tsx - keep Solid components and JSX
import type { Route } from "./+types/[id]"

export default function User(props: Route.ComponentProps) {
  return <h1>{props.data.name}</h1>
}`

const VUE_PAGE = `<!-- routes/users/[id].vue - the view stays a Vue Single-File Component -->
<script setup lang="ts">
const props = defineProps<{ data: { id: string; name: string } }>()
</script>

<template>
  <h1>{{ props.data.name }}</h1>
</template>`

const SVELTE_PAGE = `<!-- routes/users/[id].svelte - Svelte 5 props -->
<script lang="ts">
  let { data }: { data: { id: string; name: string } } = $props()
</script>

<h1>{data.name}</h1>`

export default function MigrateFrontend() {
  return (
    <div className="prose">
      <h1 className="page">Migrate a frontend</h1>
      <p className="lead">
        Keep your UI framework and replace the meta-framework around it. Nifra has adapters for
        React, Preact, Solid, Vue, and Svelte; the routes, loaders, actions, and rendering features
        work the same across all five.
      </p>
      <p>
        This guide covers React apps from Next.js or Remix / React Router, Preact SSR apps, SolidStart,
        Nuxt, and SvelteKit. Move one route at a time: copy the view, move its server data work into
        the matching <code>.backend.ts</code> file, and let the loader schema define what reaches the
        browser.
      </p>
      <p>
        Scaffold the adapter you want with{" "}
        <code>bun create nifra my-app --framework react</code> (replace <code>react</code> with{" "}
        <code>preact</code>, <code>solid</code>, <code>vue</code>, or <code>svelte</code>). See{" "}
        <a href={href({ to: "/docs/frameworks" })}>Frameworks</a> for adapter setup and file formats.
      </p>

      <h2 id="map">Map the route and data model</h2>
      <table>
        <thead>
          <tr>
            <th>Starting point</th>
            <th>Nifra adapter and page</th>
            <th>Move server data to</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Next.js, Remix, React Router</td>
            <td>React, <code>routes/example.tsx</code></td>
            <td>route <code>.backend.ts</code></td>
          </tr>
          <tr>
            <td>Preact SSR / Fresh</td>
            <td>Preact, <code>routes/example.tsx</code></td>
            <td>route <code>.backend.ts</code></td>
          </tr>
          <tr>
            <td>SolidStart</td>
            <td>Solid, <code>routes/example.tsx</code></td>
            <td>route <code>.backend.ts</code></td>
          </tr>
          <tr>
            <td>Nuxt</td>
            <td>Vue, <code>routes/example.vue</code></td>
            <td>route <code>.backend.ts</code></td>
          </tr>
          <tr>
            <td>SvelteKit</td>
            <td>Svelte, <code>routes/example.svelte</code></td>
            <td>route <code>.backend.ts</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        A route is a view file plus its server half: for example{" "}
        <code>routes/users/[id].tsx</code> and <code>routes/users/[id].backend.ts</code>. Dynamic
        segments keep the <code>[param]</code> convention. Layouts move to{" "}
        <code>_layout.tsx</code> (or the matching adapter format); API handlers move to a{" "}
        <code>server()</code> backend and can be called in-process by loaders.
      </p>

      <h2 id="data">Move data loading and mutations once</h2>
      <p>
        Replace <code>getServerSideProps</code>, route <code>loader</code> functions,{" "}
        <code>useAsyncData</code>, and <code>+page.server.ts</code> with the same Nifra loader. It
        runs on the server, calls your API in-process during SSR, and returns only fields allowed by
        <code>loaderOutput</code>. Put mutations in <code>action</code>; native forms still work
        without JavaScript and client submissions revalidate the page data.
      </p>
      <CodeBlock code={SHARED_LOADER} lang="ts" />

      <h2 id="react">React - Next.js, Remix, and React Router</h2>
      <p>
        Keep the React component. Move server fetching from a Next page, Server Component, or
        framework route loader into the paired backend file above. A route component receives typed
        <code>data</code> as a prop. Nifra does not require React Server Components; if you need them,
        they are an opt-in feature on the shared route model; see{" "}
        <a href={href({ to: "/docs/server-components" })}>Server components</a>.
      </p>
      <CodeBlock code={REACT_PAGE} lang="tsx" />

      <h2 id="preact">Preact - Preact SSR and Fresh</h2>
      <p>
        Keep Preact JSX and component state. Replace Fresh or custom SSR route data with the shared
        backend loader, then author the page as a <code>.tsx</code> route using the Preact adapter.
        Fresh-specific middleware and route conventions move to Nifra&apos;s backend and file routes.
      </p>
      <CodeBlock code={PREACT_PAGE} lang="tsx" />

      <h2 id="solid">Solid - SolidStart</h2>
      <p>
        Keep Solid components and signals. Move SolidStart route data into the shared loader; the
        page stays a <code>.tsx</code> file, with the loader result passed through props.
      </p>
      <CodeBlock code={SOLID_PAGE} lang="tsx" />

      <h2 id="vue">Vue - Nuxt</h2>
      <p>
        Move <code>useAsyncData</code> and server-only calls from Nuxt pages into the backend loader.
        Keep the template and author the Nifra route as a Vue Single-File Component. Its frontmatter
        exports live in the plain <code>&lt;script&gt;</code>; component props and markup live in{" "}
        <code>&lt;script setup&gt;</code> and <code>&lt;template&gt;</code>.
      </p>
      <CodeBlock code={VUE_PAGE} lang="vue" />

      <h2 id="svelte">Svelte - SvelteKit</h2>
      <p>
        Move <code>+page.server.ts</code> data loading to the paired backend file. Keep the{" "}
        <code>+page.svelte</code> markup and component logic in a Nifra <code>.svelte</code> route;
        Svelte 5 receives route data through <code>$props()</code>.
      </p>
      <CodeBlock code={SVELTE_PAGE} lang="svelte" />

      <h2 id="features">Map the rest of your frontend</h2>
      <table>
        <thead>
          <tr>
            <th>Existing feature</th>
            <th>Nifra equivalent</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Nested layouts</td>
            <td><code>_layout.tsx</code> or the adapter&apos;s layout format; parent data is shared with child routes</td>
          </tr>
          <tr>
            <td>API route handlers</td>
            <td>A <code>server()</code> backend; loaders can use its typed client directly during SSR</td>
          </tr>
          <tr>
            <td>Form actions and mutations</td>
            <td>Route <code>action</code> plus native form POST; client submissions revalidate loader data</td>
          </tr>
          <tr>
            <td>Static generation and ISR</td>
            <td><code>prerender = true</code> for SSG; <code>withISR</code> for revalidation</td>
          </tr>
          <tr>
            <td>Metadata and document head</td>
            <td>Named <code>meta</code> export, or a function of the loader data</td>
          </tr>
          <tr>
            <td>Link prefetch and scroll restore</td>
            <td>Nifra&apos;s client router and <code>Link</code>, with hover/focus prefetch and scroll restoration</td>
          </tr>
          <tr>
            <td>Image components</td>
            <td><code>Image</code> from <code>@nifrajs/web-&lt;framework&gt;/image</code></td>
          </tr>
          <tr>
            <td>Tag or path revalidation</td>
            <td>An action&apos;s <code>revalidate(paths, data, {"{"} tags {"}"})</code> or <code>revalidateEndpoint</code> for a webhook</td>
          </tr>
          <tr>
            <td>Partial prerendering</td>
            <td><code>shellLoader</code> and boundary loaders; see <a href={href({ to: "/docs/partial-prerendering" })}>Partial prerendering</a></td>
          </tr>
          <tr>
            <td>Intercepted modal routes</td>
            <td>A route boundary with an <code>intercept</code> target; see <a href={href({ to: "/docs/routing", hash: "modal-routes" })}>Modal routes</a></td>
          </tr>
          <tr>
            <td>Keep-alive pages</td>
            <td><code>keepAlive = true</code>; see <a href={href({ to: "/docs/keep-alive" })}>Keep-alive</a></td>
          </tr>
        </tbody>
      </table>

      <h2 id="shared">What stays the same across adapters</h2>
      <ul>
        <li>Nested routes, layouts, metadata, forms, streaming, SSG, and ISR use the shared route model.</li>
        <li>Route loaders and actions stay server-only; output schemas bound the data sent to the browser.</li>
        <li>Switching among React, Preact, Solid, Vue, and Svelte changes the adapter and view syntax, not your backend contract.</li>
      </ul>
      <p>
        Moving an API server too? See{" "}
        <a href={href({ to: "/docs/migrate-backend" })}>Migrate a backend</a>. For the full
        rendering and route model, see <a href={href({ to: "/docs/data" })}>Loaders &amp; actions</a>{" "}
        and <a href={href({ to: "/docs/routing" })}>Routing</a>.
      </p>
      <p>
        The current dynamic SSR snapshot reports Nifra at {ssrMultiplier("React")} the throughput
        of Next.js, {ssrMultiplier("Vue")} Nuxt, {ssrMultiplier("Svelte")} SvelteKit, and{" "}
        {ssrMultiplier("Solid")} SolidStart on the measured pages. See the{" "}
        <a href={href({ to: "/benchmarks" })}>benchmark methodology and full results</a>.
      </p>
    </div>
  )
}
