import type { ClientRouter, Fetcher, FetcherState } from "@nifrajs/web"
import {
  createMountedRouterRef,
  IDLE_FETCHER_STATE,
  idleFetcherSnapshot,
  noFetchers,
  noopAsync,
  noopSubscribe,
} from "@nifrajs/web/internal/fetcher-runtime"
/**
 * `@nifrajs/web-react/fetcher` - React bindings for concurrent fetchers. `useFetcher(key)` subscribes a
 * component to an independent {@link Fetcher} (via `useSyncExternalStore`) and returns its reactive
 * state plus `load`/`submit`; `useFetchers()` subscribes to the whole live collection. Imports only
 * `react` (never `react-dom/*`), so route components can use it on the server *and* client without
 * dragging either DOM build into the wrong bundle. No JSX (the package builds with plain `tsc`).
 *
 * The router that owns the fetchers is the one `mountRouter` hydrated - it registers itself here via
 * `setMountedRouter`. On the server (no mount) there is no router, so the hooks return an idle state
 * (fetchers are client-only); the first client render after `mountRouter` sees the real fetcher, so
 * there's no hydration mismatch.
 */
import { useSyncExternalStore } from "react"

const mountedRouter = createMountedRouterRef()

/** Register (or clear) the router that owns fetchers - called by `mountRouter`. Not for app use. */
export function setMountedRouter(router: ClientRouter | undefined): void {
  mountedRouter.set(router)
}

// Stable idle values for the server / pre-mount snapshot (stable refs → no `useSyncExternalStore`
// loop, no hydration mismatch).

/** A fetcher's reactive {@link FetcherState} plus its imperative `load`/`submit`. */
export interface FetcherHandle extends FetcherState {
  /** Load a route path's loader data into this fetcher (concurrent; doesn't touch the active view). */
  readonly load: (path: string) => Promise<void>
  /** Submit an action into this fetcher (concurrent); honors `X-Nifra-Revalidate`. */
  readonly submit: (action: string, body: NonNullable<RequestInit["body"]>) => Promise<void>
}

/**
 * Subscribe to the independent fetcher for `key` (created lazily, stable across renders). Returns its
 * state (`pending`/`data`/`actionData`/`submission`) + `load`/`submit`. Multiple `useFetcher` calls
 * with different keys run concurrently without disturbing the active route or each other.
 */
export function useFetcher(key: string): FetcherHandle {
  const fetcher = mountedRouter.get()?.fetcher(key)
  const state = useSyncExternalStore(
    fetcher?.subscribe ?? noopSubscribe,
    fetcher?.snapshot ?? idleFetcherSnapshot,
    () => IDLE_FETCHER_STATE, // server: fetchers are client-only → idle (matches the first client render)
  )
  return { ...state, load: fetcher?.load ?? noopAsync, submit: fetcher?.submit ?? noopAsync }
}

/**
 * Subscribe to the whole live fetcher collection - for a global busy view (e.g. "3 saving…"). Read
 * each entry's `.snapshot()` for its state. Re-renders whenever any fetcher transitions or a new one
 * is created.
 */
export function useFetchers(): readonly Fetcher[] {
  const router = mountedRouter.get()
  return useSyncExternalStore(
    router?.subscribeFetchers ?? noopSubscribe,
    router?.fetchers ?? noFetchers,
    noFetchers,
  )
}
