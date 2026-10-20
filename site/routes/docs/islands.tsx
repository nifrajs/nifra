import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/islands",
  "Nifra - Islands: interactivity without hydration",
  "Add interactivity to a zero-runtime vanilla page with islands: an imperative DOM enhancer, or signals bound to server-rendered markup by name. No framework runtime, no hydration, and nifra check matches the markup against the code that mounts it.",
)

// DOM-free, so it is a checked example (nifra_example islands): the coordination primitive by itself.
const BUS_PATTERN = `import { createIslandBus } from "@nifrajs/web/islands"

// One typed channel, created once and closed over by every enhancer that needs it.
type CartEvents = { "cart:add": { sku: string }; "cart:count": number }
const bus = createIslandBus<CartEvents>()

const off = bus.on("cart:count", (n) => console.log("cart now has", n, "items"))
bus.emit("cart:add", { sku: "ABC-1" })
off() // unsubscribe - also usable directly as an island's cleanup`

// Enhancers touch the DOM, which the DOM-free doc-check program can't type. They are typechecked in
// @nifrajs/web under its own DOM lib and exercised at runtime; here they are illustrative.
const MARKER = `// doc-check: skip - server-rendered island host (HTML, not a checkable module).
// In your @nifrajs/web-vanilla page, mark any element as a host and give it inline JSON props:
html\`<div data-island="counter" data-island-props="\${JSON.stringify({ start: 0 })}">
  <output>0</output>
  <button type="button">+1</button>
</div>\``

// DOM-free, so it is a checked example (nifra_example islands): the reactive core by itself.
const SIGNALS = `import { batch, computed, effect, signal, untrack } from "@nifrajs/web/islands"

// A signal is read by calling it and written with .set. Reads inside an effect or computed subscribe.
const price = signal(20)
const quantity = signal(1)
const total = computed(() => price() * quantity())

const stop = effect(() => console.log("total", total(), "at", untrack(price)))
batch(() => {
  price.set(25)
  quantity.set((n) => n + 1)
}) // the effect runs once, after both writes: logs "total 50 at 25"
stop()`

const REACTIVE_MARKUP = `// doc-check: skip - server-rendered island host (HTML, not a checkable module).
html\`<form data-island="search" data-island-props="\${JSON.stringify({ query: "" })}"
    data-bind-on="submit:go">
  <input name="q" data-bind-value="query" />
  <button data-bind-attr="disabled:busy">Search</button>
  <p data-bind-show="busy">Searching...</p>
  <p><span data-bind-text="count">0</span> results</p>
</form>\``

const REACTIVE = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { bindIsland, mountIslands } from "@nifrajs/web/islands"

const search = bindIsland(({ state, onDispose }) => {
  // Every data-bind-* name in the markup is a state key here, seeded from data-island-props.
  const query = state("query", "")
  const busy = state("busy", false)
  const count = state("count", 0)
  const timer = setInterval(() => console.log("still searching for", query()), 5000)
  onDispose(() => clearInterval(timer))

  // The returned handlers are what data-bind-on names.
  return {
    go: async (event) => {
      event.preventDefault()
      busy.set(true)
      try {
        const hits: unknown[] = await fetch("/api/search?q=" + encodeURIComponent(query())).then((r) => r.json())
        count.set(hits.length)
      } finally {
        busy.set(false)
      }
    },
  }
})

mountIslands({ search })`

const LIST = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { bindIsland, bindList, mountIslands, resource } from "@nifrajs/web/islands"

type Hotel = { id: string; name: string }

const hotels = bindIsland(({ root, state }) => {
  const city = state("city", "paris")
  // A newer city aborts the older request; only the newest result lands.
  const found = resource(city, (c, abort) =>
    fetch("/api/hotels?city=" + encodeURIComponent(c), { signal: abort }).then((r): Promise<Hotel[]> => r.json()),
  )
  const list = root.querySelector("ul")
  if (list)
    bindList(() => found().value ?? [], list, {
      key: (h) => h.id, // a stable id, never a position (NF-C022)
      create: () => document.createElement("li"),
      update: (li, h) => {
        li.textContent = h.name
      },
    })
  // A <select data-bind-value="city"> in the markup writes city; nothing else to return.
})

mountIslands({ hotels })`

const COUNTER = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { defineIsland, mountIslands } from "@nifrajs/web/islands"

// defineIsland pins the data-island-props type; the body is plain imperative DOM. ALWAYS return the
// teardown for anything you wire - mountIslands calls it on soft-nav (NF-C020 warns if you forget).
const counter = defineIsland<{ start: number }>((el, props) => {
  let n = props.start
  const out = el.querySelector("output")!
  const onClick = () => { out.textContent = String(++n) }
  el.querySelector("button")?.addEventListener("click", onClick)
  return () => el.querySelector("button")?.removeEventListener("click", onClick)
})

