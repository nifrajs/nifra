import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Migrating from Next.js, Nuxt, SvelteKit & SolidStart",
  "Move from a meta-framework to Nifra: file routes, data loading, API routes, layouts, and SSG/ISR map across React (Next), Vue (Nuxt), Svelte (SvelteKit), and Solid (SolidStart).",
)

const NEXT = `// Next.js — app/users/[id]/page.tsx
export default async function Page({ params }) {
  const res = await fetch(\`https://api/users/\${params.id}\`)
  const user = await res.json()
  return <h1>{user.name}</h1>
}

// nifra — routes/users/[id].tsx
export async function loader({ params, api }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id }).get()   // typed, in-process during SSR
  return { user: res.data }
}
export default function User({ data }: { data: LoaderData<typeof loader> }) {
  return <h1>{data.user?.name}</h1>
}`

const SVELTEKIT = `// SvelteKit — +page.server.ts + +page.svelte
export async function load({ params }) { return { post: await getPost(params.slug) } }

// nifra — routes/blog/[slug].svelte (loader is a module export, page is the .svelte)
export async function loader({ params }) { return { post: await getPost(params.slug) } }`

export default function MigrateFrontend() {
  return (
    <div className="prose">
      <h1 className="page">Migrating from a meta-framework</h1>
      <p className="lead">
        Nifra is framework-agnostic, so you keep your UI library and replace the meta-framework around
        it: Next.js → Nifra + React, Nuxt → Nifra + Vue, SvelteKit → Nifra + Svelte, SolidStart → Nifra +
        Solid. The concepts map one-to-one, and you can migrate incrementally — stand up Nifra's API
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
              <code>routes/</code> — `.tsx` / `.vue` / `.svelte` / `.mdx`, same dynamic{" "}
              <code>[param]</code> / <code>[...catch-all]</code> conventions
            </td>
          </tr>
          <tr>
            <td>`getServerSideProps` · `load` · `createAsync` · `asyncData`</td>
            <td>
              <code>export async function loader()</code> — runs on the server, typed into the page
            </td>
          </tr>
          <tr>
            <td>API routes (`pages/api`, `+server.ts`, route handlers)</td>
            <td>
              a <code>server()</code> backend + the typed client — no <code>fetch()</code> wrappers
            </td>
          </tr>
          <tr>
            <td>Layouts (`layout.tsx`, `+layout`, `app.vue`)</td>
            <td>
              <code>_layout.tsx</code> — nested layout chains
            </td>
          </tr>
          <tr>
            <td>Form actions / route handlers for mutations</td>
            <td>
              <code>export async function action()</code> — typed, progressive-enhancement forms
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
            <td>Nifra's client router — `Link` + hover/focus prefetch, scroll restoration</td>
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
        in-process during SSR — no <code>fetch</code> to your own API, no untyped JSON.
      </p>
      <CodeBlock code={NEXT} lang="tsx" />

      <h2>Svelte / Solid / Vue</h2>
      <p>
        Identical shape — only the page file's extension and component syntax change. The{" "}
        <code>loader</code>/<code>action</code>/<code>meta</code> exports are the same on every
        framework (that's Nifra's render seam). SvelteKit's <code>+page.server.ts</code> load, for
        example:
      </p>
      <CodeBlock code={SVELTEKIT} lang="ts" />

      <h2>What Nifra adds</h2>
      <ul>
        <li>
          <b>One model, any UI library</b> — switch React→Solid later by changing one import, not your
          app.
        </li>
        <li>
          <b>Much faster SSR</b> — Nifra renders ~22× Next.js, ~7× Nuxt, ~3× SvelteKit/SolidStart on
          dynamic pages, with a fraction of the client JS. See <a href="/benchmarks">benchmarks</a>.
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
