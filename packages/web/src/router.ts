/**
 * The agnostic client-side router core — pure logic, no `window`, no framework. A per-adapter
 * Router binding subscribes via `subscribe`/`snapshot` and renders the matched chain; a
 * browser-only `installHistory` (history + link interception) wires on top. Kept DOM-free so it
 * unit-tests without a browser and is safe to import from the SSR core's main entry.
 */
import {
  compareRoutePatternSpecificity,
  compileRoutePattern,
  matchRoutePattern,
} from "@nifrajs/core/pattern"
import { parseNdjsonData } from "./deferred.ts"

/**
 * Request header that asks a nifra route's GET to return just the loader data as JSON (instead of
 * the full HTML document). Set by client-side navigation; read by `createWebApp`'s GET handler.
 */
export const DATA_HEADER = "x-nifra-data"

/**
 * Global the server injects (`createWebApp({ prerenderedPaths })`) listing the SSG-prerendered paths.
 * The client's default data fetch reads it: a soft-nav INTO a prerendered route fetches its static
 * `<path>/_data.json` (a CDN file — no worker round-trip) instead of the dynamic header-GET.
 */
export const PRERENDERED_GLOBAL = "__NIFRA_PRERENDERED__"

/**
 * Response header a data-mode action POST uses to convey a redirect (`redirect(...)`) to the
 * client — fetch would otherwise silently follow a 3xx to its HTML, losing the target. The
 * client reads this and performs a client-side navigation instead.
 */
export const REDIRECT_HEADER = "x-nifra-redirect"

/**
 * Response header an action sets (via the `revalidate(paths, data)` helper) to tell the client which
 * routes the mutation changed — a comma-separated list of paths. After the submit, the client marks
 * those cached routes stale (refetching any that are mounted) so a mutation can refresh views beyond
 * the active one. The client validates each path against the manifest matcher before acting on it.
 */
export const REVALIDATE_HEADER = "x-nifra-revalidate"

/** A URL matched against the manifest patterns: which route + its extracted params. */
export interface RouteMatch {
  readonly routeId: string
  readonly params: Record<string, string>
}

/** An in-flight client submit — the action it targets + the `FormData` being sent. Set while the
 * submit is pending, cleared when it settles. A component reads `submission.formData` to render an
 * **optimistic** view (the expected result) before the server responds. */
export interface Submission {
  readonly action: string
  readonly formData: FormData
}

/** The router's observable state. A new object is published on every transition. */
export interface RouterState {
  readonly routeId: string
  readonly params: Record<string, string>
  /** The current URL path (used to revalidate the active loader after an action). */
  readonly path: string
  readonly data: unknown
  /** An action's data return after a client-side submit (cleared on navigation). */
  readonly actionData?: unknown
  /** True while a navigation or submit is in flight (drives loading UI). */
  readonly pending: boolean
  /** The path a navigation is transitioning TO while `pending` (cleared when it settles). Lets a
   * `NavLink` know whether its own `to` is the one loading; `undefined` when idle. */
  readonly pendingPath?: string | undefined
  /** The in-flight submit (set during a `submit`, cleared when it settles) — for optimistic UI. */
  readonly submission?: Submission
}

/** A route id paired with its nifra pattern (e.g. `":id"` segments) — the matcher input. */
export interface RoutePattern {
  readonly routeId: string
  readonly pattern: string
}

/**
 * Build a matcher from route patterns (built from the SAME manifest the server routes from, so
 * client and server agree). Returns the first matching route + decoded params, or null. The
 * query string is ignored for matching (it is not part of the route pattern).
 */
export function createMatcher(
  patterns: readonly RoutePattern[],
): (path: string) => RouteMatch | null {
  const compiled = patterns
    .map((pattern) => ({ routeId: pattern.routeId, pattern: compileRoutePattern(pattern.pattern) }))
    .sort((left, right) => compareRoutePatternSpecificity(left.pattern, right.pattern))
  return (path) => {
    // Strip the query without allocating a `split("?")` array — matcher runs per match.
    const q = path.indexOf("?")
    const clean = q === -1 ? path : path.slice(0, q)
    for (const c of compiled) {
      const match = matchRoutePattern(c.pattern, clean)
      if (!match.matched) {
        if (match.reason === "malformed") return null
        continue
      }
      return { routeId: c.routeId, params: match.params }
    }
    return null
  }
}

