import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/query",
  "Nifra - Query cache",
  "Nifra's cross-framework keyed query cache: reactive queries, mutations, infinite lists, and SSR hydration.",
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

const FRAMEWORK_BINDINGS = `// React / Preact: hooks with a promise-returning mutation.
// The mutation function receives a context with a shared AbortSignal as its second argument.
const saveProfile = async (profile, { signal }) => {
  const response = await fetch("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
    signal,
  })
  if (!response.ok) throw new Error("Profile save failed")
  return response
}
const save = useMutation(saveProfile)
await save.mutateAsync(profile)

// Vue: state is a ref; read it with .value.
const save = useMutation(saveProfile)
await save.mutateAsync(profile)
save.state.value.status

// Svelte: mutation and infinite-query bindings are readable stores.
const save = useMutation(saveProfile)
await save.mutateAsync(profile)
// In markup, read $save.status.

// Solid: state is exposed through accessors.
const save = createMutation(saveProfile)
await save.mutateAsync(profile)
save.state().status`

const SSR_QUERY_CACHE = `// Create one QueryClient for this server request.
const queryClient = createQueryClient({ now: () => Date.now() })
await queryClient.prefetchQuery(["profile", user.id], loadProfile)
const queryState = queryClient.dehydrate({
  // Nothing is sent unless this returns true: name what is safe for the visitor to read.
  shouldDehydrateQuery: ({ key }) => Array.isArray(key) && key[0] === "profile",
})

// Return queryState through the route's normal loader-data serializer.
// On the client, seed the app's client before query components mount.`

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
        third argument&apos;s option), a background refetch, and bounded GC. The query cache also has
        mutation and infinite-query bindings across the adapters, using each framework&apos;s reactive
        model.
      </p>
      <CodeBlock code={USE_QUERY} />

      <h2>Mutations and infinite queries</h2>
      <p>
        React and Preact expose <code>useMutation</code> and <code>useInfiniteQuery</code>. Vue
        exposes composables whose reactive state is read from refs. Svelte returns readable stores,
        and Solid exposes <code>createMutation</code> and <code>createInfiniteQuery</code> accessors.
        Each mutation has <code>mutate</code>, <code>mutateAsync</code>, <code>reset</code>, and
        <code>cancel</code>; each paged query exposes next/previous-page controls and page-availability
        state. Mutations remain client state bindings: the server action or endpoint still enforces
        authorization. Mutation functions receive a shared context with a <code>signal</code> as
        their second argument. <code>onMutate</code> receives that context second;
        <code>onSuccess</code> and <code>onError</code> receive it third; and <code>onSettled</code>
        receives it fourth. Pass <code>context.signal</code> to <code>fetch</code> and check it before
        side effects after an <code>await</code>. <code>cancel</code> aborts that signal, rejects the local promise, and
        discards local results; the request or server action only stops if it honors the signal, and accepted server work may
        finish.
      </p>
      <CodeBlock code={FRAMEWORK_BINDINGS} />

      <h2>SSR cache hydration</h2>
      <p>
        Query-cache hydration is separate from hydrating server-rendered markup. Create a fresh query
        client for each server request, prefetch the data, and pass its dehydrated state through Nifra
        route data. React and Preact use <code>QueryClientProvider</code> with
        <code>HydrationBoundary</code>; Solid accepts the state on <code>QueryClientProvider</code>;
        Vue and Svelte call <code>provideQueryClient(client, state)</code> in the app root before child
        queries initialize. The browser may keep one client for the app. Query state is cleared on
        identity changes, and in-flight mutation results are discarded at that boundary.
      </p>
      <p>
        Every value included by <code>dehydrate</code> is serialized to the browser and is visible to
        that visitor, so <code>dehydrate</code> sends nothing by default. Pass
        <code>shouldDehydrateQuery</code> to name the regular and infinite queries that are safe to
        send; pass <code>() =&gt; true</code> only when every successful query in that client is
        meant for the browser. Never include tokens or server-only fields.
      </p>
      <CodeBlock code={SSR_QUERY_CACHE} />

      <h2>Invalidation</h2>
      <p>
        After a mutation, <code>useQueryClient().invalidateQueries(key)</code> marks matching entries
        stale (by exact key or array <b>prefix</b>) and refetches the mounted ones - no manual cache
        surgery.
      </p>
      <p>
        In an app with <a href={href({ to: "/docs/live" })}>live refresh</a>, a query can name the live keys its data
        depends on: <code>useQuery(key, fn, {"{ live: [`post:${id}`] }"})</code> refetches whenever
        the server publishes one of them.
      </p>
      <h2>Sign-in and sign-out</h2>
      <p>
        A cached query never answers for the next visitor. <code>identityChanged()</code> from{" "}
        <code>@nifrajs/web/client</code> clears every query client in the page: mounted queries go
        back to pending and refetch, the rest drop their data. A fetch still loading loads once more
        for the new visitor before it settles. In an app with a{" "}
        <a href={href({ to: "/docs/keep-alive", hash: "sign-in" })}>keepAlive</a> route, the identity epoch cookie a sign-in
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
