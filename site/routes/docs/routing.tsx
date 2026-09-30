import { docsMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = docsMeta(
  "/docs/routing",
  "Nifra - Routing",
  "File-based routing in Nifra: conventions, params, nested layouts.",
)

const TREE = `routes/
  _layout.tsx        wraps every page (chain: outer → inner)
  _error.tsx         error boundary (a loader throws → renders here, 500)
  _loading.tsx       the page slot while a client navigation loads
  index.tsx          →  /
  about.tsx          →  /about
  users/
    [id].tsx         →  /users/:id          dynamic segment
  files/
    [...path].tsx    →  /files/*path         catch-all (the rest of the path)
  [[lang]]/          optional segment - matches WITH and WITHOUT it
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
  const path = params.path          // "a/b/c.txt" - the matched tail, as one string
  return { file: await read(path) }
}
// A catch-all needs ≥1 segment (/files alone won't match) and must be the last segment.`

const CLIENT_ONLY = `// routes/map.tsx - a page whose component needs a browser to render.
export const ssr = false

export async function loader({ api }) {
  return { pins: await api.pins.get() }   // still runs on the server
}

// What the server puts in the page slot, and what the browser shows until the component renders.
// Same props as the component - the loader data is already there.
export function HydrateFallback({ data }) {
  return <p>Loading {data.pins.length} pins…</p>
}

export default function MapPage({ data }) {
  const width = window.innerWidth         // fine: this never runs on the server
  return <Canvas width={width} pins={data.pins} />
}`

const SEARCH = `// routes/reports.tsx - a typed, validated ?page=&sort= query.
import { useSearch } from "@nifrajs/web-react/router"
import * as v from "valibot" // any Standard Schema works (valibot, zod, arktype)

// The route's search contract. Invalid or hostile input fails closed to these defaults - never a 500.
export const searchSchema = v.object({
  page: v.optional(v.fallback(v.number(), 1), 1),
  sort: v.optional(v.picklist(["new", "top"]), "new"),
})

// The loader receives the validated query as ctx.search, typed by the third LoaderArgs argument.
export async function loader({ search, api }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
  return { rows: await api.reports.list(search).get() } // search.page is a number
}

// The component reads the SAME value - SSR-correct, so page/sort hydrate with no mismatch and you
// never parse window.location.search by hand.
export default function Reports({ data }: { data: LoaderData<typeof loader> }) {
  const { page, sort } = useSearch<typeof searchSchema>() // { page: number; sort: "new" | "top" }
  return <Pager page={page} sort={sort} rows={data.rows} />
}`

const BLOCKER = `// routes/posts/[id]/edit.tsx - don't lose a half-finished edit to a stray click.
import { useState } from "react"
import { useBlocker } from "@nifrajs/web-react/router"

export default function EditPost() {
  const [dirty, setDirty] = useState(false)
  // A boolean, or a predicate of { currentLocation, nextLocation } for finer control
  // (e.g. allow moves within the editor, block only real exits).
  const blocker = useBlocker(dirty)

  return (
    <form onInput={() => setDirty(true)} onSubmit={() => setDirty(false)}>
      {/* ...fields... */}
      {blocker.state === "blocked" && (
        <div role="dialog" aria-modal="true">
          <p>You have unsaved changes.</p>
          <button type="button" onClick={blocker.reset}>Keep editing</button>
          <button type="button" onClick={blocker.proceed}>Discard</button>
        </div>
      )}
    </form>
  )
}`

export default function Routing() {
  return (
    <div className="prose">
      <h1 className="page">Routing</h1>
      <p className="lead">
        Routes are files under <code>routes/</code>. The file path is the URL - no route config to
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
          <code>params.lang === undefined</code>) <i>and</i> <code>/:lang/about</code> - handy for an
          optional locale prefix. It expands to one route per combination, all sharing the page + layout
          chain (so <code>n</code> optionals → <code>2ⁿ</code> patterns).
        </li>
        <li>
          <code>(group)/</code> → a <b>route group</b>: the folder organizes routes (and can hold its own{" "}
          <code>_layout.tsx</code>) without adding a URL segment - e.g.{" "}
          <code>(marketing)/pricing.tsx</code> → <code>/pricing</code>.
        </li>
        <li>
          <code>_layout.tsx</code> wraps its directory; nesting them builds a <b>layout chain</b>{" "}
          (this docs sidebar is a nested layout).
        </li>
        <li>
          <code>_404.tsx</code> renders unmatched paths, and whatever a loader answers with{" "}
          <code>notFound()</code>. At the routes root it renders on its own. In a directory below (
          <code>admin/_404.tsx</code>) it answers for that part of the app: the unmatched URLs under{" "}
          <code>/admin</code> and <code>notFound()</code> from the routes beneath it, the nearest one
          winning, rendered inside the layouts at or above it with their loader data. Those layouts run
          as they do for a page, so a <code>gate</code> decides first - its redirect is the answer, and
          its own <code>notFound()</code> shows the root page rather than the area's. A nested{" "}
          <code>_404</code> is served non-hydrated and never from a shared cache once a layout loaded
          data for it; a navigation that lands on one loads the URL as a document. Two route groups
          with a <code>_404</code> at one URL prefix are a boot error unless a directory containing
          both has one too. <code>gone()</code>, <code>statusPage()</code> and the{" "}
          <code>_410.tsx</code>-style pages stay at the root, as does the 404 of a static export.
        </li>
        <li>
          <code>_loading.tsx</code> is what the page slot shows while a client navigation loads. A
          navigation still waiting on its data after about 120 ms swaps the page for the target
          route's nearest <code>_loading</code>: the innermost one above it whose layouts are already
          on screen. Those are the layouts the two pages share, and they stay mounted with their
          data. A <code>_loading</code> never renders outside a layout above it - coming from
          outside <code>/admin</code>, <code>admin/_loading.tsx</code> waits for the admin layout and
          the root one shows instead. A navigation that settles sooner (a prefetched link, a fast
          loader) goes straight to the new page, as does one with no eligible{" "}
          <code>_loading</code>; a change of search on the same path and a form submit keep the
          page and report <code>pending</code>. The component receives <code>pending</code> and no{" "}
          <code>data</code>. It is a browser-only convention on every adapter - the first load of a
          URL is a server render, where <code>defer()</code> streams the slow part.
        </li>
        <li>
          <code>_error.tsx</code> is the segment's <b>error boundary</b>. On the server - if a route's
          loader or shell render throws - the nearest <code>_error</code> (in the route's ancestor chain)
          renders in its place, wrapped by the layouts at/above that segment, at status 500 (served
          non-hydrated). On the <b>client</b> - a render error during navigation/interaction is caught by
          the nearest boundary, which renders <code>_error</code> in place (all five adapters). It
          receives the serialized error as <code>{`{ data: { name, message } }`}</code> (never the
          stack); a thrown control-flow value (e.g. a guard <code>redirect</code>) passes through.
        </li>
      </ul>

      <CodeBlock code={TREE} />

      <h2>A route</h2>
      <p>
        Each route default-exports a component; an optional <code>meta</code> export drives{" "}
        <code>&lt;head&gt;</code> (applied on SSR and on client navigation). Add a{" "}
        <code>loader</code> for data - see <a href="/docs/data">Loaders &amp; actions</a>.
      </p>
      <CodeBlock code={ROUTE} />

      <h2>Catch-all routes</h2>
      <p>
        A <code>[...name].tsx</code> segment matches the rest of the path and hands it to your loader as
        a single string param - ideal for docs/CMS trees, file browsers, or a custom fallback. It must
        be the final segment.
      </p>
      <CodeBlock code={CATCHALL} />

      <h2>Client-only pages</h2>
      <p>
        <code>export const ssr = false</code> keeps a page's component off the server. The route is
        still matched, its layouts still render, its gates and its loader still run and the data is
        still embedded - only the component is skipped. The server puts the page's{" "}
        <code>HydrateFallback</code> in the page slot (nothing, if there is none), the browser
        hydrates that, then renders the component with the data it already has. A client navigation
        to the page renders the component directly. For a component that reads <code>window</code>,
        a canvas, or a browser-only library while it renders.
      </p>
      <CodeBlock code={CLIENT_ONLY} lang="tsx" />
      <p>
        The module is still imported on the server, for its loader and its options. An import that
        needs a browser at load time therefore belongs inside the component - a dynamic{" "}
        <code>import()</code> - not at the top of the file. <code>ssr = false</code> cannot be
        combined with <code>hydrate = false</code>: nothing would ever render the page.
      </p>

      <h2>Typed search params</h2>
      <p>
        Export a <code>searchSchema</code> - any Standard Schema (valibot, zod, arktype) - and the URL
        query becomes typed and validated on both sides: the loader receives it as{" "}
        <code>ctx.search</code> and the component reads the same value with{" "}
        <code>{`useSearch<typeof searchSchema>()`}</code>. Invalid or hostile input fails closed to the
        schema's defaults (never a 500), and the value is derived identically on the server and on each
        client navigation - so a query-reading page hydrates with no mismatch and never touches{" "}
        <code>window.location.search</code> by hand.
      </p>
      <CodeBlock code={SEARCH} lang="tsx" />
      <p>
        Without a <code>searchSchema</code>, <code>ctx.search</code> and <code>useSearch()</code> are
        the raw parsed query (<code>{`Record<string, unknown>`}</code>). <code>useSearch</code> ships on
        every adapter (React, Preact, Vue, Solid, Svelte), each in that framework's shape - a value on
        React/Preact, a <code>Ref</code> on Vue, an accessor on Solid/Svelte. For imperative reads and
        writes of the raw query, <code>useSearchParams()</code> mirrors react-router's{" "}
        <code>[params, setParams]</code> tuple.
      </p>
      <p>
        To WRITE search, <code>useNavigate</code> takes an object target:{" "}
        <code>{`navigate({ to: "/reports", search: { page: 2 } })`}</code> serializes <code>search</code>{" "}
        onto <code>to</code> (no hand-built query strings). Run <code>nifra sync-routes</code> to generate{" "}
        <code>nifra-routes.d.ts</code> (each static route mapped to its schema output) and include it in
        your tsconfig, and <code>search</code> becomes typed against the target route's schema - a wrong
        shape for a known route is a compile error, while any other path takes a loose <code>search</code>.
        Re-run it after adding a route or changing a <code>searchSchema</code>; a stale shape is a{" "}
        <code>tsc</code> error. The plain string-path and history-delta forms
        (<code>navigate("/about")</code>, <code>navigate(-1)</code>) are unchanged.
      </p>

      <h2>Guarding navigation</h2>
      <p>
        A page with unsaved work shouldn't lose it to a stray click or the back button.{" "}
        <code>useBlocker</code> (from <code>@nifrajs/web-react/router</code>) intercepts a navigation -
        a <code>&lt;Link&gt;</code>/anchor click, <code>useNavigate</code>, or a browser back/forward -
        and hands you <code>{`{ state, proceed, reset }`}</code>. Pass a boolean or a{" "}
        <code>{`({ currentLocation, nextLocation }) => boolean`}</code> predicate; when a navigation is
        held, <code>state</code> becomes <code>"blocked"</code>, so you render your OWN confirmation and
        call <code>proceed()</code> to continue or <code>reset()</code> to stay. It mirrors
        react-router's shape - a plain boolean can't express an async "are you sure?", these two
        callbacks can.
      </p>
      <CodeBlock code={BLOCKER} lang="tsx" />
      <p>
        It also arms the browser's native "Leave site?" prompt on tab close / reload (the browser shows
        its own text there - a custom message isn't possible). On the server and before hydration the
        blocker is idle (it never blocks), so navigation degrades to the native <code>&lt;a&gt;</code>{" "}
        and the page is hydration-safe.
      </p>
      <p>
        <code>useNavigate</code> and <code>useBlocker</code> ship on every adapter -{" "}
        <code>@nifrajs/web-&lt;framework&gt;/router</code> on Preact, Vue, Solid and Svelte too, each
        returning the blocker in that framework's own shape (a Vue ref, a Solid accessor, a Svelte store,
        a plain value in Preact/React). In Vue, Solid and Svelte the hook is created once, so pass a
        function - <code>useBlocker(() =&gt; dirty)</code> - to track a changing flag.
      </p>
    </div>
  )
}
