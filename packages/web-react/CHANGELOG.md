# @nifrajs/web-react

## 2.7.1

### Patch Changes

- 322cc2b: SSR `react-dom/server` resolution now also detects a bundled server that was built without `nifra build` (a hand-rolled `bun build --target bun` carries no bundle marker): inside any bundle the adapter uses the bundle's own inlined, deduped react-dom instead of re-importing a second copy from disk. That second copy could crash hook-using components (two React cores) or, hook-free, silently render with development React when the runtime `NODE_ENV` was unset - an SSR slowdown that looked like a runtime regression. The SSR benchmark's Bun row builds with the same bundle marker `nifra build` stamps, so it measures production React.
- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1
  - @nifrajs/web@2.7.1
  - @nifrajs/i18n@2.7.1
  - @nifrajs/image@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/core@2.7.0
- @nifrajs/i18n@2.7.0
- @nifrajs/image@2.7.0
- @nifrajs/web@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
- Updated dependencies [80419f5]
  - @nifrajs/core@2.6.1
  - @nifrajs/web@2.6.1
  - @nifrajs/i18n@2.6.1
  - @nifrajs/image@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [e6349e5]
- Updated dependencies [08fe221]
- Updated dependencies [8383063]
  - @nifrajs/web@2.6.0
  - @nifrajs/core@2.6.0
  - @nifrajs/i18n@2.6.0
  - @nifrajs/image@2.6.0

## 2.5.0

### Patch Changes

- 02d9aa8: Routing hooks now SSR-render correctly on the dev server. In dev, the adapter is imported by Bun while route modules load through Vite's SSR runner, so the router module could be evaluated twice in one process - two context objects, and `useSearch`/`useParams`/`useLocation` read a context the render never provided. The result was hooks SSR-rendering their empty defaults (`useSearch()` gave `{}`) while the same request's loader saw the validated values; hydration then papered over it on the client, so it surfaced as "the search schema doesn't work in dev". The router context in every adapter is now a `globalThis` singleton (keyed by `Symbol.for`), so both evaluations share the one context React/Vue/Solid/Preact matches providers to readers by. The Vite dev server also mirrors its client `resolve.conditions` into `ssr.resolve.{conditions,externalConditions}`, so dev SSR resolves the same `bun`-conditioned source files Bun does instead of a package's `dist` artifact - which nothing in the dev loop rebuilds, and whose staleness previously 500'd inside framework code.
- Updated dependencies [02d9aa8]
  - @nifrajs/web@2.5.0
  - @nifrajs/core@2.5.0
  - @nifrajs/i18n@2.5.0
  - @nifrajs/image@2.5.0

## 2.4.0

### Patch Changes

- Updated dependencies [1c2bf5a]
- Updated dependencies [138bfba]
- Updated dependencies [23e6eb1]
  - @nifrajs/web@2.4.0
  - @nifrajs/core@2.4.0
  - @nifrajs/i18n@2.4.0
  - @nifrajs/image@2.4.0

## 2.3.0

### Minor Changes

