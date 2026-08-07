# @nifrajs/web-svelte

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1
  - @nifrajs/web@2.9.1
  - @nifrajs/i18n@2.9.1
  - @nifrajs/image@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [e05e56d]
  - @nifrajs/core@2.9.0
  - @nifrajs/web@2.9.0
  - @nifrajs/i18n@2.9.0
  - @nifrajs/image@2.9.0

## 2.8.2

### Patch Changes

- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2
  - @nifrajs/image@2.8.2
  - @nifrajs/web@2.8.2
  - @nifrajs/i18n@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1
  - @nifrajs/web@2.8.1
  - @nifrajs/i18n@2.8.1
  - @nifrajs/image@2.8.1

## 2.8.0

### Patch Changes

- Updated dependencies [118e4a5]
  - @nifrajs/web@2.8.0
  - @nifrajs/core@2.8.0
  - @nifrajs/i18n@2.8.0
  - @nifrajs/image@2.8.0

## 2.7.1

### Patch Changes

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

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.
- Updated dependencies [e6349e5]
- Updated dependencies [08fe221]
- Updated dependencies [8383063]
  - @nifrajs/web@2.6.0
  - @nifrajs/core@2.6.0
  - @nifrajs/i18n@2.6.0
  - @nifrajs/image@2.6.0

## 2.5.0

### Patch Changes

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

- 2d9beaa: Preact, Vue, Solid and Svelte gain `useNavigate` and `useBlocker`, from `@nifrajs/web-<framework>/router`.

  `useNavigate` returns a programmatic navigate (a path pushes or replaces; a number is a history delta),
  matching the React adapter. `useBlocker` is the unsaved-changes guard - pass a boolean or a
  `({ currentLocation, nextLocation }) => boolean` predicate and get back a `{ state, proceed, reset }`
  value in each framework's own reactive shape (a Vue ref, a Solid accessor, a Svelte store, a plain value
  in Preact). When a navigation is intercepted, `state` becomes `"blocked"`; show your own confirmation and
  call `proceed()` or `reset()`. It also arms the native "Leave site?" prompt on tab close and reload.

  ```svelte
  <script>
    import { useBlocker } from "@nifrajs/web-svelte/router"
    let dirty = false
    const blocker = useBlocker(() => dirty)
  </script>

  {#if $blocker.state === "blocked"}
    <dialog open>
      <button on:click={$blocker.reset}>Keep editing</button>
      <button on:click={$blocker.proceed}>Discard</button>
    </dialog>
  {/if}
  ```

  In Vue, Solid and Svelte the hook is created once, so pass a function to track a changing flag
  (`useBlocker(() => dirty)`); a bare boolean is captured as-is. The guarding itself already ran on every
  adapter at the browser layer - this exposes it as a reactive hook.

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

- 4f8c0cc: `useServerFn`'s store reports the current state to a late subscriber.

  Svelte's `readable` runs its start function only on the FIRST subscription, and this one subscribed
  without priming - so a store read after a call had already finished reported its initial value, idle,
  for a call that succeeded. It hits a handle created at module scope, one shared through a Svelte
  context, and any component that mounts after the call.

  It now sets `store.snapshot()` before subscribing, matching `useFetcher` in this same package. The
  other four adapters already read a snapshot on mount, so this was the one place where "is it pending"
  gave a different answer from the shared state machine it exists to report.

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

- Updated dependencies [39b1670]
- Updated dependencies [d428f52]
- Updated dependencies [135d0c6]
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
  - @nifrajs/i18n@2.2.0
  - @nifrajs/image@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
  - @nifrajs/web@2.1.0
  - @nifrajs/i18n@2.1.0
  - @nifrajs/image@2.1.0

## 2.0.0

### Minor Changes

- 3620546: Extend `import Icon from "./icon.svg?component"` to the Solid, Svelte, and Vue adapters (`@nifrajs/web-solid/svg`, `@nifrajs/web-svelte/svg`, `@nifrajs/web-vue/svg`), joining the React/Preact plugin.

  Each is a Bun build plugin that turns a `?component` SVG import into a framework component with the caller's props/attrs spread onto the root `<svg>`, using that framework's own compiler: Solid emits `class`-form JSX through `babel-preset-solid`; Svelte wraps the raw SVG in a Svelte 5 component (compiled by `svelte/compiler`); Vue wraps it in a single-root template so Vue's attribute inheritance forwards props to the `<svg>` (compiled by `@vue/compiler-sfc`). A plain `import "./icon.svg"` asset URL is untouched - only `?component` is intercepted. The shared `svgToJsx` transform gained a `classProp` option.

### Patch Changes

- Updated dependencies [ade0c7a]
- Updated dependencies [d91a45b]
- Updated dependencies [d91a45b]
- Updated dependencies [e97a92f]
- Updated dependencies [e8e49d1]
- Updated dependencies [a7d34e5]
  - @nifrajs/web@2.0.0
  - @nifrajs/i18n@2.0.0
  - @nifrajs/image@2.0.0

## 1.13.0

### Patch Changes

- Updated dependencies [5b6127a]
  - @nifrajs/web@1.13.0
  - @nifrajs/i18n@1.13.0
  - @nifrajs/image@1.13.0

## 1.12.0

### Patch Changes

- @nifrajs/web@1.12.0
- @nifrajs/i18n@1.12.0
- @nifrajs/image@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [5638ada]
  - @nifrajs/web@1.11.0
  - @nifrajs/i18n@1.11.0
  - @nifrajs/image@1.11.0

## 1.10.0

### Patch Changes

- @nifrajs/web@1.10.0
- @nifrajs/i18n@1.10.0
- @nifrajs/image@1.10.0

## 1.9.1

### Patch Changes

- Updated dependencies [3eb27ae]
  - @nifrajs/web@1.9.1
  - @nifrajs/i18n@1.9.1
  - @nifrajs/image@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [0e1b4cc]
- Updated dependencies [6b67833]
  - @nifrajs/web@1.9.0
  - @nifrajs/i18n@1.9.0
  - @nifrajs/image@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [1ffd48b]
  - @nifrajs/web@1.8.0
  - @nifrajs/i18n@1.8.0
  - @nifrajs/image@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [9f23e90]
  - @nifrajs/web@1.7.0
  - @nifrajs/i18n@1.7.0
  - @nifrajs/image@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/i18n@1.6.0
- @nifrajs/image@1.6.0
- @nifrajs/web@1.6.0

## 1.5.0

### Patch Changes

- @nifrajs/web@1.5.0
- @nifrajs/i18n@1.5.0
- @nifrajs/image@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [4d25970]
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
