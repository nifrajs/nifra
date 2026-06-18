import type { ClientRouter, Fetcher, FetcherState } from "@nifrajs/web"
/**
 * `@nifrajs/web-solid/fetcher` — Solid bindings for concurrent fetchers. `createFetcher(key)` bridges an
 * independent {@link Fetcher}'s `subscribe`/`snapshot` store into a Solid signal (the pattern the F16
 * spike confirmed) and returns its reactive state accessor plus `load`/`submit`; `useFetchers()`
 * bridges the whole live collection. Imports only `solid-js` (never `solid-js/web`), so route
 * components can use it on the server *and* client without pulling server/build code into the wrong
 * bundle. No JSX (the package builds with plain `tsc`).
 *
 * The router that owns the fetchers registers itself via `setMountedRouter` from `mountRouter`. On the
 * server (no mount) the accessors return an idle state — fetchers are client-only — so SSR markup is
 * unchanged and the first client render after `mountRouter` takes over cleanly.
 */
import { type Accessor, createSignal, onCleanup } from "solid-js"

// The active client router (set by `mountRouter`). Module-scoped: one app per page, client-only.
let mountedRouter: ClientRouter | undefined

/** Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use. */
export function setMountedRouter(router: ClientRouter | undefined): void {
  mountedRouter = router
}

const IDLE: FetcherState = { pending: false, data: undefined }
const noopAsync = async (): Promise<void> => {}

/** A fetcher's reactive state accessor plus its imperative `load`/`submit`. */
export interface FetcherHandle {
  /** Reactive accessor for the fetcher's {@link FetcherState} (`pending`/`data`/`actionData`/...). */
  readonly state: Accessor<FetcherState>
  /** Load a route path's loader data into this fetcher (concurrent; doesn't touch the active view). */
  readonly load: (path: string) => Promise<void>
  /** Submit an action into this fetcher (concurrent); honors `X-Nifra-Revalidate`. */
  readonly submit: (action: string, body: NonNullable<RequestInit["body"]>) => Promise<void>
}

/**
 * Bind the independent fetcher for `key` (created lazily, stable). Returns a reactive `state()`
 * accessor + `load`/`submit`. Multiple `createFetcher` calls with different keys run concurrently
 * without disturbing the active route or each other. Call inside a component (owns the subscription).
 */
export function createFetcher(key: string): FetcherHandle {
  const fetcher = mountedRouter?.fetcher(key)
  const [state, setState] = createSignal<FetcherState>(fetcher ? fetcher.snapshot() : IDLE)
  if (fetcher !== undefined) {
    onCleanup(fetcher.subscribe(() => setState(fetcher.snapshot())))
    return { state, load: fetcher.load, submit: fetcher.submit }
  }
  return { state, load: noopAsync, submit: noopAsync }
}

/**
 * Bind the whole live fetcher collection — for a global busy view. Returns a reactive accessor; read
 * each entry's `.snapshot()` for its state. Updates whenever any fetcher transitions or one is created.
 */
export function useFetchers(): Accessor<readonly Fetcher[]> {
  const router = mountedRouter
  const [list, setList] = createSignal<readonly Fetcher[]>(router ? router.fetchers() : [])
  if (router !== undefined) {
    onCleanup(router.subscribeFetchers(() => setList(router.fetchers())))
  }
  return list
}