- c823915: Typed, validated search params: a route declares a `searchSchema` and both its loader and its component read the parsed, validated query.

  Export a Standard Schema as `searchSchema` from a route. The loader's `ctx.search` becomes the parsed URL query validated against it (typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`), and the component reads the same value with `useSearch<typeof searchSchema>()`. Invalid or hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, both are the raw parsed query. Validation runs at match time and the value is derived identically on the server and on client navigation, so a component never parses `window.location.search` by hand and the query it renders hydrates with no mismatch.

  ```tsx
  export const searchSchema = v.object({
    page: v.optional(v.fallback(v.number(), 1), 1),
  });

  export async function loader({
    search,
    api,
  }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
    return { rows: await api.reports.list(search).get() }; // search.page is a number
  }

  export default function Reports({ data }) {
    const { page } = useSearch<typeof searchSchema>(); // page: number, SSR-correct
    return <Pager page={page} />;
  }
  ```

  A `_layout` can declare its own `searchSchema` for keys shared across a section (`?org`, `?theme`); the route's effective search merges the layout chain's schemas with the page's, page-wins on a conflict, so both the layout and the page read their validated slice from one object.

  A route can also list `searchClientKeys` - search keys that are purely client-side UI (`?tab`, a client-side `?sort`, `?modal`). When a client navigation changes only those keys, the URL updates (so `useSearch` re-renders) without re-running the loader; any other key change revalidates as before, so data is never stale.

  `useSearch` ships on every adapter - React (a value), Preact (a value), Vue (a `Ref`), Solid (an `Accessor`), and Svelte (an accessor), each in that framework's own shape.

  `navigate` gains an object form on every adapter: `navigate({ to, search, replace })` serializes `search` onto `to` (no hand-built query strings). Run `nifra sync-routes` to generate `nifra-routes.d.ts` (each static route mapped to its schema output) and include it in your tsconfig, and `search` is typed against the target route's `searchSchema` - a wrong shape for a known route is a compile error, while an unmapped path takes a loose `search`. Regenerated from the route files, so a stale shape becomes a `tsc` error. The string-path and history-delta forms are unchanged.

  ```ts
  navigate({ to: "/reports", search: { page: 2 } }); // search typed against /reports's schema
  ```

- 62a8d03: Add `useServerFn` - a server function's pending, data and error state - to all five adapters.

  ```tsx
  const addTodo = useServerFn(fns.addTodo)
  <button disabled={addTodo.pending} onClick={() => addTodo.call({ text }).catch(() => {})}>add</button>
  ```

  Calling a server function never needed a binding: the client stub is `(input) => Promise<Output>`.
  This adds only the state a component wants around it.

  The state machine is `@nifrajs/web`'s `createServerFnStore`, shared by every adapter, so "is it
  pending" has one answer rather than five that drift. Each binding contributes just its subscription
  primitive: `useSyncExternalStore` (React, Preact), a signal (Solid), a `shallowRef` (Vue), a `readable`
  (Svelte).

  Two behaviours worth knowing:

  - **The last call wins.** A response that is no longer the newest is discarded rather than written, so
    a slow first call landing after a fast second cannot overwrite fresh data with stale.
  - **`call` still rejects.** The error is recorded for rendering AND the promise rejects, so `await`
    behaves normally. A caller that only renders from state should attach `.catch(() => {})`, as with
    `useFetcher`'s `submit`.

  `data` is kept while the next call is in flight, so a rendered list does not blank on every refetch.

- dcacfe7: Guard navigation away from unsaved work with `useBlocker`.

  Mirrors react-router's shape: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
  predicate and get back `{ state, proceed, reset }`. When a navigation is intercepted - a `<Link>` or
  anchor click, `useNavigate`, or a browser back/forward - `state` becomes `"blocked"`, so you render
  your OWN confirmation and call `proceed()` to continue or `reset()` to stay. A plain boolean can't
  express an async "are you sure?"; these two callbacks can.

  ```tsx
  import { useBlocker } from "@nifrajs/web-react/router";

  const blocker = useBlocker(form.isDirty);

  return blocker.state === "blocked" ? (
    <ConfirmDialog onConfirm={blocker.proceed} onCancel={blocker.reset} />
  ) : null;
  ```

  Back and forward are guarded too: the destination URL is restored before you are asked, so the page
  never changes underneath the prompt. It also arms the browser's native "Leave site?" prompt on tab
  close and reload. Idle on the server and before hydration, so it degrades to native navigation and
  stays hydration-safe.

### Patch Changes

