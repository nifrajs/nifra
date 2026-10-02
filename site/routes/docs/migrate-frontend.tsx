import { MULTIPLIERS } from "../../shared/data/benchmarks"
import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"

export const meta = docsMeta(
  "/docs/migrate-frontend",
  "Nifra - Migrating from Next.js, Nuxt, SvelteKit & SolidStart",
  "Move from a meta-framework to Nifra: file routes, data loading, API routes, layouts, and SSG/ISR map across React (Next), Vue (Nuxt), Svelte (SvelteKit), and Solid (SolidStart).",
)

function ssrMultiplier(framework: string): string {
  return MULTIPLIERS.find((item) => item.fw === framework)?.mult ?? "n/a"
}

const NEXT = `// Next.js - app/users/[id]/page.tsx
export default async function Page({ params }) {
  const res = await fetch(\`https://api/users/\${params.id}\`)
  const user = await res.json()
  return <h1>{user.name}</h1>
}

// Nifra - routes/users/[id].backend.ts: the loader, which never reaches the browser
export const loaderOutput = t.object({ name: t.string() })   // the only fields the page receives
export async function loader({ params, api }: Route.LoaderArgs) {
  const res = await api.users({ id: params.id }).get()   // typed, in-process during SSR
  if (!res.ok) throw notFound()
  return res.data
}

// Nifra - routes/users/[id].tsx: the page
export default function User({ data }: Route.ComponentProps) {
  return <h1>{data.name}</h1>
}`

const SVELTEKIT = `// SvelteKit - +page.server.ts + +page.svelte
export async function load({ params }) { return { post: await getPost(params.slug) } }

// Nifra - routes/blog/[slug].backend.ts + routes/blog/[slug].svelte
export const loaderOutput = t.object({ post: t.object({ title: t.string(), html: t.string() }) })
export async function loader({ params }: Route.LoaderArgs) { return { post: await getPost(params.slug) } }`

export default function MigrateFrontend() {
  return (
    <div className="prose">
      <h1 className="page">Migrating from a meta-framework</h1>
      <p className="lead">
        Nifra is framework-agnostic, so you keep your UI library and replace the meta-framework around
        it: Next.js → Nifra + React, Nuxt → Nifra + Vue, SvelteKit → Nifra + Svelte, SolidStart → Nifra +
        Solid. The concepts map one-to-one, and you can migrate incrementally - stand up Nifra's API
        first, point your existing app at it, then move routes over.
      </p>

      <h2>How the concepts map</h2>
      <table>
        <thead>
          <tr>
            <th>Meta-framework concept</th>
            <th>Nifra</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>File routes (`pages/`, `app/`, `routes/`)</td>
            <td>
              <code>routes/</code> - `.tsx` / `.vue` / `.svelte` / `.mdx`, same dynamic{" "}
              <code>[param]</code> / <code>[...catch-all]</code> conventions
            </td>
          </tr>
          <tr>
            <td>`getServerSideProps` · `load` · `createAsync` · `asyncData`</td>
            <td>
              <code>export async function loader()</code> in the route's <code>.backend.ts</code>{" "}
              half - runs on the server, typed into the page through <code>loaderOutput</code>
            </td>
          </tr>
          <tr>
            <td>API routes (`pages/api`, `+server.ts`, route handlers)</td>
            <td>
              a <code>server()</code> backend + the typed client - no <code>fetch()</code> wrappers
            </td>
          </tr>
          <tr>
            <td>Layouts (`layout.tsx`, `+layout`, `app.vue`)</td>
            <td>
              <code>_layout.tsx</code> - nested layout chains
            </td>
          </tr>
          <tr>
            <td>Form actions / route handlers for mutations</td>
            <td>
              <code>export async function action()</code> - typed, progressive-enhancement forms
            </td>
          </tr>
          <tr>
            <td>`getStaticProps` / `prerender` / `export const prerender`</td>
            <td>
              <code>export const prerender = true</code> (SSG) + ISR via <code>withISR</code>
            </td>
          </tr>
          <tr>
            <td>`&lt;Link&gt;` · `&lt;NuxtLink&gt;` · `&lt;a data-sveltekit-preload&gt;`</td>
            <td>Nifra's client router - `Link` + hover/focus prefetch, scroll restoration</td>
          </tr>
          <tr>
            <td>`next/image` · `nuxt/image`</td>
            <td>
              <code>&lt;Image&gt;</code> from <code>@nifrajs/web-&lt;fw&gt;/image</code>
            </td>
          </tr>
          <tr>
            <td>`metadata` / `&lt;Head&gt;` / `definePageMeta`</td>
            <td>
              <code>export const meta</code> (or a <code>meta()</code> function of the loader data)
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Data loading (Next.js → Nifra + React)</h2>
      <p>
        The biggest change: data fetching becomes a typed <code>loader</code> that calls your backend
        in-process during SSR - no <code>fetch</code> to your own API, no untyped JSON.
      </p>
      <CodeBlock code={NEXT} lang="tsx" />

      <h2>Svelte / Solid / Vue</h2>
      <p>
        Identical shape - only the page file's extension and component syntax change. The route's{" "}
        <code>.backend.ts</code> half (<code>loader</code>, <code>action</code>,{" "}
        <code>loaderOutput</code>) is the same file on every framework (that's Nifra's render seam).
        SvelteKit's <code>+page.server.ts</code> maps onto it one to one:
      </p>
      <CodeBlock code={SVELTEKIT} lang="ts" />

      <h2>What Nifra adds</h2>
      <ul>
        <li>
          <b>One model, any UI library</b> - switch React→Solid later by changing one import, not your
          app.
        </li>
        <li>
          <b>Much faster SSR</b> - the current dynamic-page snapshot reports Nifra at{" "}
          {ssrMultiplier("React")} the throughput of Next.js, {ssrMultiplier("Vue")} Nuxt, and{" "}
          {ssrMultiplier("Svelte")} SvelteKit / {ssrMultiplier("Solid")} SolidStart, with a fraction
          of the client JavaScript. See <a href="/benchmarks">benchmarks</a>.
        </li>
        <li>
          <b>End-to-end types with no codegen</b>, the same app on Bun / Node / Deno / the edge, and a
          backend you can also ship on its own. Start with <a href="/docs">Getting started</a>.
        </li>
      </ul>
      <p>
        Moving a backend (Express, Hono, Fastify, Elysia) instead? See{" "}
        <a href="/docs/migrate-backend">Migrating a backend</a>.
      </p>
    </div>
  )
}
