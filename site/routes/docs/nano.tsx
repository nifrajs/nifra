import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

// Pure content page - no interactivity, so ship zero framework JS.
export const hydrate = false

export const meta = docsMeta(
  "/docs/nano",
  "Nifra - nano: explicit reactivity for small apps",
  "nano is the AI-safe small-app lane: signal + computed(fn, [deps]) + keyed bindList, no VDOM, no auto-tracking. Every reactive edge is a visible call, so its three mistakes are static lints (NF-C021/C022/C023) with a fix recipe - the same closed loop that makes the backend AI-safe, now on the frontend.",
)

// DOM-free, so it is a checked example (nifra_example nano): signal + computed by themselves.
const CORE = `import { signal, computed } from "@nifrajs/web/nano"

// State is a signal: reads are .get(), writes are .set(...). Every edge is a call you can see.
const count = signal(0)

// Derived state declares its dependencies EXPLICITLY - the array is the whole contract. It
// recomputes when (and only when) a listed source changes. Object.is-deduped, like signal.
const doubled = computed(() => count.get() * 2, [count])

const off = doubled.subscribe((v) => console.log("doubled is now", v))
count.set(5) // logs: doubled is now 10
off()        // unsubscribe`

// Enhancers touch the DOM, which the DOM-free doc-check program can't type. They are typechecked in
// @nifrajs/web under its own DOM lib and exercised at runtime; here they are illustrative.
const BIND = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { signal, bind } from "@nifrajs/web/nano"

const label = signal("hello")

// bind applies immediately AND on every change; it returns the disposer. COLLECT it - a bare
// bind(...) that drops its return leaks the subscription on soft-nav (nifra check flags NF-C021).
const off = bind(document.querySelector("h1")!, label, (el, v) => { el.textContent = v })
label.set("world") // the <h1> updates synchronously
// ...on teardown: off()`

const LIST = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { signal, bindList } from "@nifrajs/web/nano"

interface Todo { id: string; text: string; done: boolean }
const todos = signal<Todo[]>([])

// bindList keeps a container's children in sync with an array by KEY - a keyed reconcile, like a
// framework's list diff, but explicit. Add/remove/reorder reuse the right node instead of rebuilding.
const off = bindList(todos, document.querySelector("ul")!, {
  key: (t) => t.id, // a STABLE id on the item. Keying by the array index is NF-C022 - reorder breaks.
  create: (t) => { const li = document.createElement("li"); li.dataset.id = t.id; return li },
  update: (li, t) => { li.textContent = t.text; li.classList.toggle("done", t.done) },
})

todos.set([...todos.get(), { id: crypto.randomUUID(), text: "buy milk", done: false }])
// ...on teardown: off()`

// DOM-free, so it is a checked example (nifra_example nano): the async cell by itself.
const RESOURCE = `import { signal, resource } from "@nifrajs/web/nano"

const userId = signal(1)

// resource(fetcher, [deps]) is an async cell: it fetches immediately and again whenever a declared
// dep changes. The fetcher gets an AbortSignal; a superseded fetch is aborted and its late result
// dropped, so the newest request always wins - no stale-response flicker to hand-guard.
const user = resource(async (sig) => {
  const res = await fetch(\`/api/users/\${userId.get()}\`, { signal: sig })
  return (await res.json()) as { name: string }
}, [userId])

// The value is an explicit union - status is "pending" | "error" | "ready", never a secret undefined.
const off = user.subscribe((s) => {
  if (s.status === "ready") console.log("got", s.value.name)
})
userId.set(2) // refetches; the deps array is what NF-C023 checks against the fetcher's .get() reads
// ...on teardown: off()`

const BIND_RESOURCE = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { signal, resource, bindResource } from "@nifrajs/web/nano"