- ea0a27f: A server function has one type per half, so both the server call and the hook argument are honest.

  ```ts
  export type ClientServerFn<Input, Output> = (
    input: Input
  ) => MaybePromise<Output>;
  export type ServerFnReference<Input, Output> =
    | ServerFn<Input, Output>
    | ClientServerFn<Input, Output>;
  ```

  One type could not describe both halves. `ServerFn` is the SERVER declaration and takes `(input,
context)`; the client imports a generated stub that takes one argument. Widening the single type so a
  one-argument call compiled made a direct server call type-check while handing the declaration
  `undefined` for a context its implementation requires - a runtime failure the compiler had just been
  told to allow.

  Now the two are separate and `useServerFn` accepts either through `ServerFnReference`, which is the
  one place the two halves legitimately meet. Calling a declaration from your own server code needs the
  context, and omitting it is a compile error again.

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [7293a1c]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [45b0733]
- Updated dependencies [c42d777]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [d190b1c]
- Updated dependencies [a4ecca9]
- Updated dependencies [de8d992]
- Updated dependencies [a92104e]
- Updated dependencies [5fe332a]
- Updated dependencies [c823915]
- Updated dependencies [d2840ac]
- Updated dependencies [62a8d03]
- Updated dependencies [dcacfe7]
- Updated dependencies [28704d7]
- Updated dependencies [ea0a27f]
- Updated dependencies [0c2de22]
  - @nifrajs/core@2.3.0
  - @nifrajs/web@2.3.0
  - @nifrajs/i18n@2.3.0
  - @nifrajs/image@2.3.0

## 2.2.0

### Minor Changes

- 1394641: Layout loaders: request data in the component that wraps every page.

  `routes/_layout.tsx` rendered, but a `loader` it exported never ran, so nothing request-derived could
  reach a layout - host, session, locale, feature flags, tenant. An app hit this and moved its host guard
  out of the component tree into the server entry, where it could not be typechecked with the rest of the
  app. That is the real cost: the gap pushed security-relevant code to the one place nifra's typed-boundary
  promise does not reach. Remix, React Router and SvelteKit all support this; nifra was alone in not.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  export const gate = true                       // optional; see below
  export async function loader({ params, req }) {
    return { org: await findOrg(params.org) }    // params is { org } - nothing deeper
  }
  export default function Layout({ data, children }) { … }
  ```

  **Scoped, not global.** A layout owns the URL prefix it wraps, so it receives only the params inside
  that prefix and its loader is skipped on a navigation that did not change them. Navigating
  `/orgs/acme/a` → `/orgs/acme/b` does not re-run the org layout's loader. Scope is derived at build time
  per `(route, layout)` pair, because one layout can own different params on different expanded patterns:
  `[[lang]]/docs/_layout` owns nothing on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`. Layouts are
  not router nodes and did not become any - the router is untouched.

  **Execution order is declared, and this matters for security.** By default a layout loader runs in
  parallel with the page's, which is right for data and wrong for a guard: a page loader running
  concurrently with a guard has already queried by the time the guard says no. `export const gate = true`
  makes a layout blocking - nothing beneath it runs until it resolves, and nothing beneath a rejected gate
  runs at all. **A layout loader without `gate: true` is not an authorization boundary.** Gates also run on
  the data-only request, so a client navigation cannot bypass one by sending the data header, and a gate is
  never skipped by the retention hint.

  A layout may throw `notFound()` / `gone()` / `redirect()`. Its errors resolve to the `_error` boundary at
  or above its OWN segment, never one below it - rendering there would wrap the boundary in the very layout
  whose loader just failed.

  Every adapter passes each layout its own data. A layout with no loader receives `null`, and an app where
  no layout has a loader emits byte-identical HTML and unchanged props.

  The data-mode response becomes a versioned envelope when a chain carries layout data. It is recognised
  by structure, and the bare pre-envelope shape is still accepted - a prerendered `_data.json` is a static
  file that outlives the deploy that wrote it.

### Patch Changes

