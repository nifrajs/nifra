import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/routing",
  "Nifra - Routing",
  "File-based routing in Nifra: conventions, params, nested layouts.",
)

const TREE = `routes/
  _layout.tsx        wraps every page (chain: outer → inner)
  _layout.backend.ts its loader, and middleware for every page below it
  _error.tsx         error boundary (a loader throws → renders here, 500)
  _loading.tsx       the page slot while a client navigation loads
  index.tsx          →  /
  index.backend.ts       its loader + action - never reaches the browser
  about.tsx          →  /about
  users/
    [id].tsx         →  /users/:id          dynamic segment
    [id].backend.ts
  files/
    [...path].tsx    →  /files/*path         catch-all (the rest of the path)
  [[lang]]/          optional segment - matches WITH and WITHOUT it
    docs.tsx         →  /docs  AND  /:lang/docs
  (marketing)/       route group: organizes + can hold its own _layout,
    _layout.tsx        but contributes NO URL segment
    pricing.tsx      →  /pricing`

const ROUTE = `// routes/users/[id].tsx
import type { Route } from "./+types/[id]"

export const meta = { title: "User" }   // injected into <head> (SSR + client nav)

export default function User({ data }: Route.ComponentProps) {
  return <h1>User {data.name}</h1>
}`

const ROUTE_BACKEND = `// routes/users/[id].backend.ts - its server half
import { t } from "@nifrajs/schema"
import type { Route } from "./+types/[id]"

export const loaderOutput = t.object({ name: t.string() })

export async function loader({ params }: Route.LoaderArgs) {
  return { name: \`User \${params.id}\` }
}`

const MIDDLEWARE = `// routes/account/_layout.backend.ts - runs before every page under /account
import { type RouteMiddleware, rawHref, redirect } from "@nifrajs/web"

export const middleware: RouteMiddleware = ({ request, set }) => {
  set.headers["cache-control"] = "private, no-store"
  const signedIn = request.headers.get("cookie")?.includes("session=") ?? false
  return signedIn ? undefined : redirect(rawHref("/login"))
}`

const CATCHALL = `// routes/files/[...path].backend.ts - the page is routes/files/[...path].tsx, and together they
// match /files/a, /files/a/b/c.txt, …
import { t } from "@nifrajs/schema"

declare function read(path: string): Promise<string>

export const loaderOutput = t.object({ file: t.string() })

export async function loader({ params }: { params: { path: string } }) {
  const path = params.path          // "a/b/c.txt" - the matched tail, as one string
  return { file: await read(path) }
}
// A catch-all needs ≥1 segment (/files alone won't match) and must be the last segment.`

const CLIENT_ONLY = `// routes/map.tsx - a page whose component needs a browser to render.
import type { Route } from "./+types/map"

export const ssr = false

// What the server puts in the page slot, and what the browser shows until the component renders.
// Same props as the component - the loader data is already there.
export function HydrateFallback({ data }: Route.ComponentProps) {
  return <p>Loading {data.pins.length} pins…</p>
}

export default function MapPage({ data }: Route.ComponentProps) {
  const width = window.innerWidth         // fine: this never runs on the server
  return <Canvas width={width} pins={data.pins} />
}

// routes/map.backend.ts - the loader still runs on the server, and its data is embedded.
export const loaderOutput = t.object({ pins: t.array(Pin) })
export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.pins.get()
  return { pins: res.ok ? res.data : [] }
}`

const SEARCH = `// routes/reports.tsx - a typed, validated ?page=&sort= query.
import { useSearch } from "@nifrajs/web-react/router"
import * as v from "valibot" // any Standard Schema works (valibot, zod, arktype)
import type { Route } from "./+types/reports"

// The route's search contract. Invalid or hostile input fails closed to these defaults - never a 500.
export const searchSchema = v.object({
  page: v.optional(v.fallback(v.number(), 1), 1),
  sort: v.optional(v.picklist(["new", "top"]), "new"),
})

// The component reads the SAME value - SSR-correct, so page/sort hydrate with no mismatch and you
// never parse window.location.search by hand.
export default function Reports({ data }: Route.ComponentProps) {
  const { page, sort } = useSearch<typeof searchSchema>() // { page: number; sort: "new" | "top" }
  return <Pager page={page} sort={sort} rows={data.rows} />
}

// routes/reports.backend.ts - the loader receives the validated query as \`search\`, typed from
// the page's searchSchema by the generated Route.LoaderArgs.
export const loaderOutput = t.object({ rows: t.array(Report) })
export async function loader({ search, api }: Route.LoaderArgs) {
  const res = await api.reports.list(search).get() // search.page is a number
  return { rows: res.ok ? res.data : [] }
}`