const userId = signal(1)
const user = resource(async (sig) => {
  const res = await fetch(\`/api/users/\${userId.get()}\`, { signal: sig })
  return (await res.json()) as { name: string }
}, [userId])

// bindResource dispatches on status - one handler per state, ready required. Like bind it returns a
// disposer (a bare bindResource(...) that drops it is NF-C021).
const off = bindResource(document.querySelector("[data-user]")!, user, {
  pending: (el) => { el.textContent = "Loading…" },
  ready: (el, u) => { el.textContent = u.name },
  error: (el) => { el.textContent = "Could not load user" },
})
// ...on teardown: off()`

const ISLAND = `// doc-check: skip - browser DOM enhancer, typechecked in @nifrajs/web under its DOM lib.
import { defineIsland, mountIslands } from "@nifrajs/web/islands"
import { signal, computed, bind, bindList } from "@nifrajs/web/nano"

interface Todo { id: string; text: string; done: boolean }

// nano lives INSIDE an island - the island owns mount/teardown, nano owns the state and the DOM edges.
const todos = defineIsland<{ items: Todo[] }>((el, props) => {
  const items = signal<Todo[]>(props.items)
  const remaining = computed(() => items.get().filter((t) => !t.done).length, [items])

  // Collect every disposer; the island's cleanup calls them all (this is what NF-C021 protects).
  const cleanups: Array<() => void> = []
  cleanups.push(bind(el.querySelector("[data-count]")!, remaining, (n, v) => {
    n.textContent = String(v) + " left"
  }))
  cleanups.push(bindList(items, el.querySelector("[data-list]")!, {
    key: (t) => t.id,
    create: (t) => { const li = document.createElement("li"); li.dataset.id = t.id; return li },
    update: (li, t) => { li.textContent = t.text; li.classList.toggle("done", t.done) },
  }))

  const add = (text: string) =>
    items.set([...items.get(), { id: crypto.randomUUID(), text, done: false }])
  void add

  return () => { for (const off of cleanups) off() }
})

mountIslands({ todos })`

export default function Nano() {
  return (
    <div className="prose">
      <h1 className="page">nano: explicit reactivity for small apps</h1>
      <p className="lead">
        <code>@nifrajs/web/nano</code> is the middle lane between a static{" "}
        <a href="/docs/islands">island</a> and a full framework adapter. It gives you a signal, a
        derived <code>computed</code>, and a keyed list - enough to build a small app with local
        state a human edits - and nothing else. No virtual DOM, no template compiler, no
        auto-tracking. Every reactive edge is a call you write, which is exactly what lets a tool
        catch the mistakes before runtime.
      </p>

      <h2>Why a fourth lane</h2>
      <p>
        A framework fails generated code not because it is unfamiliar but because its reactivity is{" "}
        <em>implicit</em>: an effect silently tracks what it read, a stale closure captures the wrong
        value, a render mismatches hydration - all silent, all runtime. Preact fixes the{" "}
        <strong>size</strong> of that model (3&nbsp;KB) but copies its footguns faithfully. nano
        fixes the <strong>failure model</strong> for the small-app band: dependencies are an explicit
        array, list keys are a required argument, cleanups are a returned value. Each of those is a
        thing a static check can see. Reach for nano when a page needs local state and a keyed list;
        reach for a <a href="/docs/frameworks">framework adapter</a> the moment you need client
        routing, nested view state, or suspense.
      </p>

      <h2>Signals and computed</h2>
      <p>
        A <code>signal</code> holds a value; <code>.get()</code> reads it and <code>.set(...)</code>{" "}
        replaces it (deduped with <code>Object.is</code>). A <code>computed</code> derives a value and
        declares its sources as an explicit deps array - it recomputes when a listed source changes,
        never by magic. Both are synchronous and framework-free.
      </p>
      <CodeBlock code={CORE} />
      <p>
        The deps array is the whole contract, and its one failure mode is catchable: a{" "}
        <code>computed</code> whose body reads a signal the array omits will never recompute when that
        signal changes. <code>nifra check</code> flags exactly that as <code>NF-C023</code> - the
        check reads which signals the body calls <code>.get()</code> on and compares them to the
        array. A framework&apos;s auto-tracked effect gives a tool nothing to compare, which is why
        the equivalent lint elsewhere is a best-effort warning, not a gate.
      </p>

      <h2>Bind a signal to the DOM</h2>
      <p>
        <code>bind</code> is the one-value edge: it applies your function immediately and on every
        change, and returns a disposer. <strong>Collect the disposer.</strong> A bare{" "}
        <code>bind(...)</code> whose return value is discarded leaks its subscription on soft-nav -{" "}
        <code>nifra check</code> flags it as <code>NF-C021</code>.
      </p>
      <CodeBlock code={BIND} />

      <h2>Keyed lists with bindList</h2>
      <p>
        <code>bindList</code> keeps a container&apos;s children in sync with an array by key - a keyed
        reconcile like a framework&apos;s list diff, but you spell the key out. Add, remove, and
        reorder reuse the matching node (preserving focus and scroll) instead of rebuilding the list.
        Key by a <strong>stable id</strong> on the item; keying by the array index reuses the wrong
        node on reorder, and <code>nifra check</code> flags it as <code>NF-C022</code>.
      </p>
      <CodeBlock code={LIST} />

      <h2>Async state with resource</h2>
      <p>
        <code>resource(fetcher, [deps])</code> is nano&apos;s answer to &ldquo;suspense&rdquo; - an
        async cell whose value is an explicit <code>&#123; status, value, error &#125;</code> union.
        It runs the fetcher immediately and again whenever a declared dep changes, and it handles the
        two things people get wrong by hand: the fetcher receives an <code>AbortSignal</code>, and a
        superseded request is aborted with its late result dropped, so the newest fetch always wins -
        no stale-response flicker. There is no thrown promise and no magic boundary; it is a value you
        read or bind like any other.
      </p>
      <CodeBlock code={RESOURCE} />
      <p>
        The deps array is checked exactly like <code>computed</code>: a <code>resource</code> whose
        fetcher reads a signal the array omits won&apos;t refetch when it changes, and{" "}
        <code>nifra check</code> flags it as <code>NF-C023</code>. Bind it to the DOM with{" "}
        <code>bindResource</code>, which dispatches on <code>status</code> - one handler per state,{" "}
        <code>ready</code> required, so a still-loading value can never render as a stray{" "}
        <code>undefined</code>.
      </p>
      <CodeBlock code={BIND_RESOURCE} />

      <h2>nano inside an island</h2>
      <p>
        nano owns state and DOM edges; an <a href="/docs/islands">island</a> owns mount and teardown.
        Put the signals in the enhancer, collect every disposer, and return one cleanup that calls
        them all. Scaffold this shape with{" "}
        <code>nifra_scaffold &#123; path, variant: &quot;stateful&quot; &#125;</code> on a vanilla
        project - it emits the golden pattern below.
      </p>
      <CodeBlock code={ISLAND} />

      <h2>The three checks</h2>
      <p>
        nano&apos;s explicitness is the whole point: because each reactive edge is a visible call, its
        three mistakes are static lints with a fix recipe - the same closed loop (<code>scaffold</code>{" "}
        &rarr; <code>check</code> &rarr; <code>fix</code> &rarr; <code>verify</code>) that makes the
        backend AI-safe, now on the frontend.
      </p>
      <ul>
        <li>
          <code>NF-C021</code> - a <code>bind</code>/<code>bindList</code> whose disposer is
          discarded. Collect it; call it on teardown.
        </li>
        <li>
          <code>NF-C022</code> - a <code>bindList</code> keyed by the array index. Key by a stable id.
        </li>
        <li>
          <code>NF-C023</code> - a <code>computed</code> that reads a signal its deps omit. Add it to
          the deps array.
        </li>
      </ul>
      <p>
        All three <em>warn</em> - a false positive must never fail a build - and each carries a fix
        recipe an agent can apply. Where nano stops (client routing, nested views, suspense), stop
        adding nano and reach for <code>@nifrajs/web-preact</code> or another framework adapter.
      </p>
    </div>
  )
}
