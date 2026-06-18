import type { ClientRouter, Fetcher, FetcherState } from "@nifrajs/web"
/**
 * `@nifrajs/web-svelte/fetcher` — Svelte bindings for concurrent fetchers, as **Svelte stores** (plain
 * `.ts`, no runes/compiler needed). `useFetcher(key)` returns a `Readable<FetcherState>` augmented with
 * `load`/`submit` — read it reactively in a component with `$fetcher` (auto-subscription), call
 * `fetcher.load(...)` / `fetcher.submit(...)` imperatively. `useFetchers()` returns the live collection
 * as a store. The store's start/stop notifier subscribes to the agnostic store lazily (on the first
 * `$`-subscription) and unsubscribes on the last — so lifecycle is tied to the component automatically.
 *
 * The router that owns the fetchers is the one `mountRouter` hydrated — it registers itself here via
 * `setMountedRouter`. On the server (no mount) there is no router, so the stores hold an idle value
 * (fetchers are client-only); the first client render starts from the same idle snapshot — no mismatch.
 */
import { type Readable, readable } from "svelte/store"

// The active client router (set by `mountRouter`). Module-scoped: the browser mounts one app per
// page, and fetchers never exist on the server. Shared with `client.ts`'s `mountRouter`.
let mountedRouter: ClientRouter | undefined

/** Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use. */
export function setMountedRouter(router: ClientRouter | undefined): void {
  mountedRouter = router
}

const IDLE: FetcherState = { pending: false, data: undefined }
const noopAsync = async (): Promise<void> => {}

/** A fetcher store: a `Readable<FetcherState>` (read via `$`) plus imperative `load`/`submit`. */
export type FetcherStore = Readable<FetcherState> & {
  /** Load a route path's loader data into this fetcher (concurrent; doesn't touch the active view). */
  readonly load: (path: string) => Promise<void>
  /** Submit an action into this fetcher (concurrent); honors `X-Nifra-Revalidate`. */
  readonly submit: (action: string, body: NonNullable<RequestInit["body"]>) => Promise<void>
}

/**
 * Subscribe to the independent fetcher for `key` (created lazily, stable across renders). Returns a
 * store of its state (`pending`/`data`/`actionData`/`submission`) augmented with `load`/`submit`.
 * Multiple `useFetcher` calls with different keys run concurrently without disturbing the active route.
 */
export function useFetcher(key: string): FetcherStore {
  const fetcher = mountedRouter?.fetcher(key)
  const store = readable<FetcherState>(fetcher ? fetcher.snapshot() : IDLE, (set) => {
    if (fetcher === undefined) return
    set(fetcher.snapshot())
    return fetcher.subscribe(() => set(fetcher.snapshot()))
  })
  return Object.assign(store, {
    load: fetcher?.load ?? noopAsync,
    submit: fetcher?.submit ?? noopAsync,
  })
}

/**
 * Subscribe to the whole live fetcher collection — for a global busy view (e.g. "3 saving…"). Read
 * each entry's `.snapshot()` for its state. The store updates whenever any fetcher transitions or a
 * new one is created.
 */
export function useFetchers(): Readable<readonly Fetcher[]> {
  const router = mountedRouter
  return readable<readonly Fetcher[]>(router ? router.fetchers() : [], (set) => {
    if (router === undefined) return
    set(router.fetchers())
    return router.subscribeFetchers(() => set(router.fetchers()))
  })
}
