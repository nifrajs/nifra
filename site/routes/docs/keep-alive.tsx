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
import { usePageVisibility } from "@nifrajs/web-react/router"

export default function Dashboard() {
  const visible = usePageVisibility()
  return <Chart animate={visible} />
}`

const SVELTE = `<script>
  import { onMount } from "svelte"
  import { onPageHide, onPageShow } from "@nifrajs/web-svelte/router"
  let timer
  const start = () => (timer = setInterval(refresh, 5000))
  const stop = () => clearInterval(timer)
  const offHide = onPageHide(stop)
  const offShow = onPageShow(start)
  // onMount runs in the browser only, so the server starts no timer.
  onMount(() => {
    start()
    return () => {
      stop()
      offHide()
      offShow()
    }
  })
</script>`

const VUE = `<script setup lang="ts">
import { onPageHide, onPageShow } from "@nifrajs/web-vue/router"
import { onMounted, onUnmounted } from "vue"
let socket: Socket | undefined
onMounted(() => {
  socket = connect()
})
onUnmounted(() => socket?.close())
onPageHide(() => socket?.pause())
onPageShow(() => socket?.resume())
</script>`

const ISLAND = `import { defineIsland, onPageHide, onPageShow } from "@nifrajs/web/islands"

export const clock = defineIsland((el) => {
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString()
  }
  let timer = setInterval(tick, 1000)
  const hide = onPageHide(el, () => clearInterval(timer))
  const show = onPageShow(el, () => {
    timer = setInterval(tick, 1000)
  })
  return () => {
    hide()
    show()
    clearInterval(timer)
  }
})`

const CSS = `/* Stops matching: the wrappers sit between main and the page's root */
main > section { padding: 2rem; }

