import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Query cache",
  "Nifra's keyed query cache: useQuery / createQuery, dedup, staleness, invalidation.",
)

const USE_QUERY = `import { useQuery, useQueryClient } from "@nifrajs/web-react/query"

function Profile({ id }: { id: string }) {
  // Keyed + cached. Concurrent useQuery's with the same key dedup into one fetch;
  // results are cached, with staleTime + background refetch.
  const { data, isPending, refetch } = useQuery(["user", id], () =>
    fetch(\`/api/users/\${id}\`).then((r) => r.json()),
  )
  if (isPending) return <p>Loading…</p>
  return <h1>{data.name}</h1>
}

function CreateUser() {
  const qc = useQueryClient()
  // After a mutation, invalidate by key (or prefix) — matching queries refetch.
  return <button onClick={() => qc.invalidateQueries(["user"])}>Refresh</button>
}`

export default function Query() {
  return (
    <div className="prose">
      <h1 className="page">Query cache</h1>
      <p className="lead">
        For client-side data that isn't a route loader — lists, widgets, anything refetchable —
        Nifra ships a keyed query cache (TanStack-Query-style), agnostic across React and Solid.
      </p>

      <h2>useQuery / createQuery</h2>
      <p>
        <code>useQuery(key, fn)</code> (React) and <code>createQuery(key, fn)</code> (Solid) subscribe
        a component to a cached, keyed query. Concurrent reads of the same key <b>dedup</b> into one
        in-flight fetch; results are cached with a <code>staleTime</code>, a background refetch, and
        bounded GC.
      </p>
      <CodeBlock code={USE_QUERY} />

      <h2>Invalidation</h2>
      <p>
        After a mutation, <code>useQueryClient().invalidateQueries(key)</code> marks matching entries
        stale (by exact key or array <b>prefix</b>) and refetches the mounted ones — no manual cache
        surgery.
      </p>
      <p>
        It's the same agnostic core under both adapters: the cache, dedup, and invalidation logic
        live in <code>@nifrajs/web</code>; the bindings are thin <code>useSyncExternalStore</code> /
        signal wrappers.
      </p>
    </div>
  )
}
