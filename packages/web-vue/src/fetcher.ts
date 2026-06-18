import type { ClientRouter, Fetcher, FetcherState } from "@nifrajs/web"
/**
 * `@nifrajs/web-vue/fetcher` — Vue bindings for concurrent fetchers. `useFetcher(key)` subscribes a
 * component to an independent {@link Fetcher} (a `shallowRef` fed by `fetcher.subscribe`, cleaned up via
 * `onScopeDispose`) and returns its reactive state plus `load`/`submit`; `useFetchers()` subscribes to
 * the whole live collection. Imports only `vue` + `@nifrajs/web` types.
 *
 * The router that owns the fetchers is the one `mountRouter` hydrated — it registers itself here via
 * `setMountedRouter`. On the server (no mount) there is no router, so the composables return an idle
 * state (fetchers are client-only); the first client render after `mountRouter` starts from the same
 * idle snapshot, so there's no hydration mismatch.
 */
import { onScopeDispose, type ShallowRef, shallowRef } from "vue"

// The active client router (set by `mountRouter`). Module-scoped: the browser mounts one app per
// page, and fetchers never exist on the server. Shared with `client.ts`'s `mountRouter`.
let mountedRouter: ClientRouter | undefined

/** Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use. */
export function setMountedRouter(router: ClientRouter | undefined): void {
  mountedRouter = router
}

const IDLE: FetcherState = { pending: false, data: undefined }
const NO_FETCHERS: readonly Fetcher[] = []
const noopAsync = async (): Promise<void> => {}

/** A fetcher's reactive {@link FetcherState} (read `.value`) plus its imperative `load`/`submit`. */
export interface FetcherHandle {
  readonly state: Readonly<ShallowRef<FetcherState>>
  /** Load a route path's loader data into this fetcher (concurrent; doesn't touch the active view). */
  readonly load: (path: string) => Promise<void>
  /** Submit an action into this fetcher (concurrent); honors `X-Nifra-Revalidate`. */
  readonly submit: (action: string, body: NonNullable<RequestInit["body"]>) => Promise<void>
}

/**
 * Subscribe to the independent fetcher for `key` (created lazily, stable across renders). Returns a
 * reactive `state` ref (`pending`/`data`/`actionData`/`submission`) + `load`/`submit`. Multiple
 * `useFetcher` calls with different keys run concurrently without disturbing the active route.
 */
export function useFetcher(key: string): FetcherHandle {
  const fetcher = mountedRouter?.fetcher(key)
  const state = shallowRef<FetcherState>(fetcher ? fetcher.snapshot() : IDLE)
  if (fetcher) {
    const unsubscribe = fetcher.subscribe(() => {
      state.value = fetcher.snapshot()
    })
    onScopeDispose(unsubscribe)
  }
  return { state, load: fetcher?.load ?? noopAsync, submit: fetcher?.submit ?? noopAsync }
}

/**
 * Subscribe to the whole live fetcher collection — for a global busy view (e.g. "3 saving…"). Read
 * each entry's `.snapshot()` for its state. The ref updates whenever any fetcher transitions or a new
 * one is created.
 */
export function useFetchers(): Readonly<ShallowRef<readonly Fetcher[]>> {
  const router = mountedRouter
  const state = shallowRef<readonly Fetcher[]>(router ? router.fetchers() : NO_FETCHERS)
  if (router) {
    const unsubscribe = router.subscribeFetchers(() => {
      state.value = router.fetchers()
    })
    onScopeDispose(unsubscribe)
  }
  return state
}