/* Matches, kept or not */
main section { padding: 2rem; }
[data-nifra-page] > section { padding: 2rem; }`

const IDENTITY = `// backend/framework.ts
export const keepAlive = {
  identityCookies: ["sid"], // your own session cookie
  ignoreCookies: ["cart"], // HttpOnly, but says nothing about who is signed in
}`

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
        <code>keepAlive</code> works with the React (19.2 or later, for{" "}
        <code>&lt;Activity&gt;</code>), Preact, Solid, Svelte and Vue adapters. A build with another
        adapter fails and names the routes that export it.
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
        <li>
          A page left with a <a href="/docs/routing#modal-routes">route open in a modal</a> over
          it is kept with the modal. Back to that entry shows the page and opens the modal over it
          again.
        </li>
      </ul>

      <h2 id="mounted">What changes when a page stays mounted</h2>
      <ul>
        <li>
          Code that runs when a page mounts runs once for that page, not on every visit. Back to a
          kept page does not mount it again; work that belongs to each visit goes in{" "}
          <code>onPageShow</code>. React is the exception: <code>&lt;Activity&gt;</code> runs the
          page's effects again each time it is shown.
        </li>
        <li>
          In Preact, Solid, Svelte and Vue a hidden page keeps running: its timers fire, its
          subscriptions deliver, its stores update. Pause what should not run unseen with{" "}
          <code>onPageHide</code>.
        </li>
        <li>
          State outlives the visit. Form input, a filter, an open panel are where the visitor left
          them; reset in <code>onPageShow</code> what must start fresh.
        </li>
        <li>
          Each kept page holds its DOM and its components' memory, at most three per tab. In
          development, the <a href="/docs/dev#devtools">devtools overlay</a> lists them with their
          path, how long each has been hidden and how many elements it renders.
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
      <p>
        A <a href="/docs/partial-prerendering">partially prerendered</a> page that is kept stops its
        holes while it is hidden: a hole still loading is cancelled on the server, and a reload on its
        way is dropped. When the page comes back each hole reloads in place, its old content marked{" "}
        <code>aria-busy="true"</code> until the new arrives, with <code>revalidate: false</code> too.
        An interactive hole keeps its state through it, in React as well, where{" "}
        <code>&lt;Activity&gt;</code> cleans the page's effects up while it is hidden.
      </p>
      <p>
        With <a href="/docs/live">live refresh</a>, a hidden page is not watched. When it comes back,
        what changed while it was hidden reloads, whatever <code>revalidate</code> says, and a grant
        that expired in the meantime is loaded again.
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
        A Preact, Solid, Svelte or Vue page keeps running while it is hidden. Pause timers, sockets
        and media with <code>onPageHide</code> and resume them with <code>onPageShow</code>, from
        each adapter's <code>/router</code>:
      </p>
      <CodeBlock code={SVELTE} lang="svelte" />
      <CodeBlock code={VUE} lang="vue" />
      <table>
        <thead>
          <tr>
            <th>Adapter</th>
            <th>
              <code>usePageVisibility()</code>
            </th>
            <th>
              <code>onPageHide</code> / <code>onPageShow</code>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>React</td>
            <td>a boolean</td>
            <td>effects, which hiding cleans up</td>
          </tr>
          <tr>
            <td>Preact</td>
            <td>a boolean</td>
            <td>hooks</td>
          </tr>
          <tr>
            <td>Solid</td>
            <td>an accessor</td>
            <td>run in a component, removed with it</td>
          </tr>
          <tr>
            <td>Svelte</td>
            <td>a getter</td>
            <td>run as the component initializes, return their removal</td>
          </tr>
          <tr>
            <td>Vue</td>
            <td>a ref</td>
            <td>
              run in <code>setup</code>; <code>onActivated</code> / <code>onDeactivated</code> also
              run
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        A <code>useBlocker</code> in a hidden page blocks nothing. Any code can listen for the{" "}
        <code>nifra:pagehide</code> and <code>nifra:pageshow</code> events, which bubble from the
        page. An island inside a kept page stays mounted with it; its enhancer pauses with{" "}
        <code>onPageHide</code> and <code>onPageShow</code> from <code>@nifrajs/web/islands</code>:
      </p>
      <CodeBlock code={ISLAND} />
      <p>
        The <a href="/docs/server-components">server components</a> of a kept page stay mounted too.
        With <code>bindComponentRouter</code> installed, navigation leaves them alone while the page
        is hidden, and the reload of a page that comes back updates them.
      </p>

      <h2>CSS around a kept page</h2>
      <p>
        A kept page renders inside two <code>&lt;slot&gt;</code> elements,{" "}
        <code>[data-nifra-entry]</code> and <code>[data-nifra-page]</code>; so does a layout below
        which the routes' layouts differ. Browsers lay a <code>&lt;slot&gt;</code> out as{" "}
        <code>display: contents</code>, and the wrappers carry no inline style, so a strict{" "}
        <code>style-src</code> needs nothing for them. Vue, whose <code>&lt;KeepAlive&gt;</code>{" "}
        moves the page itself, renders neither. They take no box, but a selector that reached the
        page's root as a direct child, or by its position among siblings, stops matching:
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
        epoch before it shows a kept page. The page on screen reloads in place at the next render or
        navigation that reads the new epoch, and shows as it was, pending, until the reload lands.
      </p>
      <p>
        The session cookies of <code>@nifrajs/auth</code> and Auth.js count under their default
        names, and Better Auth's under any <code>cookiePrefix</code>. Name any other, such as one
        renamed through Better Auth's <code>advanced.cookies</code>, in{" "}
        <code>identityCookies</code>. <code>nifra dev</code> and <code>nifra build</code> read it
        from <code>backend/framework.ts</code>; a server you write passes the same object to{" "}
        <code>createWebApp(&#123; keepAlive &#125;)</code>:
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
        at sign-in and sign-out. It also clears every query client, returns every fetcher to idle,
        and reloads the page on screen in place. A navigation still loading starts again, and a
        submit still posting finishes first:
      </p>
      <CodeBlock code={TOKEN} />
      <p>
        A document the browser puts in its back/forward cache drops its kept pages first, so a
        cached document never carries them.
      </p>

      <h2>Limits</h2>
      <ul>
        <li>
          A route with a <code>clientLoader</code> runs it again when the page comes back, even with{" "}
          <code>revalidate: false</code>.
        </li>
        <li>A hot update of a route module drops every kept page.</li>
      </ul>
    </div>
  )
}