const LINKS = `// doc-check: skip - routes of your own app; one line per call, before and after.
import { href, rawHref } from "@nifrajs/web-react/router"

navigate(\`/users/\${id}?tab=posts\`)
navigate(href({ to: "/users/:id", params: { id }, search: { tab: "posts" } }))

<a href="/pricing">Pricing</a>
<a href={href({ to: "/pricing" })}>Pricing</a>

<Link to="/docs#install">Install</Link>
<Link to={href({ to: "/docs", hash: "install" })}>Install</Link>

throw redirect("/login")
throw redirect(href({ to: "/login" }))

navigate(cmsLink) // a same-origin path built elsewhere
navigate(rawHref(cmsLink))`

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

const PREFETCH = `// A docs sidebar: each link loads as it scrolls into view.
<nav data-nifra-prefetch="viewport">
  <a href="/docs/routing">Routing</a>
  <a href="/docs/data">Data</a>
  {/* The nearest attribute wins: this one waits for the click. */}
  <a href="/reports/annual" data-nifra-prefetch="none">Annual report</a>
</nav>

// React's <Link> takes it as a prop.
<Link to={href({ to: "/pricing" })} prefetch="render">Pricing</Link>`

const BREADCRUMBS = `// routes/orgs/[org]/_layout.tsx
import type { ReactNode } from "react"
import { useMatches } from "@nifrajs/web-react/router"

export const handle = { crumb: "Organization" }

export default function OrgLayout({ children }: { children: ReactNode }) {
  // Outermost layout first, then the page: { id, pathname, params, data, handle }.
  const crumbs = useMatches().flatMap((m) => {
    const crumb = (m.handle as { crumb?: string } | undefined)?.crumb
    return crumb === undefined ? [] : [{ href: m.pathname, crumb }]
  })
  return (
    <>
      <nav aria-label="Breadcrumb">
        {crumbs.map((c) => <a key={c.href} href={c.href}>{c.crumb}</a>)}
      </nav>
      {children}
    </>
  )
}`

