import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/keep-alive",
  "Nifra - Keep-alive",
  "Pages that stay mounted after the visitor leaves them: back and forward bring back the same page, with its scroll, form input and component state, and a sign-out drops them in every tab.",
)

const ROUTE = `// doc-check: skip - a route module; the page component is the app's own.
// routes/orders/[id].tsx
export const keepAlive = true

export default function Order({ data }: { data: OrderData }) {
  // ...
}`

const OPTIONS = `import type { KeepAliveOptions } from "@nifrajs/web"

// Show the kept page as it was, without reloading its data; drop it after a minute hidden.
export const keepAlive: KeepAliveOptions = { revalidate: false, maxAge: 60_000 }`

const REACT = `// doc-check: skip - a page component; Chart is the app's own.
import { usePageVisibility } from "@nifrajs/web-react/keep-alive"

export default function Dashboard() {
  const visible = usePageVisibility()
  return <Chart animate={visible} />
}`

const SVELTE = `<script>
  import { onPageHide, onPageShow } from "@nifrajs/web-svelte/keep-alive"
  let timer
  const poll = () => (timer = setInterval(refresh, 5000))
  poll()
  onPageHide(() => clearInterval(timer))
  onPageShow(poll)
</script>`

const CSS = `/* Stops matching: the wrappers sit between main and the page's root */
main > section { padding: 2rem; }

/* Matches, kept or not */
main section { padding: 2rem; }
[data-nifra-page] > section { padding: 2rem; }`

const IDENTITY = `// doc-check: skip - adapter, manifest and clientEntry are the app's own.
const app = createWebApp({
  adapter,
  manifest,
  clientEntry,
  keepAlive: {
    identityCookies: ["sid"], // your own session cookie
    ignoreCookies: ["cart"], // HttpOnly, but says nothing about who is signed in
  },
})`

const ROTATE = `import { server } from "@nifrajs/core/server"
import { rotateIdentityEpoch } from "@nifrajs/web"

// A flow that changes who is signed in without changing a watched cookie.
export const api = server().post("/switch-account", (c) => {
  rotateIdentityEpoch(c)
  return { ok: true }
})`

const TOKEN = `import { identityChanged } from "@nifrajs/web/client"

// Identity in client storage: say so at sign-in and sign-out.
export function signOut(): void {
  localStorage.removeItem("token")
  identityChanged()
}`

