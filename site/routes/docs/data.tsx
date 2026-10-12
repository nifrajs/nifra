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

// Route.Loader checks what this returns against loaderOutput at compile time.
export const loader: Route.Loader = async ({ params, api }) => {
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

export const action: Route.Action = async ({ api, request }) => {
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
        leaves the server. Declare a timestamp as <code>t.date()</code> and the page gets a{" "}
        <code>Date</code> in the server render and in the browser alike; under{" "}
        <code>t.string()</code> it travels as its ISO string. <code>t.json()</code> declares a
        field that is any JSON value, passed through whole - a tool-call payload or a settings blob
        the page does not pick apart. A loader without a schema is flagged by{" "}
        <code>nifra check</code>. See{" "}
        <a href="/docs/structure">Project structure</a> for the route pair.
      </p>
      <CodeBlock code={LOADER} lang="ts" />
      <CodeBlock code={PAGE} />
      <p>
        Annotating the loader with <code>Route.Loader</code> from the generated{" "}
        <code>./+types/&lt;name&gt;</code> checks what it returns against <code>loaderOutput</code>{" "}
        at compile time: a field of the wrong type, a <code>defer(...)</code> whose value does not
        match its <code>t.deferred(...)</code> field, or any data from a loader with no{" "}
        <code>loaderOutput</code> is a type error. A redirect, a <code>Response</code> and returning
        nothing stay allowed. <code>Route.Action</code> does the same against{" "}
        <code>actionOutput</code>, <code>revalidate(paths, data)</code> included. A field the schema
        does not declare is not a type error: the guard drops it before it ships. The annotation
        makes the loader's type the schema's, so <code>nifra schemas</code> cannot read what an
        annotated loader returns. It reports a generated schema over one as unchecked: annotate a
        loader whose schema you write, and leave a loader whose schema is generated unannotated.
      </p>
      <p>
        <code>nifra schemas</code> drafts the schemas from your code for review: it reads each
        loader's and action's TypeScript return type, and with <code>--write</code> puts a schema
        above every one that has none. It leaves out a field named like a credential and anything
        that is not JSON, says so in a comment, and marks what it wrote with a{" "}
        <code>nifra:generated</code> line. While that line stays, a later{" "}
        <code>nifra schemas --write</code> keeps the schema in step with the return type, and{" "}
        <code>nifra check</code> fails (NF-C033) when the two have drifted apart, or when the schema
        under the line was edited (reformatting it is not an edit); delete the line to own the
        schema by hand. A hand-written schema is never rewritten: the report lists the
        returned fields it drops, by path. Nothing is derived at request time - the schema in the
        file is the one the guard enforces. <code>nifra fix --code NF-C030</code> writes the same
        draft for one flagged route, and <code>nifra migrate layout</code> drafts one for each
        route it splits whose loader or action returns data without a schema.
      </p>
      <p>
        A field named like a credential (<code>password</code>, <code>token</code>,{" "}
        <code>apiKey</code>) fails the route when it loads unless its schema is wrapped in{" "}
        <code>t.declassified("why it may reach the browser", ...)</code>; a schema library that
        exposes no JSON Schema, such as valibot, gets that check only from <code>nifra check</code>,
        and only where the schema is written out in the backend half. The contract covers data,
        not responses you build: a loader or action returning a <code>2xx</code>{" "}
        <code>Response</code> is refused, but a redirect or an error-status <code>Response</code>{" "}
        is sent exactly as written, so its body must hold nothing the browser may not see.
      </p>

      <h2>Actions &amp; revalidation</h2>
      <p>
        An <code>action</code> handles the route's POST. After a client-side submit the page's
        loader <b>revalidates</b> (no full reload); with JS disabled the native form POST re-renders
        - progressive enhancement, same code. What the action returns reaches the page as{" "}
        <code>actionData</code>, bounded by <code>actionOutput</code>.
      </p>
      <CodeBlock code={ACTION} lang="ts" />
      <CodeBlock code={FORM} />
      <p>
        A form can post to another site and the browser sends that site's cookies with it, so an action
        refuses a POST whose <code>Origin</code> is another site's with 403, before middleware, gates or
        the action run. A request without an <code>Origin</code>, such as one from a server, passes, and
        so does a form on the app's own page sent under <code>Referrer-Policy: no-referrer</code>, which
        arrives as <code>Origin: null</code> with <code>Sec-Fetch-Site: same-origin</code>.
        Same-origin is judged from the request URL's host, so a proxy in front must forward the{" "}
        <code>Host</code> header. A route that takes posts from elsewhere, such as an identity
        provider's <code>form_post</code> callback, exports <code>allowedOrigins</code> from its backend
        file: an array of exact origins, or a function that receives the origin (<code>null</code> when
        absent). It checks where the browser says the request comes from, not who sent it, so keep the
        action's own authentication.
      </p>

      <h2>Layout loaders on navigation</h2>
      <p>
        A <code>_layout.backend.ts</code> can have a <code>loader</code> too; its output reaches the
        layout component as <code>data</code>. On a client navigation that keeps the layout on screen, the
        browser already holds that data, so the loader runs again only when a param the layout owns
        changes (<code>org</code> for <code>orgs/[org]/_layout.tsx</code>) or the query changes. After
        an action, every loader runs. A layout that exports <code>gate = true</code> runs on every
        request; a layout loader without it is not an authorization boundary: a client navigation can
        skip it, and an action below it runs without it. Put a check that refuses access in a gate or
        in middleware. In development, nifra warns the first time a layout loader without{" "}
        <code>gate</code> refuses a request with a redirect, a <code>Response</code>, or a 401 or 403,
        and <code>nifra check</code> reports one whose loader refuses in its own body (NF-C042). A{" "}
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
