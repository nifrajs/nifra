import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Routing",
  "File-based routing in Nifra: conventions, params, nested layouts.",
)

const TREE = `routes/
  _layout.tsx        wraps every page (chain: outer → inner)
  _error.tsx         error boundary (a loader throws → renders here, 500)
  index.tsx          →  /
  about.tsx          →  /about
  users/
    [id].tsx         →  /users/:id          dynamic segment
  files/
    [...path].tsx    →  /files/*path         catch-all (the rest of the path)
  [[lang]]/          optional segment — matches WITH and WITHOUT it
    docs.tsx         →  /docs  AND  /:lang/docs
  (marketing)/       route group: organizes + can hold its own _layout,
    _layout.tsx        but contributes NO URL segment
    pricing.tsx      →  /pricing`

const ROUTE = `// routes/users/[id].tsx
export const meta = { title: "User" }   // injected into <head> (SSR + client nav)

export default function User(props: { data: LoaderData<typeof loader> }) {
  return <h1>User {props.data.id}</h1>
}`

const CATCHALL = `// routes/files/[...path].tsx  →  matches /files/a, /files/a/b/c.txt, …
export async function loader({ params }) {
  const path = params.path          // "a/b/c.txt" — the matched tail, as one string
  return { file: await read(path) }
}
// A catch-all needs ≥1 segment (/files alone won't match) and must be the last segment.`

export default function Routing() {
  return (
    <div className="prose">
      <h1 className="page">Routing</h1>
      <p className="lead">
        Routes are files under <code>routes/</code>. The file path is the URL — no route config to
        maintain.
      </p>

      <h2>Conventions</h2>
      <ul>
        <li>
          <code>index.tsx</code> → the parent path; <code>about.tsx</code> → <code>/about</code>.
        </li>
        <li>
          <code>[id].tsx</code> → a dynamic segment <code>:id</code> (read via <code>c.params.id</code>{" "}
          / the loader).
        </li>
        <li>
          <code>[...path].tsx</code> → a <b>catch-all</b> capturing the rest of the URL into one param (
          <code>params.path</code> = <code>"a/b/c"</code>). Must be the last segment; matches one or more
          segments (so <code>/files</code> won't match <code>/files/[...path]</code>).
        </li>
        <li>
          <code>[[lang]].tsx</code> → an <b>optional segment</b>: it matches both with and without the
          segment. <code>[[lang]]/about.tsx</code> serves <code>/about</code> (
          <code>params.lang === undefined</code>) <i>and</i> <code>/:lang/about</code> — handy for an
          optional locale prefix. It expands to one route per combination, all sharing the page + layout
          chain (so <code>n</code> optionals → <code>2ⁿ</code> patterns).
        </li>
        <li>
          <code>(group)/</code> → a <b>route group</b>: the folder organizes routes (and can hold its own{" "}
          <code>_layout.tsx</code>) without adding a URL segment — e.g.{" "}
          <code>(marketing)/pricing.tsx</code> → <code>/pricing</code>.
        </li>
        <li>
          <code>_layout.tsx</code> wraps its directory; nesting them builds a <b>layout chain</b>{" "}
          (this docs sidebar is a nested layout).
        </li>
        <li>
          <code>_404.tsx</code> renders unmatched paths.
        </li>
        <li>
          <code>_error.tsx</code> is the segment's <b>error boundary</b>. On the server — if a route's
          loader or shell render throws — the nearest <code>_error</code> (in the route's ancestor chain)
          renders in its place, wrapped by the layouts at/above that segment, at status 500 (served
          non-hydrated). On the <b>client</b> — a render error during navigation/interaction is caught by
          the nearest boundary, which renders <code>_error</code> in place (all five adapters). It
          receives the serialized error as <code>{`{ data: { name, message } }`}</code> (never the
          stack); a thrown <code>Response</code> (e.g. a guard <code>redirect</code>) passes through.
        </li>
      </ul>

      <CodeBlock code={TREE} />

      <h2>A route</h2>
      <p>
        Each route default-exports a component; an optional <code>meta</code> export drives{" "}
        <code>&lt;head&gt;</code> (applied on SSR and on client navigation). Add a{" "}
        <code>loader</code> for data — see <a href="/docs/data">Loaders &amp; actions</a>.
      </p>
      <CodeBlock code={ROUTE} />

      <h2>Catch-all routes</h2>
      <p>
        A <code>[...name].tsx</code> segment matches the rest of the path and hands it to your loader as
        a single string param — ideal for docs/CMS trees, file browsers, or a custom fallback. It must
        be the final segment.
      </p>
      <CodeBlock code={CATCHALL} />
    </div>
  )
}