/** How a router fetches a route's loader data on navigation. `signal` aborts a superseded fetch
 * (and its deferred stream). */
export type FetchRouteData = (
  path: string,
  match: RouteMatch,
  signal?: AbortSignal,
) => Promise<unknown>

/** Per-submit options. `revalidate: false` opts out of the post-action loader re-fetch. */
export interface SubmitOptions {
  /** Re-run the active route's loader after the action settles (default `true`). Set `false` to
   * keep the current `data` and rely on the action's `actionData` alone. */
  readonly revalidate?: boolean
}

/** A fetcher's observable state — independent of the main router. `pending` covers its in-flight
 * load/submit; `data` is its last `load()` result; `actionData` its last `submit()` result;
 * `submission` the in-flight submit (for optimistic UI). Client-only (never SSR'd). */
export interface FetcherState {
  readonly pending: boolean
  readonly data: unknown
  readonly actionData?: unknown
  readonly submission?: Submission
}

/**
 * An independent load/submit state machine, retrieved by `router.fetcher(key)`. Runs **concurrently**
 * with the main router and with other fetchers — each is single-flight against *itself* (its own
 * monotonic token), so N row-level mutations / side-channel loads can be in flight at once without
 * disturbing the active view. Loads/submits write the shared cache and honor `X-Nifra-Revalidate`.
 */
export interface Fetcher {
  /** Current state; stable reference between transitions. */
  snapshot: () => FetcherState
  /** Subscribe to this fetcher's transitions; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void
  /** Load a route path's loader data into this fetcher's own `data` (also writes the shared cache).
   * A no-op for an unmatched path. */
  load: (path: string) => Promise<void>
  /** Submit an action into this fetcher's own state; honors `X-Nifra-Revalidate` by refreshing the
   * active route + any mounted fetcher showing a changed path. Rejects on failure (caller falls back).
   * (No `revalidate` opt-out — a fetcher has no active loader of its own to skip.) */
  submit: (action: string, body: NonNullable<RequestInit["body"]>) => Promise<void>
}

/** The agnostic router store consumed by per-adapter Router bindings. */
export interface ClientRouter {
  /** Current state; stable reference between transitions (so `useSyncExternalStore` can bail). */
  snapshot: () => RouterState
  /** Subscribe to transitions; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void
  /** Navigate to a path: match → fetch loader data → publish. No-op for an unmatched path. */
  navigate: (path: string) => Promise<void>
  /**
   * Submit an action (POST `body` to `action` in data mode): a redirect becomes a client
   * navigation; otherwise the data return is published as `actionData` and the active route's
   * loader is revalidated so the mutation is reflected. Pass `{ revalidate: false }` to SKIP that
   * revalidation — keep the current `data` and just publish the action's `actionData` (useful when
   * the action already returned everything that changed, saving the extra round-trip). A redirect
   * always loads its target regardless. Rejects on failure (caller falls back).
   */
  submit: (
    action: string,
    body: NonNullable<RequestInit["body"]>,
    opts?: SubmitOptions,
  ) => Promise<void>
  /**
   * Mark cached route data stale and refresh the active view. With `paths`, target exactly those
   * (e.g. the routes a mutation changed); without, invalidate the whole cache. The active route
   * refreshes immediately — refetched + republished — whenever it's in scope (an explicit list that
   * includes it, or an invalidate-all); other stale entries refetch lazily when next read (a
   * fetcher, or the next navigation/access). Rejects if the active refetch fails (like `navigate`).
   * The keyed substrate for targeted revalidation (the `X-Nifra-Revalidate` header) and fetchers.
   */
  invalidate: (paths?: readonly string[]) => Promise<void>
  /**
   * Warm a path's chunk + loader data into a bounded one-shot cache without publishing state —
   * a later `navigate` to it transitions with no network round-trip. Best-effort: failures and
   * unmatched paths are no-ops. Wired to link hover/focus by `installHistory`.
   */
  prefetch: (path: string) => Promise<void>
  /**
   * Get (lazily creating) the stable {@link Fetcher} for `key` — an independent, concurrent
   * load/submit state machine for row-level mutations or side-channel loads that must not disturb
   * the active view. The same `key` always returns the same fetcher (so a binding can subscribe to a
   * stable store). Keys are app-chosen and typically stable (e.g. a row id).
   */
  fetcher: (key: string) => Fetcher
  /** All live fetchers — for a global busy view (e.g. a `useFetchers` binding). */
  fetchers: () => readonly Fetcher[]
  /** Subscribe to any-fetcher-changed (a transition on any fetcher, or a new one created) — backs a
   * `useFetchers` binding; returns an unsubscribe fn. */
  subscribeFetchers: (listener: () => void) => () => void
  /** Match a path against the manifest patterns (exposed for history/link wiring). */
  match: (path: string) => RouteMatch | null
}