export default function KeepAlive() {
  return (
    <div className="prose">
      <h1 className="page">Keep-alive</h1>
      <p className="lead">
        A route that exports <code>keepAlive</code> stays mounted after the visitor leaves it. Back
        and forward bring back the same page, not a new render of it: its scroll positions, form
        input, open <code>&lt;details&gt;</code>, focus and component state are where the visitor
        left them.
      </p>

      <h2>Keep a page</h2>
      <CodeBlock code={ROUTE} lang="tsx" />
      <p>
        Pass options instead of <code>true</code> to change how the page comes back:
      </p>
      <CodeBlock code={OPTIONS} />
      <p>
        <code>keepAlive</code> works with the React adapter (React 19.2 or later, for{" "}
        <code>&lt;Activity&gt;</code>) and the Svelte adapter. A build with another adapter fails and
        names the routes that export it.
      </p>

      <h2>When a page is kept, and when it comes back</h2>
      <ul>
        <li>
          A page is kept when the visitor leaves it by a link, a form or back and forward. A redirect
          or a <code>replace</code> navigation discards it, since its history entry is gone.
        </li>
        <li>
          Only back or forward to the page's own history entry brings it back. A link to the same
          path renders a fresh page.
        </li>
        <li>
          A new path on the same route is a new page: <code>/orders/1</code> and{" "}
          <code>/orders/2</code> are kept apart. A change of the query string alone keeps the page.
        </li>
        <li>
          A tab keeps at most three pages, dropping the one shown longest ago, and none hidden
          longer than ten minutes, or the route's <code>maxAge</code>.
        </li>
        <li>
          Going back and then following a link drops the pages ahead of it, as the browser drops
          those history entries.
        </li>
      </ul>

      <h2>Fresh data</h2>
      <p>
        A page comes back at once, as it was left, and reloads its data behind it. The reload is
        shared onto the data the page already holds: what did not change keeps its identity, so
        nothing below an unchanged value renders again, and form input in a list survives. Set{" "}
        <code>revalidate: false</code> to skip the reload; an action submitted while the page was
        hidden still reloads it.
      </p>

      <h2>While a page is hidden</h2>
      <p>
        A kept page is taken out of the document. It is absent from the accessibility tree, its
        media stops, and its ids never collide with the page on screen. It renders from its own
        route state, so it never sees another page's params.
      </p>
      <p>
        In React, <code>&lt;Activity&gt;</code> cleans up the page's effects while it is hidden and
        runs them again when it is shown. <code>usePageVisibility()</code> reads which it is:
      </p>
      <CodeBlock code={REACT} lang="tsx" />
      <p>
        A Svelte page keeps running while it is hidden. Pause timers, sockets and media with{" "}
        <code>onPageHide</code> and resume them with <code>onPageShow</code>:
      </p>
      <CodeBlock code={SVELTE} lang="svelte" />
      <p>
        Any framework's code can listen for the <code>nifra:pagehide</code> and{" "}
        <code>nifra:pageshow</code> events, which bubble from the page.
      </p>

      <h2>CSS around a kept page</h2>
      <p>
        A kept page renders inside two <code>display:contents</code> elements,{" "}
        <code>[data-nifra-entry]</code> and <code>[data-nifra-page]</code>; so does a layout below
        which the routes' layouts differ. They take no box, but a selector that reached the page's
        root as a direct child, or by its position among siblings, stops matching:
      </p>
      <CodeBlock code={CSS} lang="text" />
      <p>
        In development, the first time a kept page is shown the client reads the page's
        same-origin stylesheets and reports each such selector once, as{" "}
        <a href="/docs/errors#keepalive-direct-child-css">NIFRA_KEEPALIVE_DIRECT_CHILD_CSS</a>.
      </p>

      <h2 id="sign-in">Keep-alive and sign-in</h2>
      <p>
        A page kept for one visitor must never come back for the next. When a response signs a
        visitor in or out, the server also rotates a readable epoch cookie (
        <code>__Host-nifra-epoch</code>, or <code>nifra-epoch</code> on local <code>http:</code>)
        with the session cookie's lifetime. A tab that reads a new epoch drops every page it kept and
        tells the other tabs of the origin to do the same. A sign-out by a native form post, or a
        session that expires while the visitor is away, is covered the same way: back compares the
        epoch before it shows a kept page.
      </p>
      <p>
        The session cookies of <code>@nifrajs/auth</code>, Better Auth and Auth.js count under their
        default names. Name any other in <code>identityCookies</code>:
      </p>
      <CodeBlock code={IDENTITY} />
      <p>
        In development, an <code>HttpOnly</code> cookie that changes and is in neither list is
        reported once, as{" "}
        <a href="/docs/errors#keepalive-identity-cookie">NIFRA_KEEPALIVE_IDENTITY_COOKIE</a>. A flow
        that changes who is signed in without changing a cookie rotates the epoch itself:
      </p>
      <CodeBlock code={ROTATE} />
      <p>
        When identity lives in client storage, as a bearer token, call <code>identityChanged()</code>{" "}
        at sign-in and sign-out:
      </p>
      <CodeBlock code={TOKEN} />
      <p>
        A document the browser puts in its back/forward cache drops its kept pages first, so a
        cached document never carries them.
      </p>

      <h2>Limits</h2>
      <ul>
        <li>
          A page with an intercepted route open (a modal over it) is not kept.
        </li>
        <li>
          A route with a <code>clientLoader</code> runs it again when the page comes back, even with{" "}
          <code>revalidate: false</code>.
        </li>
        <li>A hot update of a route module drops every kept page.</li>
      </ul>
    </div>
  )
}
