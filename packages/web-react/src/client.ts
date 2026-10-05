import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
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
import { routeProps } from "./route-props.ts"

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
  const { router, routes, searchSchemas, matchChains, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  // What the server rendered. React hydrates against THIS, whatever the store says by the time it gets
  // to the component - hydration is scheduled, and a store that moved on first (a client loader that
  // answered, a held `ssr = false` page released) would otherwise hydrate a tree the markup never had.
  // React then re-renders with the live snapshot on its own.
  const hydrated = router.snapshot()
  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot, () => hydrated)
    return compose(routes[state.routeId] ?? [], routeProps(state, searchSchemas, matchChains))
  }
  const onRecoverableError = assuranceError()
  hydrateRoot(
    container as Element,
    createElement(Router),
    ...(onRecoverableError === undefined ? [] : [{ onRecoverableError }]),
  )
}