// One bundle entry, loaded via the route's \`islandScripts\`.
mountIslands({ counter })`

const CART = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { createIslandBus, defineIsland, mountIslands } from "@nifrajs/web/islands"

type CartEvents = { "cart:add": { sku: string }; "cart:count": number }
const bus = createIslandBus<CartEvents>()

// Two islands that never import each other - they meet only on the bus.
const addButton = defineIsland<{ sku: string }>((el, props) => {
  const onClick = () => bus.emit("cart:add", { sku: props.sku })
  el.addEventListener("click", onClick)
  return () => el.removeEventListener("click", onClick)
})

let count = 0
const badge = defineIsland((el) => {
  const unsubscribe = bus.on("cart:add", () => {
    count += 1
    el.textContent = String(count)
    bus.emit("cart:count", count)
  })
  return unsubscribe // the on() unsubscribe IS the cleanup
})

mountIslands({ addButton, badge })`

const FILTER = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { createIslandBus, defineIsland, mountIslands } from "@nifrajs/web/islands"

// filter -> results, one directional channel. The results island owns its own DOM; the filter
// island owns none of it. No shared store, no reactive tree - a message and two enhancers.
const bus = createIslandBus<{ "filter:set": string }>()

const filter = defineIsland((el) => {
  const input = el.querySelector("input")!
  const onInput = () => bus.emit("filter:set", input.value.toLowerCase())
  input.addEventListener("input", onInput)
  return () => input.removeEventListener("input", onInput)
})

const results = defineIsland((el) =>
  bus.on("filter:set", (q) => {
    for (const row of el.querySelectorAll<HTMLElement>("[data-name]")) {
      const name = row.dataset.name ?? ""
      row.hidden = q !== "" && !name.toLowerCase().includes(q)
    }
  }),
)

mountIslands({ filter, results })`

const SWAP_PAGE = `// doc-check: skip - html template markup, which the sample check cannot tell from JSX.
import { html, slot } from "@nifrajs/web-vanilla"

type Books = { q: string; page: number; titles: string[]; more: boolean }

export default ({ data }: { data: Books }) => html\`
  <form action="/books" data-swap="replace:results">
    <input name="q" value="\${data.q}" />
    <button>Search</button>
  </form>
  <ul data-swap-slot="results">\${slot("results", [
    ...data.titles.map((title) => html\`<li data-island="book">\${title}</li>\`),
    data.more
      ? html\`<li><a href="/books?q=\${encodeURIComponent(data.q)}&page=\${data.page + 1}" data-swap="append:results">More</a></li>\`
      : "",
  ])}</ul>\``

const SWAP_ENTRY = `// doc-check: skip - browser DOM entry, typechecked in @nifrajs/web under its DOM lib.
import { defineIsland } from "@nifrajs/web/islands"
import { enableSwap } from "@nifrajs/web/islands/swap"

const book = defineIsland((el) => {
  const onClick = () => el.classList.toggle("picked")
  el.addEventListener("click", onClick)
  return () => el.removeEventListener("click", onClick)
})

// In place of mountIslands: mounts the islands, then refreshes slots from data-swap links and forms.
enableSwap({ book })`

