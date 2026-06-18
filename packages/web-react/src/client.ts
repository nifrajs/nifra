import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-react/client — React client runtime. `hydrate` hydrates a single SSR'd route;
 * `mountRouter` hydrates a stateful Router that subscribes to the agnostic store (via
 * `useSyncExternalStore`) and re-renders the matched chain on every client navigation (no full
 * reload). Kept in its own entry so server code stays out of the client bundle.
 */
import { createElement, type FunctionComponent, useSyncExternalStore } from "react"
import { hydrateRoot } from "react-dom/client"
import { compose } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element — defined in its own (react-dom-free) module, re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-react/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/** Hydrate a server-rendered React layout `chain` (with the loader `props`) inside `container`. */
export function hydrate(chain: readonly unknown[], props: RenderProps, container: unknown): void {
  hydrateRoot(container as Element, compose(chain, props))
}

/**
 * Hydrate a stateful React Router. `useSyncExternalStore` subscribes to the agnostic store and
 * re-renders the matched layout chain on each store change — so client navigations swap routes
 * without a full reload. `getServerSnapshot` (3rd arg) returns the initial state, matching the
 * SSR markup on hydration.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot, router.snapshot)
    return compose(routes[state.routeId] ?? [], {
      data: state.data,
      actionData: state.actionData,
      pending: state.pending,
      // The in-flight submission (for optimistic UI) — spread only when present.
      ...(state.submission ? { submission: state.submission } : {}),
    })
  }
  hydrateRoot(container as Element, createElement(Router))
}
