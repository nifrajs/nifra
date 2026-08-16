import type { ClientRouter, Fetcher, FetcherState } from "../router.ts"

/** Stable idle state shared by every framework fetcher binding. */
export const IDLE_FETCHER_STATE: FetcherState = Object.freeze({
  pending: false,
  data: undefined,
})

/** Stable empty collection used before a router is mounted. */
export const NO_FETCHERS: readonly Fetcher[] = Object.freeze([])

/** No-op subscription used by SSR and pre-mount snapshots. */
export const noopSubscribe = (): (() => void) => () => {}

/** No-op fetcher action used before a router is mounted. */
export const noopAsync = async (): Promise<void> => {}

/** Stable idle fetcher snapshot for external-store bindings. */
export const idleFetcherSnapshot = (): FetcherState => IDLE_FETCHER_STATE

/** Stable empty fetcher collection snapshot for external-store bindings. */
export const noFetchers = (): readonly Fetcher[] => NO_FETCHERS

/** Keep mounted-router state local to each adapter package. */
export function createMountedRouterRef(): {
  readonly get: () => ClientRouter | undefined
  readonly set: (router: ClientRouter | undefined) => void
} {
  let router: ClientRouter | undefined
  return {
    get: () => router,
    set: (next) => {
      router = next
    },
  }
}