export interface ClientRouterOptions {
  readonly patterns: readonly RoutePattern[]
  readonly initial: RouterState
  /** Override the loader-data fetch (tests inject a stub; defaults to a same-origin JSON GET). */
  readonly fetchData?: FetchRouteData
  /** Ensure a route's code chunk is loaded before rendering (code-splitting). Awaited in parallel
   * with the loader data, so `pending` covers both. Omit when the bundle isn't split. */
  readonly loadModule?: (routeId: string) => Promise<void>
}

/** Options for a per-adapter `mountRouter` (the Router binding that hydrates + re-renders). */
export interface MountRouterOptions {
  readonly router: ClientRouter
  /** routeId → layout chain (outermost layout → page); built by `generateClientEntry`. */
  readonly routes: Record<string, readonly unknown[]>
  /** Hydration container (opaque — the adapter casts it to its DOM element type). */
  readonly container: unknown
}

/** Read a nifra data response: a deferred loader/action streams NDJSON (parse line 1 + settle
 * `<Await>` markers as resolution lines arrive); a non-deferred one returns a single JSON. Shared by
 * navigation fetches and action submits — both transports are identical. */
const readResponseData = (res: Response, signal?: AbortSignal): Promise<unknown> =>
  (res.headers.get("content-type") ?? "").includes("application/x-ndjson") && res.body !== null
    ? parseNdjsonData(res.body, signal)
    : res.json()

// The static `_data.json` URL for a prerendered path: `/` → `/_data.json`, `/users/7` →
// `/users/7/_data.json` (mirrors the build's `dataFileFor`).
const dataUrlFor = (pathname: string): string =>
  pathname === "/" ? "/_data.json" : `${pathname.replace(/\/+$/, "")}/_data.json`