- 1f52a12: Catch a duplicate React reaching SSR with both paths, instead of a null-dispatcher crash.

  The adapter already re-roots `react-dom/server` to the app so it shares the route components' React. That
  fixes the common case but cannot guarantee the last mile: a `react` nested under react-dom, or a
  components tree resolving `react` elsewhere, still puts two React cores in the render. Two cores is two
  hook dispatchers, and SSR throws `resolveDispatcher().useState is null` from deep inside react-dom-server

  - a message that names a React internal and nothing about the two directories that caused it, from which
    the real fix is hours of inference.

  After re-rooting, the adapter now compares the realpath of the `react` react-dom will render with against
  the `react` the components import, and if they differ throws naming both paths and the fix. `nifra doctor`
  checks what is installed; this checks what SSR actually resolved, which is the only thing that can catch a
  duplicate the two dev pipelines introduce (Bun resolves SSR, Vite the client) rather than the install - a
  Vite `resolve.dedupe` or alias fixes only the client bundle, never this path. Silent on the single-copy
  common case, and it never manufactures a failure: a `react` it cannot resolve on either side is not
  evidence of a duplicate. Runs once, under the unbundled Bun runtime only, so bundled and non-Bun outputs
  are untouched.

- Updated dependencies [39b1670]
- Updated dependencies [d428f52]
- Updated dependencies [135d0c6]
- Updated dependencies [5f460db]
- Updated dependencies [1394641]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [a7d740a]
- Updated dependencies [6e996a1]
- Updated dependencies [15ad6ca]
- Updated dependencies [6aa0aac]
- Updated dependencies [1857d39]
- Updated dependencies [6ba3173]
- Updated dependencies [ca71a2e]
- Updated dependencies [0fc215b]
- Updated dependencies [2ff661f]
- Updated dependencies [a1327a4]
- Updated dependencies [2500705]
  - @nifrajs/web@2.2.0
  - @nifrajs/core@2.2.0
  - @nifrajs/i18n@2.2.0
  - @nifrajs/image@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0
  - @nifrajs/web@2.1.0
  - @nifrajs/i18n@2.1.0
  - @nifrajs/image@2.1.0

## 2.0.0

### Minor Changes

- a7d34e5: Navigation loading UI for `@nifrajs/web-react/router`, plus a per-link pending signal.

  nifra navigates imperatively - it fetches the next route's chunk and loader data while the current route stays on screen, then swaps - so a route transition is signalled by the router's `pending` flag, not a Suspense boundary.

  - `useNavigation()` returns `{ pending, state: "idle" | "loading", location }` (Remix-shaped); `location` is the `pathname + search` being navigated to while pending. `usePending()` is the boolean form.
  - `NavLink`'s render-prop `isPending` is now real: it is `true` while a navigation to that link's own target is in flight (matched like `isActive`), so a link can show its own spinner. Previously always `false`.
  - The agnostic router now publishes `pendingPath` (the navigation target) on its state while `pending`, and `compose` threads `pending`/`pendingPath` into the router context. Both are `false`/absent on the server and the initial client render, so they are hydration-safe.

### Patch Changes

- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [d91a45b]
- Updated dependencies [d91a45b]
- Updated dependencies [e97a92f]
- Updated dependencies [a7b1d60]
- Updated dependencies [e8e49d1]
- Updated dependencies [a7d34e5]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/web@2.0.0
  - @nifrajs/i18n@2.0.0
  - @nifrajs/image@2.0.0

## 1.13.0

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0
  - @nifrajs/web@1.13.0
  - @nifrajs/i18n@1.13.0
  - @nifrajs/image@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0
  - @nifrajs/web@1.12.0
  - @nifrajs/i18n@1.12.0
  - @nifrajs/image@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0
  - @nifrajs/web@1.11.0
  - @nifrajs/i18n@1.11.0
  - @nifrajs/image@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0
  - @nifrajs/web@1.10.0
  - @nifrajs/i18n@1.10.0
  - @nifrajs/image@1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Tidy the `@nifrajs/web-react/query` module documentation comment. Docs only - no API or behavior change.
- Updated dependencies [3eb27ae]
  - @nifrajs/web@1.9.1
  - @nifrajs/core@1.9.1
  - @nifrajs/i18n@1.9.1
  - @nifrajs/image@1.9.1

## 1.9.0

### Minor Changes

