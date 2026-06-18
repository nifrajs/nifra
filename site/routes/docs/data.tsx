import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Loaders & actions",
  "Typed loaders and actions in Nifra: data on the server, mutations, revalidation.",
)

const LOADER = `// A loader runs on the server — in-process during SSR (no network round-trip),
// fully typed against your backend contract.
export async function loader({ api }: LoaderArgs<typeof app>) {
  const res = await api.users({ id: "7" }).get()
  return { user: res.data }            // serialized to the client for hydration
}`

const ACTION = `// An action handles a mutation (a POST). Progressive-enhancement: works with JS
// off (native form POST) and as a client submit (no full reload) with JS on.
export async function action({ api, request }: ActionArgs<typeof app>) {
  const form = await request.formData()
  await api.users.post({ name: String(form.get("name")) })
  return { ok: true }                  // the loader revalidates automatically
}

export default function Page(props: { data: LoaderData<typeof loader> }) {
  return (
    <form method="post">
      <input name="name" />
      <button type="submit">Create</button>
    </form>
  )
}`

const CONTENT = `// content.config.ts — a typed, validated collection over a folder of Markdown.
import { defineCollection } from "@nifrajs/content/fs"
import { t } from "@nifrajs/schema"

export const blog = defineCollection({
  dir: "content/blog",
  schema: t.object({ title: t.string(), date: t.string(), draft: t.boolean() }),
})

// a loader — typed + validated entries, no manual fs/frontmatter parsing:
export async function loader() {
  const posts = (await blog.all()).filter((p) => !p.frontmatter.draft)
  return { posts: posts.sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date)) }
}
// posts[0].frontmatter is { title; date; draft } (typed); posts[0].html is the rendered Markdown`

export default function Data() {
  return (
    <div className="prose">
      <h1 className="page">Loaders &amp; actions</h1>
      <p className="lead">
        Loaders fetch data on the server; actions mutate it. Both are typed against your contract,
        and the client never throws — it returns <code>{"{ data, error }"}</code>.
      </p>

      <h2>Loaders</h2>
      <p>
        A route's <code>loader</code> runs on the server and calls your backend in-process during
        SSR — no network hop. Its return type flows to the component as <code>LoaderData</code>.
      </p>
      <CodeBlock code={LOADER} />

      <h2>Actions &amp; revalidation</h2>
      <p>
        An <code>action</code> handles the route's POST. After a client-side submit the page's
        loader <b>revalidates</b> (no full reload); with JS disabled the native form POST re-renders
        — progressive enhancement, same code.
      </p>
      <CodeBlock code={ACTION} />

      <h2>Content collections</h2>
      <p>
        A <b>content collection</b> turns a folder of Markdown into a typed, schema-validated data
        source — no hand-rolled <code>readdir</code> + frontmatter parsing.{" "}
        <code>defineCollection</code> (from <code>@nifrajs/content/fs</code>) validates each file's
        frontmatter against a <code>t</code> schema (a typo'd field fails the build, not production) and
        renders the Markdown body to HTML; <code>all()</code> / <code>get(slug)</code> return
        fully-typed entries you read in a loader. Framework-agnostic — the rendered <code>html</code>{" "}
        drops into any adapter (React <code>dangerouslySetInnerHTML</code>, Vue <code>v-html</code>,
        Svelte <code>{"{@html}"}</code>).
      </p>
      <CodeBlock code={CONTENT} />

      <p>
        For optimistic UI, concurrent fetchers, and a keyed query cache, the same primitives compose
        on both React and Solid.
      </p>
    </div>
  )
}
