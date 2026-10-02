import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"

export const meta = docsMeta(
  "/docs/data",
  "Nifra - Loaders & actions",
  "Typed loaders and actions in Nifra: data on the server, mutations, revalidation.",
)

const LOADER = `// routes/users/[id].backend.ts - a loader runs on the server: in-process during SSR (no network
// round-trip), typed against your backend contract. This file never reaches the browser.
import { t } from "@nifrajs/schema"
import { notFound } from "@nifrajs/web"
import type { Route } from "./+types/[id]"

// The page receives exactly this shape. Anything else the loader returns stays on the server.
export const loaderOutput = t.object({ id: t.string(), name: t.string() })

export async function loader({ params, api }: Route.LoaderArgs) {
  const res = await api.users({ id: params.id }).get()
  if (!res.ok) throw notFound()
  return res.data
}`

const PAGE = `// routes/users/[id].tsx - the page. \`data\` is typed from loaderOutput.
import type { Route } from "./+types/[id]"

export default function User({ data }: Route.ComponentProps) {
  return <h1>{data.name}</h1>
}`

const ACTION = `// routes/users/new.backend.ts - an action handles the route's POST.
import { t } from "@nifrajs/schema"
import type { Route } from "./+types/new"

export const actionOutput = t.object({ ok: t.boolean() })

export async function action({ api, request }: Route.ActionArgs) {
  const form = await request.formData()
  await api.users.post({ name: String(form.get("name")) })
  return { ok: true }                  // the page's loaders revalidate automatically
}`

const FORM = `// routes/users/new.tsx - works with JS off (a native form POST) and on (a client submit, no reload).
export default function NewUser() {
  return (
    <form method="post">
      <input name="name" />
      <button type="submit">Create</button>
    </form>
  )
}`

const CONTENT = `// backend/content.ts - a typed, validated collection over a folder of Markdown.
import { defineCollection } from "@nifrajs/content/fs"
import { t } from "@nifrajs/schema"

export const blog = defineCollection({
  dir: "content/blog",
  schema: t.object({ title: t.string(), date: t.string(), draft: t.boolean() }),
})

// routes/blog/index.backend.ts - typed + validated entries, no manual fs/frontmatter parsing:
export const loaderOutput = t.object({
  posts: t.array(t.object({ slug: t.string(), title: t.string(), html: t.string() })),
})

export async function loader() {
  const posts = (await blog.all()).filter((p) => !p.frontmatter.draft)
  posts.sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date))
  return { posts: posts.map((p) => ({ slug: p.slug, title: p.frontmatter.title, html: p.html })) }
}`

const SHOULD_REVALIDATE = `// routes/orgs/[org]/_layout.backend.ts
import { t } from "@nifrajs/schema"
import type { ShouldRevalidate } from "@nifrajs/web"

export const loaderOutput = t.object({ name: t.string() })

export async function loader({ params }: { params: { org: string } }) {
  const res = await fetch("https://api.example.com/orgs/" + encodeURIComponent(params.org))
  const org = (await res.json()) as { name: string }
  return { name: org.name }
}

// The org sidebar ignores the query: filtering a list beneath it keeps the org data,
// switching orgs loads it again.
export const shouldRevalidate: ShouldRevalidate = ({ currentParams, nextParams }) =>
  currentParams.org !== nextParams.org`

export default function Data() {
  return (
    <div className="prose">
      <h1 className="page">Loaders &amp; actions</h1>
      <p className="lead">
        Loaders fetch data on the server; actions mutate it. Both live in a route's{" "}
        <code>.backend.ts</code> half, never in the page, and both are typed against your contract -
        the client never throws, it returns <code>{"{ data, error }"}</code>.
      </p>

      <h2>Loaders</h2>
      <p>
        A route's <code>loader</code> runs on the server and calls your backend in-process during
        SSR - no network hop. Its <code>loaderOutput</code> schema is the contract with the page:
        the page receives that shape as <code>data</code>, and nothing else the loader returns
        leaves the server. A loader without one is flagged by <code>nifra check</code>. See{" "}
        <a href="/docs/structure">Project structure</a> for the route pair.
      </p>
      <CodeBlock code={LOADER} lang="ts" />
      <CodeBlock code={PAGE} />

      <h2>Actions &amp; revalidation</h2>
      <p>
        An <code>action</code> handles the route's POST. After a client-side submit the page's
        loader <b>revalidates</b> (no full reload); with JS disabled the native form POST re-renders
        - progressive enhancement, same code. What the action returns reaches the page as{" "}
        <code>actionData</code>, bounded by <code>actionOutput</code>.
      </p>
      <CodeBlock code={ACTION} lang="ts" />
      <CodeBlock code={FORM} />

      <h2>Layout loaders on navigation</h2>
      <p>
        A <code>_layout.backend.ts</code> can have a <code>loader</code> too; its output reaches the
        layout component as <code>data</code>. On a client navigation that keeps the layout on screen, the
        browser already holds that data, so the loader runs again only when a param the layout owns
        changes (<code>org</code> for <code>orgs/[org]/_layout.tsx</code>) or the query changes. After
        an action, every loader runs. A layout that exports <code>gate = true</code> runs on every
        request; a layout loader without it is not an authorization boundary. A{" "}
        <code>_layout.backend.ts</code> that exports <code>middleware</code> guards a directory, with
        or without a layout component - see <a href="/docs/routing#middleware">Route middleware</a>.
      </p>
      <p>
        A layout's <code>shouldRevalidate</code> overrides that default. It runs on the server and
        receives <code>defaultShouldRevalidate</code> with the URL and params being left and the ones
        being loaded. Returning <code>false</code> keeps the browser's copy. It is not asked on a
        document request, after an action, or for a gate. A page's loader runs on every navigation:
        query keys a page never reads belong in its <code>searchClientKeys</code>, which skips the
        request.
      </p>
      <CodeBlock code={SHOULD_REVALIDATE} lang="ts" />

      <h2>Content collections</h2>
      <p>
        A <b>content collection</b> turns a folder of Markdown into a typed, schema-validated data
        source - no hand-rolled <code>readdir</code> + frontmatter parsing.{" "}
        <code>defineCollection</code> (from <code>@nifrajs/content/fs</code>) validates each file's
        frontmatter against a <code>t</code> schema (a typo'd field fails the build, not production) and
        renders the Markdown body to HTML; <code>all()</code> / <code>get(slug)</code> return
        fully-typed entries you read in a loader. The collection lives in <code>backend/</code>: it
        reads the filesystem, so a page cannot import it. Framework-agnostic - the rendered <code>html</code>{" "}
        drops into any adapter (React <code>dangerouslySetInnerHTML</code>, Vue <code>v-html</code>,
        Svelte <code>{"{@html}"}</code>).
      </p>
      <CodeBlock code={CONTENT} lang="ts" />

      <p>
        For optimistic UI, concurrent fetchers, and a keyed query cache, the same primitives compose
        on both React and Solid.
      </p>
    </div>
  )
}