- 0e1b4cc: Add a full React Query core on `@nifrajs/web-react/query` - `useQuery` (now with `enabled`/`staleTime`),
  `useMutation`, `useInfiniteQuery`, `useQueryClient`, `QueryClientProvider`, and the SSR
  `HydrationBoundary` - a drop-in for the TanStack Query surface, backed by an expanded agnostic engine in
  `@nifrajs/web`.

  The engine (`createQueryClient`) gains imperative cache ops (`getQueryData`/`setQueryData` for optimistic
  updates, `prefetchQuery`), per-query `staleTime`, SSR `dehydrate`/`hydrate`, and paged (`infiniteQuery`)
  support; plus a standalone `createMutation` state machine (single-flight, TanStack callback order). All
  logic lives in the injected-clock, framework-free engine so it's deterministically tested; the React
  bindings are thin `useSyncExternalStore` wrappers. A hook without a `QueryClientProvider` uses a
  client-side singleton (SSR-idle); with a `HydrationBoundary`-fed provider client, queries render their
  server-seeded data during SSR with no hydration flash.

- 6b67833: Add first-class React routing bindings on the new `@nifrajs/web-react/router` subpath - `<Link>`,
  `<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>` - a
  drop-in replacement for `react-router-dom`'s routing surface over nifra's own file-based router.

  The read hooks are SSR-correct: `@nifrajs/web` now threads the matched route's `params` and the
  request `path` (`pathname + search`) through the render seam (`RenderProps`), and the React adapter's
  `compose` provides them via a `RouterContext` on both the server render and the client mount - so
  `useParams`/`useLocation`/`useSearchParams` return the same value on each side with no hydration
  mismatch. Programmatic navigation flows through a new DOM-free bridge (`getBrowserNavigate` /
  `setBrowserNavigate`, populated by `installHistory`), which also gains history `replace` support, so a
  route component reaches history-aware navigation without importing the browser-only client layer.

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [0e1b4cc]
- Updated dependencies [6b67833]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0
  - @nifrajs/web@1.9.0
  - @nifrajs/i18n@1.9.0
  - @nifrajs/image@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [e47c4c5]
- Updated dependencies [1ffd48b]
  - @nifrajs/core@1.8.0
  - @nifrajs/web@1.8.0
  - @nifrajs/i18n@1.8.0
  - @nifrajs/image@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [bd95181]
- Updated dependencies [9f23e90]
  - @nifrajs/core@1.7.0
  - @nifrajs/web@1.7.0
  - @nifrajs/i18n@1.7.0
  - @nifrajs/image@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/core@1.6.0
- @nifrajs/i18n@1.6.0
- @nifrajs/image@1.6.0
- @nifrajs/web@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0
  - @nifrajs/web@1.5.0
  - @nifrajs/i18n@1.5.0
  - @nifrajs/image@1.5.0

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0
  - @nifrajs/web@1.4.0
  - @nifrajs/i18n@1.4.0
  - @nifrajs/image@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/i18n@1.3.1
- @nifrajs/image@1.3.1
- @nifrajs/web@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/web@1.3.0
  - @nifrajs/i18n@1.3.0
  - @nifrajs/image@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/i18n@1.2.2
- @nifrajs/image@1.2.2
- @nifrajs/web@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c3ebd73]
  - @nifrajs/web@1.2.1
  - @nifrajs/i18n@1.2.1
  - @nifrajs/image@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/web@1.2.0
- @nifrajs/i18n@1.2.0
- @nifrajs/image@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [37d2383]
  - @nifrajs/web@1.1.0
  - @nifrajs/i18n@1.1.0
  - @nifrajs/image@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
  - @nifrajs/web@1.0.0
  - @nifrajs/i18n@1.0.0
  - @nifrajs/image@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/i18n@1.0.0-beta.4
- @nifrajs/image@1.0.0-beta.4
- @nifrajs/web@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/i18n@1.0.0-beta.3
- @nifrajs/image@1.0.0-beta.3
- @nifrajs/web@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [5018546]
  - @nifrajs/web@0.1.0-beta.2
  - @nifrajs/i18n@0.1.0-beta.2
  - @nifrajs/image@0.1.0-beta.2
