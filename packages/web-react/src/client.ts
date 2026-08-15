import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
// `/client`, not the root: the root's graph carries the server, and Vite's dev server evaluates it
// instead of tree-shaking it - which broke hydration before the browser ran a line of app code.
import { searchOfChain } from "@nifrajs/web/client"
/**
 * @nifrajs/web-react/client - React client runtime. `hydrate` hydrates a single SSR'd route;
 * `mountRouter` hydrates a stateful Router that subscribes to the agnostic store (via
 * `useSyncExternalStore`) and re-renders the matched chain on every client navigation (no full
 * reload). Kept in its own entry so server code stays out of the client bundle.
 */
import * as React from "react"
import { createElement, type FunctionComponent, useSyncExternalStore } from "react"
import { hydrateRoot } from "react-dom/client"
import { compose } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element - defined in its own (react-dom-free) module, re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-react/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/** Hydrate a server-rendered React layout `chain` (with the loader `props`) inside `container`. */
export interface HydrationAssuranceOptions {
  readonly onRecoverableError?: (error: unknown, info?: unknown) => void
}

function assuranceError(): HydrationAssuranceOptions["onRecoverableError"] {
  const value = (globalThis as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("nifra.hydration.assurance")
  ]
  if (typeof value !== "object" || value === null) return undefined
  const callback = (value as { onRecoverableError?: unknown }).onRecoverableError
  return typeof callback === "function"
    ? (callback as HydrationAssuranceOptions["onRecoverableError"])
    : undefined
}

export function hydrate(
  chain: readonly unknown[],
  props: RenderProps,
  container: unknown,
  options?: HydrationAssuranceOptions,
): void {
  const onRecoverableError = options?.onRecoverableError ?? assuranceError()
  if (onRecoverableError === undefined) hydrateRoot(container as Element, compose(chain, props))
  else hydrateRoot(container as Element, compose(chain, props), { onRecoverableError })
}

/** Testing hook used by verification runners to observe React's recoverable errors and identity. */
export const hydrationAssuranceHook = Object.freeze({
  framework: "react" as const,
  runtimeIdentity: (): object => React,
})

/**
 * Hydrate a stateful React Router. `useSyncExternalStore` subscribes to the agnostic store and
 * re-renders the matched layout chain on each store change - so client navigations swap routes
 * without a full reload. `getServerSnapshot` (3rd arg) returns the initial state, matching the
 * SSR markup on hydration.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, searchSchemas, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot, router.snapshot)
    // Derive this route's typed `search` from the URL query + the route's schema CHAIN (layout schemas +
    // page, merged page-wins), the SAME `searchOfChain` the server ran, so `useSearch` reads an identical
    // value and hydrates with no drift.
    const q = state.path.indexOf("?")
    const rawSearch = q === -1 ? "" : state.path.slice(q)
    return compose(routes[state.routeId] ?? [], {
      data: state.data,
      actionData: state.actionData,
      pending: state.pending,
      ...(state.pendingPath !== undefined ? { pendingPath: state.pendingPath } : {}),
      // `params`/`path` feed the routing hooks (useParams/useLocation) via compose's RouterContext -
      // sourced from router state here, matching the SSR render's request-derived values on hydration.
      params: state.params,
      path: state.path,
      search: searchOfChain(searchSchemas?.[state.routeId] ?? [], rawSearch),
      // The in-flight submission (for optimistic UI) - spread only when present.
      ...(state.submission ? { submission: state.submission } : {}),
      ...(state.boundaries !== undefined ? { boundaries: state.boundaries } : {}),
    })
  }
  const onRecoverableError = assuranceError()
  hydrateRoot(
    container as Element,
    createElement(Router),
    ...(onRecoverableError === undefined ? [] : [{ onRecoverableError }]),
  )
}
