import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"

export const meta = docsMeta(
  "/docs/query",
  "Nifra - Query cache",
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
  // After a mutation, invalidate by key (or prefix) - matching queries refetch.
  return <button onClick={() => qc.invalidateQueries(["user"])}>Refresh</button>
}`

export default function Query() {
  return (
    <div className="prose">
      <h1 className="page">Query cache</h1>
      <p className="lead">
        For client-side data that isn't a route loader - lists, widgets, anything refetchable -
        Nifra ships a keyed query cache (TanStack-Query-style), agnostic across all five adapters.
      </p>

      <h2>useQuery / createQuery</h2>
      <p>
        <code>useQuery(key, fn)</code> (React, Preact, Vue and Svelte) and{" "}
        <code>createQuery(key, fn)</code> (Solid), each from the adapter&apos;s <code>/query</code>{" "}
        entry, subscribe a component to a cached, keyed query. Concurrent reads of the same key{" "}
        <b>dedup</b> into one in-flight fetch; results are cached with a <code>staleTime</code> (the
        third argument&apos;s option), a background refetch, and bounded GC. React also has{" "}
        <code>useMutation</code>, <code>useInfiniteQuery</code> and <code>HydrationBoundary</code>.
      </p>
      <CodeBlock code={USE_QUERY} />

      <h2>Invalidation</h2>
      <p>
        After a mutation, <code>useQueryClient().invalidateQueries(key)</code> marks matching entries
        stale (by exact key or array <b>prefix</b>) and refetches the mounted ones - no manual cache
        surgery.
      </p>
      <p>
        In an app with <a href="/docs/live">live refresh</a>, a query can name the live keys its data
        depends on: <code>useQuery(key, fn, {"{ live: [`post:${id}`] }"})</code> refetches whenever
        the server publishes one of them.
      </p>
      <h2>Sign-in and sign-out</h2>
      <p>
        A cached query never answers for the next visitor. <code>identityChanged()</code> from{" "}
        <code>@nifrajs/web/client</code> clears every query client in the page: mounted queries go
        back to pending and refetch, the rest are dropped. In an app with a{" "}
        <a href="/docs/keep-alive#sign-in">keepAlive</a> route, the identity epoch cookie a sign-in
        or sign-out response rotates does the same on the client&apos;s next read.
      </p>
      <p>
        It's the same agnostic core under every adapter: the cache, dedup, and invalidation logic
        live in <code>@nifrajs/web</code>; each binding is a thin wrapper in its framework&apos;s own
        reactivity (<code>useSyncExternalStore</code>, a signal, a <code>shallowRef</code>, a store).
      </p>
    </div>
  )
}
