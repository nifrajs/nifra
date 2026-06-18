import type { MountRouterOptions, RenderProps } from "@nifrajs/web"
/**
 * @nifrajs/web-preact/client — Preact client runtime. `hydrate` hydrates a single SSR'd route;
 * `mountRouter` hydrates a stateful Router that subscribes to the agnostic store (via
 * `useSyncExternalStore` from preact/compat) and re-renders the matched chain on every client
 * navigation (no full reload). Kept in its own entry so server code (preact-render-to-string) stays
 * out of the client bundle.
 */
import { type FunctionComponent, h, hydrate as preactHydrate } from "preact"
import { useSyncExternalStore } from "preact/compat"
import { compose } from "./compose.ts"
import { setMountedRouter } from "./fetcher.ts"

// The `_error` boundary chain element — defined in its own (DOM-free) module, re-exported here so
// nifra's client codegen resolves it from `@nifrajs/web-preact/client` alongside `mountRouter`.
export { errorBoundary } from "./error.ts"

/** Hydrate a server-rendered Preact layout `chain` (with the loader `props`) inside `container`. */
export function hydrate(chain: readonly unknown[], props: RenderProps, container: unknown): void {
  preactHydrate(compose(chain, props), container as Element)
}

/**
 * Hydrate a stateful Preact Router. `useSyncExternalStore` (preact/compat) subscribes to the
 * agnostic store and re-renders the matched layout chain on each store change — so client
 * navigations swap routes without a full reload. Preact's compat `useSyncExternalStore` is 2-arg
 * (no `getServerSnapshot`); `router.snapshot` is deterministic, so hydration matches the SSR markup.
 */
export function mountRouter(options: MountRouterOptions): void {
  const { router, routes, container } = options
  setMountedRouter(router) // expose it to useFetcher/useFetchers (same page, client-only)
  const Router: FunctionComponent = () => {
    const state = useSyncExternalStore(router.subscribe, router.snapshot)
    return compose(routes[state.routeId] ?? [], {
      data: state.data,
      actionData: state.actionData,
      pending: state.pending,
      // The in-flight submission (for optimistic UI) — spread only when present.
      ...(state.submission ? { submission: state.submission } : {}),
    })
  }
  preactHydrate(h(Router, null), container as Element)
}