const defaultFetchData: FetchRouteData = async (path, _match, signal) => {
  // SSG fast path: if this path was prerendered, its loader data is a static file — fetch that (no
  // worker). Falls through to the dynamic header-GET on any miss (file absent, e.g. a deferred route,
  // or a stale set), so it's always safe. Non-SSG apps have no global → the dynamic path, unchanged.
  const prerendered = (globalThis as { [PRERENDERED_GLOBAL]?: unknown })[PRERENDERED_GLOBAL]
  if (Array.isArray(prerendered)) {
    const pathname = path.replace(/[?#].*$/, "")
    if (prerendered.includes(pathname)) {
      const staticRes = await fetch(dataUrlFor(pathname), { signal: signal ?? null })
      if (staticRes.ok) return readResponseData(staticRes, signal)
    }
  }
  const res = await fetch(path, { headers: { [DATA_HEADER]: "1" }, signal: signal ?? null })
  if (!res.ok) throw new Error(`[nifra/web] navigation data fetch failed (${res.status}): ${path}`)
  return readResponseData(res, signal)
}

/**
 * Create the agnostic router store. `navigate` is guarded by a monotonic token so that when
 * navigations overlap, only the latest result is applied (rapid clicks don't flash stale data).
 * A failed fetch clears `pending` and rethrows so the caller can fall back to a full-page load.
 */
export function createClientRouter(options: ClientRouterOptions): ClientRouter {
  const match = createMatcher(options.patterns)
  const fetchData = options.fetchData ?? defaultFetchData
  const loadModule = options.loadModule
  let state = options.initial
  const listeners = new Set<() => void>()
  let token = 0
  // Snapshot listeners to defend against accidental un/subscribe during notification. The adapters
  // don't do this (un/subscribe runs in effect/cleanup ticks), so the overhead is negligible
  // (5-20 listeners typically), and the defensiveness is valuable.
  const emit = (): void => {
    if (listeners.size === 0) return
    for (const listener of [...listeners]) listener()
  }
  // Bounded one-shot prefetch cache (path → loader data) + an in-flight guard so hover spam
  // doesn't double-fetch. Consumed (and dropped) by the next navigate to that path.
  const MAX_PREFETCH = 10
  const prefetched = new Map<string, unknown>()
  const inflight = new Set<string>()
  // Keyed data cache (path → latest loader data + freshness). Written on every published data
  // (navigate/submit), read by `invalidate` (+ targeted revalidation and fetchers in later F16
  // increments). Bounded — evict the oldest-inserted past the cap (route data is small; this just
  // caps memory). `status` is the staleness ledger: `invalidate` flips entries to `stale`; readers
  // refetch stale ones. Client-only — never serialized/hydrated.
  const MAX_CACHE = 50
  const cache = new Map<string, { data: unknown; status: "fresh" | "stale" }>()
  const cachePut = (path: string, data: unknown): void => {
    if (!cache.has(path) && cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(path, { data, status: "fresh" })
  }
  // Flip cached entries to stale (a no-op for paths not in the cache). Shared by `invalidate` and the
  // `X-Nifra-Revalidate` handling in `submit`.
  const markStale = (paths: readonly string[]): void => {
    for (const p of paths) {
      const entry = cache.get(p)
      if (entry !== undefined) cache.set(p, { data: entry.data, status: "stale" })
    }
  }
  // Parse the `X-Nifra-Revalidate` response header into validated paths. The header is response data
  // (a trust boundary), so each path must match a real manifest pattern — unknown/garbage is dropped
  // and never triggers a fetch.
  const parseRevalidate = (header: string | null): string[] =>
    header === null
      ? []
      : header
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && match(s) !== null)
  // Aborts the in-flight navigation's fetch + deferred stream when a newer navigation supersedes it
  // (so a superseded route's NDJSON stream stops reading instead of draining in the background).
  let navAbort: AbortController | undefined

  // Refetch the active route + republish, single-flight via the shared `token`. Shared by `invalidate`
  // and targeted revalidation. Rejects if the fetch fails (clearing its own `pending` first).
  const refetchActive = async (): Promise<void> => {
    const mine = ++token
    navAbort?.abort()
    const ac = new AbortController()
    navAbort = ac
    state = { ...state, pending: true }
    emit()
    try {
      const data = await fetchData(
        state.path,
        { routeId: state.routeId, params: state.params },
        ac.signal,
      )
      if (mine !== token) return // superseded — drop the stale result
      cachePut(state.path, data)
      state = { ...state, data, pending: false }
      emit()
    } catch (err) {
      if (mine === token) {
        state = { ...state, pending: false }
        emit()
      }
      throw err
    }
  }

  // --- Concurrent fetchers (F16.3) ---------------------------------------------------------------
  // Lazily-created stable fetchers, keyed by an app-chosen string. `fetcherListeners` lets a
  // `useFetchers` binding re-render when ANY fetcher changes or a new one is created.
  type FetcherEntry = {
    fetcher: Fetcher
    refreshIfShowing: (paths: readonly string[]) => Promise<void>
  }
  const fetchers = new Map<string, FetcherEntry>()
  const fetcherListeners = new Set<() => void>()
  // Cached list of live fetchers, rebuilt (new array ref) on every fetcher change/creation. A stable
  // ref between changes is what lets a `useFetchers` binding read it via `useSyncExternalStore`
  // without looping; a fresh ref on each change is what makes it re-render.
  let fetchersArr: readonly Fetcher[] = []
  const emitFetchers = (): void => {
    fetchersArr = [...fetchers.values()].map((e) => e.fetcher) // snapshot ref (intentional)
    if (fetcherListeners.size === 0) return
    for (const l of [...fetcherListeners]) l() // snapshot for defensiveness
  }

  // Best-effort refresh of every MOUNTED reader of `paths`: the active route (unless `skipActive`,
  // when the caller already refetched it) + any fetcher that loaded one of these paths. Errors are
  // swallowed — a failed targeted refresh must not fail the mutation that triggered it.
  const refreshMounted = async (paths: readonly string[], skipActive: boolean): Promise<void> => {
    const jobs: Promise<void>[] = []
    if (!skipActive && paths.includes(state.path)) jobs.push(refetchActive().catch(() => {}))
    for (const entry of fetchers.values()) jobs.push(entry.refreshIfShowing(paths))
    await Promise.all(jobs)
  }

  const createFetcher = (): FetcherEntry => {
    let fState: FetcherState = { pending: false, data: undefined }
    let fToken = 0
    let fAbort: AbortController | undefined
    let loadedPath: string | undefined
    const fListeners = new Set<() => void>()
    const fEmit = (): void => {
      if (fListeners.size > 0) for (const l of [...fListeners]) l() // snapshot for defensiveness
      emitFetchers()
    }
    const runLoad = async (path: string): Promise<void> => {
      const matched = match(path)
      if (matched === null) return // unmatched path → no-op
      const mine = ++fToken
      fAbort?.abort()
      const ac = new AbortController()
      fAbort = ac
      fState = { ...fState, pending: true }
      fEmit()
      try {
        const [, data] = await Promise.all([
          loadModule?.(matched.routeId),
          fetchData(path, matched, ac.signal),
        ])
        if (mine !== fToken) return // a newer load/submit on THIS fetcher superseded us
        // Record the loaded path only on SUCCESS — a thrown or superseded load must not
        // leave `loadedPath` pointing at a path this fetcher never actually showed, or a later
        // `X-Nifra-Revalidate` for it would spuriously refetch onto unexpected data.
        loadedPath = path
        cachePut(path, data)
        fState = { ...fState, data, pending: false }
        fEmit()
      } catch (err) {
        if (mine === fToken) {
          fState = { ...fState, pending: false }
          fEmit()
        }
        throw err
      }
    }
    const fetcher: Fetcher = {
      snapshot: () => fState,
      subscribe: (l) => {
        fListeners.add(l)
        return () => {
          fListeners.delete(l)
        }
      },
      load: runLoad,
      submit: async (action, body) => {
        const mine = ++fToken
        // Abort any prior in-flight load/submit on THIS fetcher (its fetch + NDJSON drain) — like
        // `runLoad` does for a superseding load. The mutation POST is left to complete; the
        // signal cancels the follow-up data drain if a newer op supersedes this one.
        fAbort?.abort()
        const ac = new AbortController()
        fAbort = ac
        // Expose the in-flight submission (FormData) for optimistic UI; a new submit supersedes any
        // prior actionData (dropped here, set again on success).
        fState = {
          pending: true,
          data: fState.data,
          ...(body instanceof FormData ? { submission: { action, formData: body } } : {}),
        }
        fEmit()
        try {
          const res = await fetch(action, { method: "POST", body, headers: { [DATA_HEADER]: "1" } })
          if (!res.ok)
            throw new Error(`[nifra/web] fetcher action failed (${res.status}): ${action}`)
          const actionData = res.status === 204 ? undefined : await readResponseData(res, ac.signal)
          const changed = parseRevalidate(res.headers.get(REVALIDATE_HEADER))
          if (mine !== fToken) return
          // Publish the fetcher's actionData; clear `submission` (the optimistic window is over).
          fState = { pending: false, data: fState.data, actionData }
          fEmit()
          // A fetcher has no loader of its own — its mutation's freshness flows through the cache:
          // mark the changed routes stale + refresh every mounted reader (active route + fetchers).
          if (changed.length > 0) {
            markStale(changed)
            await refreshMounted(changed, false)
          }
        } catch (err) {
          if (mine === fToken) {
            fState = { pending: false, data: fState.data }
            fEmit()
          }
          throw err
        }
      },
    }
    return {
      fetcher,
      refreshIfShowing: async (paths) => {
        // Best-effort: a failed targeted refresh of a fetcher must not reject the triggering flow.
        if (loadedPath !== undefined && paths.includes(loadedPath))
          await runLoad(loadedPath).catch(() => {})
      },
    }
  }

  return {
    match,
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    navigate: async (path) => {
      const matched = match(path)
      if (matched === null) return
      const mine = ++token
      navAbort?.abort() // abandon any in-flight navigation's stream
      const ac = new AbortController()
      navAbort = ac
      state = { ...state, pending: true, pendingPath: path }
      emit()
      try {
        // Use prefetched data when present (one-shot — drop it); else fetch. The chunk is loaded
        // either way (cached + instant after a prefetch), so pending covers both.
        const hit = prefetched.has(path)
        const dataPromise = hit
          ? Promise.resolve(prefetched.get(path))
          : fetchData(path, matched, ac.signal)
        if (hit) prefetched.delete(path)
        const [, data] = await Promise.all([loadModule?.(matched.routeId), dataPromise])
        if (mine !== token) return // a newer navigation superseded this one — drop the stale result
        cachePut(path, data) // keep the keyed cache coherent with what we publish
        state = {
          routeId: matched.routeId,
          params: matched.params,
          path,
          data,
          actionData: undefined, // a fresh navigation has no action result
          pending: false,
        }
        emit()
      } catch (err) {
        // Clear our pending flag + target (only if still current) and rethrow — the caller decides how
        // to recover (the history layer falls back to a full-page navigation).
        if (mine === token) {
          state = { ...state, pending: false, pendingPath: undefined }
          emit()
        }
        throw err
      }
    },
    submit: async (action, body, opts) => {
      const mine = ++token
      // A superseding navigation/submit aborts this submit's FOLLOW-UP reads (revalidation / redirect
      // fetch + their NDJSON drains) — not the mutation POST itself, which should complete.
      // Wire into `navAbort` like `navigate`/`refetchActive`, so a later nav cancels the in-flight read.
      navAbort?.abort()
      const ac = new AbortController()
      navAbort = ac
      // Expose the in-flight submission (when it's FormData) so components can render an optimistic
      // view from it while pending; cleared when the submit settles below.
      state = {
        ...state,
        pending: true,
        ...(body instanceof FormData ? { submission: { action, formData: body } } : {}),
      }
      emit()
      try {
        const res = await fetch(action, { method: "POST", body, headers: { [DATA_HEADER]: "1" } })
        if (!res.ok) throw new Error(`[nifra/web] action failed (${res.status}): ${action}`)
        const redirectTo = res.headers.get(REDIRECT_HEADER)
        if (redirectTo !== null) {
          // The action redirected (Post/Redirect/Get) — treat it as a client navigation.
          const target = match(redirectTo)
          if (target === null)
            throw new Error(`[nifra/web] action redirect off-route: ${redirectTo}`)
          const [, data] = await Promise.all([
            loadModule?.(target.routeId),
            fetchData(redirectTo, target, ac.signal),
          ])
          if (mine !== token) return
          cachePut(redirectTo, data)
          state = {
            routeId: target.routeId,
            params: target.params,
            path: redirectTo,
            data,
            actionData: undefined,
            pending: false,
          }
          emit()
          return
        }
        // The action's data — streamed NDJSON if it `defer()`'d slow parts (markers settle as lines
        // arrive, for `<Await actionData>`), else one JSON. Abortable so a superseding nav cancels the
        // drain.
        const actionData = res.status === 204 ? undefined : await readResponseData(res, ac.signal)
        // Routes the action declared changed (via the `revalidate()` helper → `X-Nifra-Revalidate`),
        // validated against the manifest.
        const changed = parseRevalidate(res.headers.get(REVALIDATE_HEADER))
        // Revalidate the active route's loader so the mutation is reflected — unless the caller opted
        // out (`revalidate: false`). A server-declared revalidate of the active path overrides the
        // opt-out (the server says it changed, so stale data would be wrong). Default is to revalidate.
        const skipActive = opts?.revalidate === false && !changed.includes(state.path)
        const data = skipActive
          ? state.data
          : await fetchData(state.path, { routeId: state.routeId, params: state.params }, ac.signal)
        if (mine !== token) return
        cachePut(state.path, data) // the revalidated (or kept) data is now the cache's truth
        // Mark the OTHER changed routes stale so the next access refetches.
        markStale(changed.filter((p) => p !== state.path))
        // Reconcile: publish the revalidated data + actionData; omit `submission` (the optimistic
        // window is over — the real data now drives the view).
        state = {
          routeId: state.routeId,
          params: state.params,
          path: state.path,
          data,
          actionData,
          pending: false,
        }
        emit()
        // Refresh any mounted fetcher showing one of the changed routes (the active route was just
        // revalidated inline above, so skip it here). Best-effort — never rejects the submit.
        await refreshMounted(changed, true)
      } catch (err) {
        if (mine === token) {
          // Revert: clear `submission` (the optimistic view vanishes) leaving `data` untouched, so the
          // pre-submit data shows through.
          state = {
            routeId: state.routeId,
            params: state.params,
            path: state.path,
            data: state.data,
            actionData: state.actionData,
            pending: false,
          }
          emit()
        }
        throw err
      }
    },
    invalidate: async (paths) => {
      // Mark targeted cache entries stale (all entries when no `paths`) — unmounted ones refetch
      // lazily on next access.
      const targets = paths ?? [...cache.keys()]
      markStale(targets)
      // Refresh mounted readers now: the active route (when in scope — an explicit list including it,
      // or an invalidate-all) + any fetcher showing a targeted path. The active refetch rejects on
      // failure (the caller asked to refresh); fetcher refreshes are best-effort (swallowed).
      const jobs: Promise<void>[] = []
      if (paths === undefined || paths.includes(state.path)) jobs.push(refetchActive())
      for (const entry of fetchers.values()) jobs.push(entry.refreshIfShowing(targets))
      await Promise.all(jobs)
    },
    prefetch: async (path) => {
      if (prefetched.has(path) || inflight.has(path)) return
      const matched = match(path)
      if (matched === null) return
      inflight.add(path)
      try {
        const [, data] = await Promise.all([
          loadModule?.(matched.routeId),
          fetchData(path, matched),
        ])
        if (prefetched.size >= MAX_PREFETCH) {
          const oldest = prefetched.keys().next().value
          if (oldest !== undefined) prefetched.delete(oldest)
        }
        prefetched.set(path, data)
      } catch {
        // Best-effort: a failed prefetch just means the eventual navigate fetches normally.
      } finally {
        inflight.delete(path)
      }
    },
    fetcher: (key) => {
      const existing = fetchers.get(key)
      if (existing !== undefined) return existing.fetcher
      const entry = createFetcher()
      fetchers.set(key, entry)
      emitFetchers() // a new fetcher appeared — wake any `useFetchers` subscriber
      return entry.fetcher
    },
    fetchers: () => fetchersArr,
    subscribeFetchers: (listener) => {
      fetcherListeners.add(listener)
      return () => {
        fetcherListeners.delete(listener)
      }
    },
  }
}
