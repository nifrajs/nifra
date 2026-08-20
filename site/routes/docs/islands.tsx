import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

// Pure content page - no interactivity, so ship zero framework JS.
export const hydrate = false

export const meta = docsMeta(
  "/docs/islands",
  "Nifra - Islands: the AI-safe interactivity lane",
  "Add interactivity to a zero-runtime vanilla page with islands - imperative DOM enhancers, no framework runtime, no hydration. Explicit code an AI (or a human) gets right first try: mount, coordinate over a typed bus, always return cleanup.",
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
const MARKER = `// doc-check: skip - server-rendered island marker (HTML, not a checkable module).
// In your @nifrajs/web-vanilla page, render the host element with inline JSON props:
html\`<nifra-island data-id="counter" data-props=\${JSON.stringify({ start: 0 })}>
  <output>0</output>
  <button type="button">+1</button>
</nifra-island>\``

const COUNTER = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { defineIsland, mountIslands } from "@nifrajs/web/islands"

// defineIsland pins the data-props type; the body is plain imperative DOM. ALWAYS return the
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

export default function Islands() {
  return (
    <div className="prose">
      <h1 className="page">Islands: the AI-safe interactivity lane</h1>
      <p className="lead">
        A <code>@nifrajs/web-vanilla</code> page ships zero framework runtime. When one corner needs
        to be interactive, you don&apos;t turn on hydration - you mount an <strong>island</strong>: a
        small, plain-DOM enhancer over a server-rendered element. Explicit imperative code with no
        hidden reactivity - the shape an AI agent (or a human) gets right on the first try.
      </p>

      <h2>Why islands, not hydration</h2>
      <p>
        Vanilla routes set <code>export const hydrate = false</code> - there is no client framework
        to hydrate with, and that is the point. The five framework adapters give you a reactive
        runtime and pay for it in client JS and in the subtle failure modes (stale closures,
        hydration mismatch, what-re-runs-when) that trip up generated code. Islands take the other
        trade: no runtime, no reactivity to get wrong. You wire the DOM by hand and hand back a
        teardown. Reach for a framework adapter when you genuinely need a stateful app UI; reach for
        islands for widgets on an otherwise-static page.
      </p>

      <h2>Mount an island</h2>
      <p>
        Render a <code>&lt;nifra-island&gt;</code> marker in your page (props are inline JSON), then
        bundle one entry that calls <code>mountIslands</code>. Load it via the route&apos;s{" "}
        <code>islandScripts</code>.
      </p>
      <CodeBlock code={MARKER} />
      <CodeBlock code={COUNTER} />
      <p>
        <code>defineIsland&lt;Props&gt;</code> is a zero-cost identity helper - its only job is to
        type <code>props</code> and <code>el</code> so the body needs no cast. Keep the body
        imperative: read the DOM, add listeners, <strong>return the cleanup</strong>. The returned
        function runs on soft-nav teardown; forget it and every navigation leaks the listener -{" "}
        <code>nifra check</code> flags exactly that as <code>NF-C020</code>.
      </p>

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

      <h2>Load strategies</h2>
      <p>
        A marker&apos;s <code>data-strategy</code> defers its enhancer: <code>load</code> (default),{" "}
        <code>idle</code>, <code>visible</code> (mount when it scrolls into view), or a{" "}
        <code>media</code> query. An island with no matching enhancer, or an invalid strategy, stays
        inert server-rendered HTML - forward-compatible, never a runtime error.
      </p>
    </div>
  )
}