export default function Islands() {
  return (
    <div className="prose">
      <h1 className="page">Islands: interactivity without hydration</h1>
      <p className="lead">
        A <code>@nifrajs/web-vanilla</code> page ships zero framework runtime. When one corner needs
        to be interactive, you don&apos;t turn on hydration - you mount an <strong>island</strong>{" "}
        over a server-rendered element. Write it as plain DOM code, or bind signals to the markup by
        name. Either way <code>nifra check</code> reads the island and the markup together.
      </p>

      <h2>Why islands, not hydration</h2>
      <p>
        Vanilla routes set <code>export const hydrate = false</code> in their{" "}
        <code>.backend.ts</code> half - there is no client framework to hydrate with, and that is
        the point. The five framework adapters give you a component runtime and pay for it in client
        JS and in failure modes (stale closures, hydration mismatch, what-re-runs-when) that trip up
        generated code. Islands keep the HTML the server sent and attach behavior to it. Reach for a
        framework adapter when you need client routing or nested views; reach for islands for
        widgets and small apps on an otherwise-static page.
      </p>

      <h2>Mount an island</h2>
      <p>
        Any element with <code>data-island=&quot;id&quot;</code> is a host; its props are inline
        JSON in <code>data-island-props</code>. Bundle one entry (in <code>frontend/</code>) that
        calls <code>mountIslands</code> with an enhancer per id, and load it with the{" "}
        <code>islandScripts</code> export of the route&apos;s <code>.backend.ts</code> half. Calling{" "}
        <code>mountIslands</code> again after a soft navigation mounts only new hosts, and the
        disposer it returns tears down every island it mounted.
      </p>
      <CodeBlock code={MARKER} />
      <p>There are two ways to write the enhancer, and one page can mix both.</p>

      <h2>Imperative islands: defineIsland</h2>
      <CodeBlock code={COUNTER} />
      <p>
        <code>defineIsland&lt;Props&gt;</code> is a zero-cost identity helper - its only job is to
        type <code>props</code> and <code>el</code> so the body needs no cast. Read the DOM, add
        listeners, <strong>return the cleanup</strong>. The returned function runs on teardown;
        forget it and every navigation leaks the listener - <code>nifra check</code> flags exactly
        that as <code>NF-C020</code>.
      </p>

      <h2>Reactive islands: bindIsland</h2>
      <p>
        For local state, mount the host with <code>bindIsland</code>. The setup declares named
        state with <code>state(key, fallback)</code> - seeded from the island&apos;s props when they
        carry the key - and returns its event handlers. The markup then binds them by name:
      </p>
      <CodeBlock code={REACTIVE_MARKUP} />
      <CodeBlock code={REACTIVE} />
      <table>
        <thead>
          <tr>
            <th>Attribute</th>
            <th>Effect</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>data-bind-text=&quot;count&quot;</code>
            </td>
            <td>Sets the element&apos;s text to the signal&apos;s value.</td>
          </tr>
          <tr>
            <td>
              <code>data-bind-show=&quot;open&quot;</code>
            </td>
            <td>Hides the element while the signal is falsy.</td>
          </tr>
          <tr>
            <td>
              <code>data-bind-class=&quot;active:open&quot;</code>
            </td>
            <td>Toggles a class per pair.</td>
          </tr>
          <tr>
            <td>
              <code>data-bind-attr=&quot;aria-expanded:open&quot;</code>
            </td>
            <td>
              Sets an attribute per pair, removing it for <code>false</code> or{" "}
              <code>null</code>. Never an <code>on*</code> attribute or <code>srcdoc</code>, and a
              URL attribute takes only an http(s), mailto, tel or relative URL.
            </td>
          </tr>
          <tr>
            <td>
              <code>data-bind-value=&quot;query&quot;</code>
            </td>
            <td>Two-way: an input, select or textarea writes the signal back.</td>
          </tr>
          <tr>
            <td>
              <code>data-bind-on=&quot;click:add&quot;</code>
            </td>
            <td>Adds a returned handler as an event listener per pair.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Values are names, never code, so markup cannot inject behavior. A binding belongs to its
        nearest island, and nothing inside a <code>data-island-ignore</code> element binds or mounts
        - render user HTML there. Because both sides are literal, <code>nifra check</code> matches
        them: <code>NF-C047</code> warns when a name has no <code>state(&quot;...&quot;)</code> key
        or returned handler, and <code>NF-C048</code> when a binding sits where no{" "}
        <code>bindIsland</code> host will ever walk it.
      </p>

      <h2>Signals</h2>
      <p>
        The reactive core is exported for code that needs more than markup bindings. A read inside
        an <code>effect</code> or <code>computed</code> subscribes; <code>batch</code> runs the
        effects once after several writes, and <code>untrack</code> reads without subscribing.
        Effects run after every computed they read has settled, so they never see a half-updated
        value.
      </p>
      <CodeBlock code={SIGNALS} />
      <p>
        Everything an enhancer creates while it sets up - effects, computeds, lists, resources - is
        owned by its island and stops when the island unmounts. <code>onDispose(fn)</code> covers
        timers and requests the setup starts itself. An effect created later, inside an event
        handler, is not owned: create it during setup.
      </p>

      <h2>Keyed lists and async state</h2>
      <p>
        <code>bindList(source, container, &#123; key, create, update &#125;)</code> renders a list
        signal into a container. A surviving item keeps its node, so focus and input state survive a
        reorder, and only the nodes out of order move. <code>resource(source, fetcher)</code> keeps
        an async value with a <code>pending</code>, <code>ready</code> or <code>error</code> state;
        a newer key aborts the older request, and an unmounted island drops a late result.
      </p>
      <CodeBlock code={LIST} />

      <h2>Coordinate islands with a typed bus</h2>
      <p>
        Islands are isolated by design - each enhances one element and shares no state. When two must
        talk (an &ldquo;add to cart&rdquo; button and a cart badge), use a{" "}
        <code>createIslandBus</code>: one typed channel, created once and closed over by each
        enhancer. No implicit global, so concurrent renders and tests never cross-talk.
      </p>
      <CodeBlock code={BUS_PATTERN} />
      <p>
        The bus is synchronous, in-memory, and carries no history - a subscriber sees only events
        emitted after it subscribes. A throwing handler is isolated from the others. Because{" "}
        <code>on()</code> returns its own unsubscribe, an enhancer whose only job is to listen can
        return it directly as its cleanup:
      </p>
      <CodeBlock code={CART} />

      <h2>Pattern: filter drives results</h2>
      <p>
        The same shape scales to any &ldquo;one island changes, another reacts&rdquo; case. Each
        island owns only its own DOM; they meet on the channel, never in a shared store.
      </p>
      <CodeBlock code={FILTER} />

      <h2>Refresh part of the page: swap</h2>
      <p>
        A search form or a &ldquo;more&rdquo; link on a vanilla page reloads the whole document.
        To refresh one region instead, mark it with <code>data-swap-slot</code>, render its content
        with <code>slot()</code> from <code>@nifrajs/web-vanilla</code>, and point the link or form
        at it with <code>data-swap=&quot;replace:&lt;slot&gt;&quot;</code> or{" "}
        <code>data-swap=&quot;append:&lt;slot&gt;&quot;</code>:
      </p>
      <CodeBlock code={SWAP_PAGE} />
      <p>
        Then call <code>enableSwap</code> from <code>@nifrajs/web/islands/swap</code> in place of{" "}
        <code>mountIslands</code> in the island entry. A page that does not import it pays nothing.
      </p>
      <CodeBlock code={SWAP_ENTRY} />
      <p>
        The link or form makes its usual request with an <code>x-nifra-swap</code> header. The
        server runs the page as usual - middleware, loader, action - and answers with that
        slot&apos;s HTML alone, so the fragment is a slice of the real page, never a second
        template. <code>replace</code> swaps the slot&apos;s content and, for a GET, pushes the
        URL, so a filtered list survives a reload and back and forward work. <code>append</code>{" "}
        adds to it, and a link or form inside the slot is spent: the slot&apos;s child that holds it
        is removed when the next page arrives.
      </p>
      <p>
        Any other answer - a redirect, another origin, a page without that slot, an error - loads
        the URL normally, as does a page whose Trusted Types policy refuses the HTML. A POST that
        gets a whole page back without a redirect has already run, so that page is shown in place
        at the action&apos;s URL, and going back loads the page before it. If Trusted Types
        refuses that page too, the URL loads with a plain GET: the form is not sent again, but the
        action&apos;s result is not shown. A form POST is never sent twice. Without the script, the
        links and
        forms work as plain HTML. A loading slot carries{" "}
        <code>aria-busy=&quot;true&quot;</code>, a newer swap of the same slot cancels the older
        one, and a failed request leaves the page as it is and sets <code>data-swap-error</code> on
        the link or form. Islands inside a slot
        mount with it and unmount when it is replaced, so interactivity inside a slot comes from
        islands in it, not from bindings of an island around it. Only{" "}
        <code>@nifrajs/web-vanilla</code> pages answer a swap.
      </p>
      <p>
        A swap response is <code>private, no-store</code> with <code>vary: x-nifra-swap</code>, and
        ISR never serves or stores one. A CDN that ignores <code>Vary</code>, such as a Cloudflare
        zone, needs its cache rule to bypass requests carrying <code>x-nifra-swap</code>;{" "}
        <code>nifra cdn-check</code> tests that. <code>nifra check</code> reads both sides:{" "}
        <code>NF-C049</code> flags <code>data-swap</code> on anything but a link or form, or a mode
        other than <code>replace</code> and <code>append</code>; <code>NF-C050</code> a slot name
        nothing declares; <code>NF-C051</code> a slot whose content is not its <code>slot()</code>{" "}
        alone; <code>NF-C052</code> a URL whose page renders no such slot; and <code>NF-C048</code>{" "}
        a binding inside a slot that belongs to an island outside it.
      </p>

      <h2>Load strategies</h2>
      <p>
        A host&apos;s <code>data-island-strategy</code> defers its enhancer: <code>load</code>{" "}
        (default), <code>idle</code>, <code>visible</code> (mount when it scrolls into view), or{" "}
        <code>media</code> with the query in <code>data-island-media</code>. A host with no matching
        enhancer, or an invalid strategy, stays inert server-rendered HTML - forward-compatible,
        never a runtime error.
      </p>
    </div>
  )
}
