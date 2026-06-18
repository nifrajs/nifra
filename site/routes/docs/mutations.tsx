import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Optimistic UI & fetchers",
  "Optimistic updates and concurrent fetchers in Nifra: instant feedback, row-level mutations.",
)

const OPTIMISTIC = `import { useFetcher } from "@nifrajs/web-react/fetcher"

// Optimistic UI: while a submit is in flight, read the expected value from the in-flight
// submission's FormData; the real data takes over when the action resolves, and a failed
// submit reverts automatically — no manual rollback.
const fetcher = useFetcher("todo:" + id)
const pending = fetcher.submission?.formData.get("done")        // the value you just submitted
const done = pending != null ? pending === "true" : todo.done   // optimistic value wins while pending

function toggle() {
  const fd = new FormData()
  fd.set("id", String(id))
  fd.set("done", String(!done))
  fetcher.submit("/todos", fd)   // submit(actionPath, body) — runs the route's action
}`

const FETCHERS = `import { useFetcher, useFetchers } from "@nifrajs/web-react/fetcher"

// Concurrent fetchers: each keyed fetcher is its own state machine, so many rows
// mutate in parallel without clobbering each other. \`pending\` is the in-flight flag.
function Row({ id }: { id: string }) {
  const f = useFetcher("row:" + id)
  const save = () => { const fd = new FormData(); fd.set("id", id); f.submit("/rows", fd) }
  return <button disabled={f.pending} onClick={save}>Save</button>
}

// useFetchers() exposes the live collection — e.g. a global "saving…" indicator.
const anyPending = useFetchers().some((f) => f.snapshot().pending)`

export default function Mutations() {
  return (
    <div className="prose">
      <h1 className="page">Optimistic UI &amp; fetchers</h1>
      <p className="lead">
        Beyond the per-route action, Nifra gives you optimistic updates and independent, concurrent
        fetchers for snappy, granular mutations — agnostic across all five frameworks, each in its
        idiom.
      </p>

      <h2>Optimistic updates</h2>
      <p>
        While a submit is in flight, read the value back from the submission's <code>formData</code>{" "}
        (on a fetcher, <code>fetcher.submission</code>; on a route, the <code>submission</code> prop)
        and the UI reflects it immediately. When the action resolves the real data takes over, and a
        failed submit <b>reverts</b> automatically — no manual rollback bookkeeping.
      </p>
      <CodeBlock code={OPTIMISTIC} />

      <h2>Concurrent fetchers</h2>
      <p>
        <code>useFetcher(key)</code> (React) / <code>createFetcher(key)</code> (Solid) is an
        independent submission state machine — perfect for row-level actions or side-channel loads
        that shouldn't block navigation. <code>useFetchers()</code> exposes the live collection for
        global pending indicators. After a mutation, targeted revalidation refreshes just the
        affected data (via the <code>X-Nifra-Revalidate</code> header).
      </p>
      <CodeBlock code={FETCHERS} />
    </div>
  )
}
