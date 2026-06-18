import type { ClientRouter, Fetcher, FetcherState } from "@nifrajs/web"
/**
 * `@nifrajs/web-preact/fetcher` — Preact bindings for concurrent fetchers. `useFetcher(key)` subscribes a
 * component to an independent {@link Fetcher} (via `useSyncExternalStore` from preact/compat) and
 * returns its reactive state plus `load`/`submit`; `useFetchers()` subscribes to the whole live
 * collection. Imports only `preact/compat` + `@nifrajs/web` types, so route components can use it on the
 * server *and* client. No JSX (the package builds with plain `tsc`).
 *
 * The router that owns the fetchers is the one `mountRouter` hydrated — it registers itself here via
 * `setMountedRouter`. On the server (no mount) there is no router, so the hooks return an idle state
 * (fetchers are client-only). Preact's compat `useSyncExternalStore` is 2-arg (no `getServerSnapshot`);
 * with no router the `getSnapshot` already returns idle, so the first client render after `mountRouter`
 * matches the SSR markup — no hydration mismatch.
 */
import { useSyncExternalStore } from "preact/compat"

// The active client router (set by `mountRouter`). Module-scoped: the browser mounts one app per
// page, and fetchers never exist on the server. Shared with `client.ts`'s `mountRouter`.
let mountedRouter: ClientRouter | undefined

/** Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use. */
export function setMountedRouter(router: ClientRouter | undefined): void {
  mountedRouter = router
}

// Stable idle values for the server / pre-mount snapshot (stable refs → no `useSyncExternalStore`
// loop, no hydration mismatch).
const IDLE: FetcherState = { pending: false, data: undefined }
const NO_FETCHERS: readonly Fetcher[] = []
const noopSubscribe = (): (() => void) => () => {}
const noopAsync = async (): Promise<void> => {}
const idleSnapshot = (): FetcherState => IDLE
const noFetchers = (): readonly Fetcher[] => NO_FETCHERS

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
  const fetcher = mountedRouter?.fetcher(key)
  const state = useSyncExternalStore(
    fetcher?.subscribe ?? noopSubscribe,
    fetcher?.snapshot ?? idleSnapshot,
  )
  return { ...state, load: fetcher?.load ?? noopAsync, submit: fetcher?.submit ?? noopAsync }
}

/**
 * Subscribe to the whole live fetcher collection — for a global busy view (e.g. "3 saving…"). Read
 * each entry's `.snapshot()` for its state. Re-renders whenever any fetcher transitions or a new one
 * is created.
 */
export function useFetchers(): readonly Fetcher[] {
  return useSyncExternalStore(
    mountedRouter?.subscribeFetchers ?? noopSubscribe,
    mountedRouter?.fetchers ?? noFetchers,
  )
}