const MODAL_ROUTE = `// routes/_layout.tsx - a link to /photos/:id from any page opens the photo over that page
import type { Boundary, BoundaryStates } from "@nifrajs/web"
// /client, not the root: the root carries the server, which a browser bundle must not load.
import { closeBoundary } from "@nifrajs/web/client"
import type { ReactNode } from "react"
import type { Route as Photo } from "./photos/+types/[id]"

// No load of its own: the modal shows the target page's loader data.
const photo: Boundary<Photo.LoaderData, ReactNode> = {
  name: "photo",
  mode: { intercept: "/photos/:id" },
  render: (data) => <h2>{data.title}</h2>,
}

export const boundaries = [photo]

export default function Layout(props: { children?: ReactNode; boundaries?: BoundaryStates }) {
  const open = props.boundaries?.photo
  return (
    <>
      {props.children}
      {open?.status === "ready" || open?.status === "error" ? (
        // A form in here with no action posts to the photo's route, not the page's.
        <dialog open data-nifra-boundary="photo">
          {open.status === "ready" ? photo.render(open.data as Photo.LoaderData) : <p>Could not load.</p>}
          <button type="button" onClick={() => closeBoundary("photo")}>
            Close
          </button>
        </dialog>
      ) : null}
    </>
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
          <code>x.backend.ts</code> beside a page or layout is its server half: <code>loader</code>,{" "}
          <code>action</code>, their output schemas, and the other server-only exports. It never
          reaches the browser - see <a href={href({ to: "/docs/structure" })}>Project structure</a>.
        </li>
        <li>
          <code>_404.tsx</code> renders unmatched paths, and whatever a loader answers with{" "}
          <code>notFound()</code>. At the routes root it renders inside the root layout, as below. In
          a directory below (
          <code>admin/_404.tsx</code>) it answers for that part of the app: the unmatched URLs under{" "}
          <code>/admin</code> and <code>notFound()</code> from the routes beneath it, the nearest one
          winning, rendered inside the layouts at or above it with their loader data. Those layouts run
          as they do for a page, so a <code>gate</code> decides first - its redirect is the answer, and
          its own <code>notFound()</code> shows the root page rather than the area's. A nested{" "}
          <code>_404</code> is served non-hydrated and never from a shared cache once a layout loaded
          data for it; a navigation that lands on one loads the URL as a document. Two route groups
          with a <code>_404</code> at one URL prefix are a boot error unless a directory containing
          both has one too. <code>gone()</code>, <code>statusPage()</code> and the{" "}
          <code>_410.tsx</code>-style pages stay at the root, as does the 404 of a static export. A
          helper the browser also loads imports these three from <code>@nifrajs/web/client</code>{" "}
          rather than the root, whose server half Vite's dev server would otherwise send it.
        </li>
        <li>
          A root status page (<code>_404.tsx</code>, <code>_503.tsx</code>, ...) or an{" "}
          <code>_error.tsx</code> renders inside the layouts above it with their loader data, and the
          server puts its <code>meta</code> in the head. For a request no route ran (an unmatched
          URL) the root middleware and layout loaders run first; otherwise the page reuses the data
          the request already loaded. When those layouts cannot render it - a loader throws, a{" "}
          <code>gate</code> or the middleware refuses - a root status page renders alone and an{" "}
          <code>_error</code> inside its layouts without their data, with the same status, so a
          status page never fails into a second error. The response is{" "}
          <code>private, no-store</code> once a layout loaded data, and a navigation that lands on
          one loads the URL as a document. <code>export const inLayouts = false</code> always renders
          the page that way and runs no layout loader for it. A root status page that wraps the root
          layout itself would render it twice; <code>nifra check</code> reports one as{" "}
          <code>NF-C034</code>.
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
          stack; on the server, a generic <code>Internal Server Error</code> rather than the error's
          own text unless <code>NODE_ENV</code> is <code>development</code> or <code>test</code>); a
          thrown control-flow value (e.g. a guard{" "}
          <code>redirect</code>) passes through.
        </li>
        <li>
          A <code>_layout.backend.ts</code> that exports <code>middleware</code> runs it on the
          server before the layouts, loaders and actions of every route in its directory and below,
          with or without a <code>_layout.tsx</code> beside it - see{" "}
          <a href="#middleware">Route middleware</a>.
        </li>
      </ul>

      <CodeBlock code={TREE} />

      <h2>A route</h2>
      <p>
        Each page default-exports a component; an optional <code>meta</code> export drives{" "}
        <code>&lt;head&gt;</code> (applied on SSR and on client navigation). Its data comes from a{" "}
        <code>loader</code> in its <code>.backend.ts</code> half - see{" "}
        <a href={href({ to: "/docs/data" })}>Loaders &amp; actions</a>.
      </p>
      <p>
        A layout's <code>meta</code> receives its own loader's data as <code>data</code>, the value its
        component renders, or <code>null</code> when the layout has no loader. The page's data is{" "}
        <code>pageData</code>, for a layout title template. A layout that loads the locale can set{" "}
        <code>lang</code> from its data, and a client navigation keeps it. <code>nifra check</code>{" "}
        reports a layout with no loader whose <code>meta</code> reads <code>data</code> as{" "}
        <code>NF-C040</code>.
      </p>
      <CodeBlock code={ROUTE} />
      <CodeBlock code={ROUTE_BACKEND} lang="ts" />

      <h2 id="middleware">Route middleware</h2>
      <p>
        A directory's <code>_layout.backend.ts</code> exports <code>middleware</code>, a function
        that runs on the server before everything under its directory: the layouts' loaders, gates included, then the page's loader
        or action. It runs for a document request, a client navigation and a form post alike, and
        before a nested <code>_404</code> there. Middleware higher in the tree runs first.
      </p>
      <CodeBlock code={MIDDLEWARE} />
      <ul>
        <li>
          Return nothing to let the request through. Return or throw a <code>redirect()</code>, a
          status such as <code>notFound()</code>, or a <code>Response</code> to answer with it, and
          nothing below it runs. During a client navigation, the router follows a redirect to another
          page of the app without reloading, and the address bar shows the target.
        </li>
        <li>
          <code>set</code> adds headers and cookies like a loader's; a layout's or the page's header of
          the same name wins. <code>params</code> holds the params of the directory's URL prefix.
        </li>
        <li>
          It covers pages only: a prerendered page, an ISR cache hit, a mounted API and a static file
          are served without it. For middleware on every request, export <code>use</code> from{" "}
          <code>backend/framework.ts</code>: <code>{"export const use = (app) => app.use(securityHeaders())"}</code>.
        </li>
      </ul>

      <h2>Catch-all routes</h2>
      <p>
        A <code>[...name].tsx</code> segment matches the rest of the path and hands it to the loader in{" "}
        <code>[...name].backend.ts</code> as a single string param - ideal for docs/CMS trees, file browsers, or a custom fallback. It must
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
        The page module is still imported on the server, for its options (its loader lives in the{" "}
        <code>.backend.ts</code> half). An import that needs a browser at load time therefore belongs
        inside the component - a dynamic{" "}
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
        To WRITE search, build the link with <code>href</code> and hand it to <code>useNavigate</code>:{" "}
        <code>{`navigate(href({ to: "/reports", search: { page: 2 } }))`}</code>. <code>href</code> and{" "}
        <code>rawHref</code> are exported by every adapter's router entry (
        <code>@nifrajs/web-&lt;framework&gt;/router</code>). <code>nifra dev</code>,{" "}
        <code>nifra build</code>, <code>nifra check</code> and <code>nifra types</code> write{" "}
        <code>.nifra/types/routes.d.ts</code>, which maps every route pattern to its params and its
        schema output, and each route's generated <code>./+types</code> module loads it. So{" "}
        <code>to</code> is one of those patterns, <code>params</code> holds that route's params, and{" "}
        <code>search</code> is typed against its schema: a misspelt route, a missing param and a wrong
        search shape are compile errors, and a changed <code>searchSchema</code> shows up as a{" "}
        <code>tsc</code> error at the stale call. A route without a <code>searchSchema</code> takes any{" "}
        <code>search</code>.
      </p>
      <p>
        Each param is encoded as one path segment, so a value such as <code>a/b</code> or{" "}
        <code>//evil.com</code> stays inside the segment and never changes where the link goes. A
        param that is missing, empty, <code>.</code>, <code>..</code> or an unpaired surrogate throws a{" "}
        <code>TypeError</code> naming it. <code>navigate</code> takes only an <code>href</code> result,
        or a history delta such as <code>navigate(-1)</code>; a string or a template literal is a
        compile error. So do React's <code>Link</code>, <code>NavLink</code> and <code>Navigate</code>{" "}
        (<code>{`<Link to={href({ to: "/pricing" })}>`}</code>) and the server's{" "}
        <code>redirect()</code>; <code>Link</code> and <code>NavLink</code> also throw at render when{" "}
        <code>to</code> is not a same-origin path, and <code>redirect</code> takes any string with{" "}
        <code>{`{ external: true }`}</code>. For a same-origin path built elsewhere - a CMS link,{" "}
        <code>/llms.txt</code> - <code>{`rawHref("/llms.txt")`}</code> checks it (one leading{" "}
        <code>/</code>, no backslash or control character) and returns the same type. A link to
        another site is a plain <code>&lt;a href&gt;</code>.
      </p>

      <h2 id="typed-links">Moving existing links to href()</h2>
      <p>
        A link written as a string is not checked: <code>{`navigate("/pricng")`}</code> and{" "}
        <code>{`<a href="/pricng">`}</code> compile and then 404. Moving one is mechanical.
      </p>
      <CodeBlock code={LINKS} lang="tsx" />
      <p>
        A leftover <code>navigate("/x")</code>, <code>{`<Link to="/x">`}</code> or{" "}
        <code>redirect("/x")</code> is a compile error at the call, so <code>tsc</code> lists what is
        left. A plain <code>{`<a href="/x">`}</code> is not an error, so search for{" "}
        <code>{`href="/`}</code> and <code>{"href={`/"}</code> too; a link that opens another site stays
        an <code>&lt;a href&gt;</code>. This site, the examples and the starters are held to it by a
        test that fails on a literal internal anchor.
      </p>
      <p>
        The table is a generated file, <code>.nifra/types/routes.d.ts</code>. A program in which no route
        imports a <code>./+types/...</code> module does not load it, and <code>to</code> then accepts no
        route at all, and <code>nifra check</code> warns. List <code>.nifra/types/routes.d.ts</code> under
        the tsconfig <code>files</code>: the <code>**</code> globs skip a dot directory, and a{" "}
        <code>files</code> entry is not filtered by <code>exclude</code>.
      </p>

      <h2>Prefetching</h2>
      <p>
        A link warms its route - the route's code and its loader data - before it is followed, so
        the click renders at once. <code>data-nifra-prefetch</code>, on the link or on any element
        around it (the nearest one wins), says when:
      </p>
      <ul>
        <li>
          <code>intent</code> (the default): on hover or keyboard focus.
        </li>
        <li>
          <code>viewport</code>: once the link scrolls into view.
        </li>
        <li>
          <code>render</code>: as soon as a page shows the link.
        </li>
        <li>
          <code>none</code>: never; the route loads when the link is followed.
        </li>
      </ul>
      <CodeBlock code={PREFETCH} lang="tsx" />
      <p>
        Warmed data is used by a click within 30 seconds; after that the click loads the route
        again, so a link that scrolled into view long ago never shows old data. The page already on
        screen is never prefetched. <code>viewport</code> and <code>render</code> links are found
        when the page loads and whenever the router settles (a navigation, a submit); a link the
        page adds in between warms on intent until then. Both run the target's loaders before
        anyone clicks, so keep them to links people are likely to follow. The attribute works the
        same under every adapter; React's <code>&lt;Link&gt;</code> and <code>&lt;NavLink&gt;</code>{" "}
        also take it as a <code>prefetch</code> prop.
      </p>

      <h2>Breadcrumbs and the rendered chain</h2>
      <p>
        A page or a layout can export a <code>handle</code> - any value; nifra only passes it along.{" "}
        <code>useMatches()</code> returns the chain being rendered, outermost layout first and the
        page last, each entry as <code>{`{ id, pathname, params, data, handle }`}</code>:{" "}
        <code>id</code> is the route file without its extension, <code>pathname</code> the part of
        the URL it covers (a layout its directory's prefix, the page the whole path, never the
        query), <code>params</code> the ones it declares, and <code>data</code> its loader data (<code>null</code> without a loader). A layout
        can therefore build breadcrumbs, a title, or a section nav from what the routes below it
        export.
      </p>
      <CodeBlock code={BREADCRUMBS} lang="tsx" />
      <p>
        The server render and the browser report the same list, so a breadcrumb trail hydrates with
        no mismatch. <code>handle</code> is read from the module on each side, never serialized, so
        it can hold a function or a component. While a <code>_loading</code> page is up it takes the
        page's place in the list; a nested <code>_404</code> reports the layouts it renders inside;
        an <code>_error</code> page the server renders reports an empty list.{" "}
        <code>useMatches</code> ships on every adapter from{" "}
        <code>@nifrajs/web-&lt;framework&gt;/router</code>, as an array on React/Preact, a{" "}
        <code>Ref</code> on Vue, and an accessor on Solid/Svelte.
      </p>

      <h2 id="modal-routes">Opening a route in a modal</h2>
      <p>
        A photo grid can open <code>/photos/7</code> over the grid, while a shared link or a reload of
        that URL shows the photo as its own page. A layout or page declares this with a boundary whose
        mode is <code>{`{ intercept: "/photos/:id" }`}</code>, in its <code>boundaries</code> export.
        On a client navigation from a page under that layout (or from that page) to a matching URL,
        nifra fetches the target route&apos;s data with the usual request, so its middleware, gates
        and loader all run. The current page stays mounted, the address bar shows the new URL, and the
        target&apos;s loader data arrives as <code>boundaries.photo</code> with{" "}
        <code>status: &quot;ready&quot;</code>. Until then the boundary&apos;s status is{" "}
        <code>&quot;unresolved&quot;</code>.
      </p>
      <CodeBlock code={MODAL_ROUTE} lang="tsx" />
      <ul>
        <li>
          The boundary has no <code>load</code>: its data is the target page&apos;s loader data, so
          type it with that route&apos;s <code>LoaderData</code>. <code>routes/photos/[id].tsx</code>{" "}
          stays an ordinary page.
        </li>
        <li>
          Back closes the modal and forward reopens it. Closing shows the page underneath as it was,
          with its loader data and boundaries, without fetching it again; a page loaded for a
          previous visitor loads again. A link inside the modal to another matching URL replaces its
          content, and back steps through each one. Navigating anywhere else closes it.
        </li>
        <li>
          A reload, a shared link, or a navigation from a page outside the declaring layout or page
          renders the target as a full page. That includes coming back to the modal&apos;s URL from a
          page that does not intercept it.
        </li>
        <li>
          A target that answers with its own status, such as a <code>404</code> or{" "}
          <code>401</code>, or that throws, never opens in the modal: the browser loads that URL as a
          full page and gets that answer. A redirect is followed first, and opens in the modal only
          when it lands on another matching URL.
        </li>
        <li>
          <code>closeBoundary(&quot;photo&quot;)</code> from <code>@nifrajs/web/client</code> closes it: it
          goes back through the entries the modal added, or replaces the modal&apos;s URL with the
          page&apos;s when those entries are not in this tab&apos;s history (the modal was opened with
          a replace navigation). It does nothing when that boundary holds no target.
        </li>
        <li>
          While the modal is open, the route props and hooks describe the page underneath:{" "}
          <code>useLocation</code>, <code>useSearch</code>, <code>useParams</code> and{" "}
          <code>useMatches</code> report the page&apos;s path, query and params, while the address bar
          shows the modal&apos;s URL.
        </li>
        <li>
          Opening the modal keeps the page&apos;s scroll position and its{" "}
          <code>actionData</code>, and closing it restores the
          page&apos;s entry with its scroll. A link to the page&apos;s own URL is a normal navigation,
          never an interception, and only one intercept boundary is open at a time: opening another
          closes the first.
        </li>
        <li>
          An action submitted while the modal is open revalidates both routes: the page reloads
          under its own URL and the target under the modal&apos;s, each with its own cache entry.
          With <code>revalidate: false</code>, only the paths the server names as changed reload.{" "}
          <code>invalidate()</code> reloads both, and <code>invalidate(paths)</code> reloads the ones
          listed. If the target answers a reload with a status or throws, the modal stays open and
          the boundary&apos;s status becomes <code>&quot;error&quot;</code> with a generic error, so
          none of that answer reaches the page.
        </li>
        <li>
          A form with no <code>action</code> (or a submitter with no <code>formaction</code>), POST
          or GET, submits to the route that owns it: the target&apos;s URL when the form sits inside an element with{" "}
          <code>data-nifra-boundary=&quot;photo&quot;</code>, otherwise the page&apos;s URL. A form
          with an explicit action posts where it says. The result of an action posted to the
          target arrives as <code>boundaries.photo.actionData</code>, and the page&apos;s own{" "}
          <code>actionData</code> stays the page&apos;s. An action that redirects renders the
          redirect&apos;s target as a full page, never in the modal.
        </li>
        <li>
          The component renders the boundary itself: it reads <code>boundaries.&lt;name&gt;</code>{" "}
          from its props and calls the boundary&apos;s <code>render</code> with the data. Every
          adapter passes <code>boundaries</code> to the layouts and the page.
        </li>
      </ul>

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
