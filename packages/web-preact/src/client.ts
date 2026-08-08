import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
// `/client`, not the root: the root's graph carries the server, and Vite's dev server evaluates it
// instead of tree-shaking it - which broke hydration before the browser ran a line of app code.
import { searchOfChain } from "@nifrajs/web/client"
/**
 * @nifrajs/web-preact/client - Preact client runtime. `hydrate` hydrates a single SSR'd route;
 * `mountRouter` hydrates a stateful Router that subscribes to the agnostic store (via
 * `useSyncExternalStore` from preact/compat) and re-renders the matched chain on every client
 * navigation (no full reload). Kept in its own entry so server code (preact-render-to-string) stays
 * out of the client bundle.
 */
import { type FunctionComponent, h, hydrate as preactHydrate } from "preact"
import { useSyncExternalStore } from "preact/compat"
import { compose } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element - defined in its own (DOM-free) module, re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-preact/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/**
 * Preact cannot apply Bun's hot updates, so the generated client entry reloads instead.
 *
 * Bun's dev server runs React Fast Refresh over JSX modules. A Preact component compiles to JSX that
 * looks the same, so the update is ACCEPTED - and then dropped, because Preact's refresh runtime
 * (prefresh) is not the one Bun installs. Measured: `bun:beforeUpdate` and `bun:afterUpdate` both fire,
 * the server logs the rebuild, the browser keeps rendering the old component and never reloads. The
 * edit simply appears not to happen.
 *
 * Reloading loses component state, which React keeps here. That is the honest trade until Bun's dev
 * server can install prefresh: a visible reload beats an edit that silently does nothing.
 */
export const hotUpdateNeedsReload = true

/** Hydrate a server-rendered Preact layout `chain` (with the loader `props`) inside `container`. */
export function hydrate(chain: readonly unknown[], props: RenderProps, container: unknown): void {
  preactHydrate(compose(chain, props), container as Element)
}

/**
 * Hydrate a stateful Preact Router. `useSyncExternalStore` (preact/compat) subscribes to the
 * agnostic store and re-renders the matched layout chain on each store change - so client
 * navigations swap routes without a full reload. Preact's compat `useSyncExternalStore` is 2-arg
 * (no `getServerSnapshot`); `router.snapshot` is deterministic, so hydration matches the SSR markup.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot)
    // Derive this route's typed `search` from the URL + the route's schema chain (the SAME `searchOfChain`
    // the server ran), so `useSearch` reads an identical value and hydrates with no drift.
    const q = state.path.indexOf("?")
    const rawSearch = q === -1 ? "" : state.path.slice(q)
    return compose(routes[state.routeId] ?? [], {
      data: state.data,
      actionData: state.actionData,
      pending: state.pending,
      search: searchOfChain(searchSchemas?.[state.routeId] ?? [], rawSearch),
      // The in-flight submission (for optimistic UI) - spread only when present.
      ...(state.submission ? { submission: state.submission } : {}),
    })
  }
  preactHydrate(h(Router, null), container as Element)
}
