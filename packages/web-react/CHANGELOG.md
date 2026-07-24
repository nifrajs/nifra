# @nifrajs/web-react

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
    return { org: await findOrg(params.org) }    // params is { org } — nothing deeper
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

- 3eb27ae: Tidy the `@nifrajs/web-react/query` module documentation comment. Docs only — no API or behavior change.
- Updated dependencies [3eb27ae]
  - @nifrajs/web@1.9.1
  - @nifrajs/core@1.9.1
  - @nifrajs/i18n@1.9.1
  - @nifrajs/image@1.9.1

## 1.9.0

### Minor Changes

- 0e1b4cc: Add a full React Query core on `@nifrajs/web-react/query` — `useQuery` (now with `enabled`/`staleTime`),
  `useMutation`, `useInfiniteQuery`, `useQueryClient`, `QueryClientProvider`, and the SSR
  `HydrationBoundary` — a drop-in for the TanStack Query surface, backed by an expanded agnostic engine in
  `@nifrajs/web`.

  The engine (`createQueryClient`) gains imperative cache ops (`getQueryData`/`setQueryData` for optimistic
  updates, `prefetchQuery`), per-query `staleTime`, SSR `dehydrate`/`hydrate`, and paged (`infiniteQuery`)
  support; plus a standalone `createMutation` state machine (single-flight, TanStack callback order). All
  logic lives in the injected-clock, framework-free engine so it's deterministically tested; the React
  bindings are thin `useSyncExternalStore` wrappers. A hook without a `QueryClientProvider` uses a
  client-side singleton (SSR-idle); with a `HydrationBoundary`-fed provider client, queries render their
  server-seeded data during SSR with no hydration flash.

- 6b67833: Add first-class React routing bindings on the new `@nifrajs/web-react/router` subpath — `<Link>`,
  `<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>` — a
  drop-in replacement for `react-router-dom`'s routing surface over nifra's own file-based router.

  The read hooks are SSR-correct: `@nifrajs/web` now threads the matched route's `params` and the
  request `path` (`pathname + search`) through the render seam (`RenderProps`), and the React adapter's
  `compose` provides them via a `RouterContext` on both the server render and the client mount — so
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
