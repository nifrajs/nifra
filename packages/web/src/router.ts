/**
 * The agnostic client-side router core - pure logic, no `window`, no framework. A per-adapter
 * Router binding subscribes via `subscribe`/`snapshot` and renders the matched chain; a
 * browser-only `installHistory` (history + link interception) wires on top. Kept DOM-free so it
 * unit-tests without a browser and is safe to import from the SSR core's main entry.
 */
import { decodeRouteParams } from "@nifrajs/core/pattern"
import { Router as CoreRouter } from "@nifrajs/core/router"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import type { BoundaryStates } from "./boundary.ts"
import { parseNdjsonData } from "./deferred.ts"
import type { ClientActionResult, ClientRequestBody, ClientRouteHooks } from "./manifest.ts"
import { isClientOnlySearchChange } from "./search.ts"

/**
 * Request header that asks a nifra route's GET to return just the loader data as JSON (instead of
 * the full HTML document). Set by client-side navigation; read by `createWebApp`'s GET handler.
 */
export const DATA_HEADER = "x-nifra-data"

/**
 * Global the server injects (`createWebApp({ prerenderedPaths })`) listing the SSG-prerendered paths.
 * The client's default data fetch reads it: a soft-nav INTO a prerendered route fetches its static
 * `<path>/_data.json` (a CDN file - no worker round-trip) instead of the dynamic header-GET.
 */
export const PRERENDERED_GLOBAL = "__NIFRA_PRERENDERED__"

/**
 * Response header a data-mode action POST uses to convey a redirect (`redirect(...)`) to the
 * client - fetch would otherwise silently follow a 3xx to its HTML, losing the target. The
 * client reads this and performs a client-side navigation instead.
 */
export const REDIRECT_HEADER = "x-nifra-redirect"

/**
 * Response header an action sets (via the `revalidate(paths, data)` helper) to tell the client which
 * routes the mutation changed - a comma-separated list of paths. After the submit, the client marks
 * those cached routes stale (refetching any that are mounted) so a mutation can refresh views beyond
 * the active one. The client validates each path against the manifest matcher before acting on it.
 */
export const REVALIDATE_HEADER = "x-nifra-revalidate"

/**
 * Response header carrying a **terminal status** a loader signalled with `notFound()` / `gone()` /
 * `statusPage(n)` during a client-side navigation's data fetch.
 *
 * A soft-nav fetches data, not a document, so the server cannot answer by rendering the `_404` page -
 * it has only JSON to return. Without this channel the two halves disagree: a crawler doing a hard
 * navigation gets a correct 404 page while a user who clicked a link gets an error or a blank screen.
 * The client reads it and renders the same boundary the server would have.
 *
 * Carried in a header rather than the body so it survives the NDJSON deferred-data path unchanged,
 * exactly like {@link REDIRECT_HEADER}.
 */
export const STATUS_HEADER = "x-nifra-status"

/**
 * Layout indices a client navigation is asking the server NOT to re-run, comma separated.
 *
 * The client owns the decision because it holds both the old and new match plus each layout's scoped
 * params. The server treats it as a hint and refuses to skip a `gate` regardless - a guard that runs
 * only when the client says so is not a guard.
 */
export const RETAIN_HEADER = "x-nifra-retain"

/**
 * The path a client navigation is coming FROM, sent on the data-mode GET.
 *
 * Lets the SERVER decide which layout loaders to skip: it already knows each layout's scoped params
 * (derived at build time), so given both paths it can tell whether a layout's own prefix changed.
 * Doing it server-side means the client never needs the scope table, and the decision lives next to
 * the data it is about.
 *
 * Sent only when the client actually holds layout data to retain, so a request without it is simply
 * the full-chain case.
 */
export const NAV_FROM_HEADER = "x-nifra-from"

/**
 * The data-mode payload once a chain can carry layout data.
 *
 * Versioned because a prerendered `_data.json` is a static file on a CDN and outlives the deploy that
 * wrote it: a browser running new client code can be handed an envelope written by the previous
 * build. The reader therefore accepts BOTH the bare pre-envelope value and this shape, and decides by
 * structure rather than by assuming the deploy was atomic.
 */
export interface RouteDataEnvelope {
  readonly v: 1
  readonly data: unknown
  readonly layoutData?: readonly unknown[]
  /** Indices whose loader was SKIPPED because the layout's own params did not change. The client
   * keeps its existing value at each of these, so an unchanged layout is neither refetched nor lost. */
  readonly retained?: readonly number[]
  /** Dynamic-boundary states returned alongside loader/layout data. */
  readonly boundaries?: BoundaryStates
  /** Terminal status signalled by a loader. Added by the browser transport after reading
   * `X-Nifra-Status`; old servers and static data files simply omit it. */
  readonly status?: number
}

/** Recognise the envelope without mistaking a plain loader object that happens to have a `data` key. */
export function isRouteDataEnvelope(value: unknown): value is RouteDataEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { v?: unknown }).v === 1 &&
    "data" in value
  )
}

/** A URL matched against the manifest patterns: which route + its extracted params. */
export interface RouteMatch {
  readonly routeId: string
  readonly params: Record<string, string>
}

/** An in-flight client submit - the action it targets + the `FormData` being sent. Set while the
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
  /** Per-layout loader data, aligned with the matched chain's leading layout prefix. Absent when no
   * layout in that chain has a loader. */
  readonly layoutData?: readonly unknown[] | undefined
  /** Neutral named-boundary states for the active route. */
  readonly boundaries?: BoundaryStates
  /** An action's data return after a client-side submit (cleared on navigation). */
  readonly actionData?: unknown
  /** True while a navigation or submit is in flight (drives loading UI). */
  readonly pending: boolean
  /** The path a navigation is transitioning TO while `pending` (cleared when it settles). Lets a
   * `NavLink` know whether its own `to` is the one loading; `undefined` when idle. */
  readonly pendingPath?: string | undefined
  /** The in-flight submit (set during a `submit`, cleared when it settles) - for optimistic UI. */
  readonly submission?: Submission
}

/** A route id paired with its nifra pattern (e.g. `":id"` segments) - the matcher input. */
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
  // Reuse the core's radix-style segment index instead of scanning every manifest route on each
  // navigation. The old sorted array was fine for tiny apps, but made client matching O(routes) and
  // forced every navigation through every unrelated pattern. The core Router owns the same
  // static/param/mixed/wildcard precedence as the server, so the two sides cannot drift.
  const routeIndex = new CoreRouter<string>()
  for (const pattern of patterns) {
    // Pass the literal to the public router seam: package type resolution may point the two core
    // subpaths at different source/dist declarations, while registration-time compilation is cheap.
    routeIndex.add("GET", pattern.pattern, pattern.routeId)
  }
  return (path) => {
    // Strip the query without allocating a `split("?")` array - matcher runs per match.
    const q = path.indexOf("?")
    const clean = q === -1 ? path : path.slice(0, q)
    // Core's server router tolerates a missing leading slash; browser navigation paths do not. Keep
    // the client contract strict so this index is a drop-in replacement for matchRoutePattern.
    if (clean.charCodeAt(0) !== 47 /* / */) return null
    const match = routeIndex.find("GET", clean)
    if (!match.found) return null
    const params = decodeRouteParams(match.params)
    return params === null ? null : { routeId: match.payload, params }
  }
}

/** How a router fetches a route's loader data on navigation. `signal` aborts a superseded fetch
 * (and its deferred stream). */
export type FetchRouteData = (
  path: string,
  match: RouteMatch,
  signal?: AbortSignal,
  navigation?: {
    readonly from: string
    readonly retain: readonly number[]
  },
) => Promise<unknown>

/** Per-submit options. `revalidate: false` opts out of the post-action loader re-fetch. */
export interface SubmitOptions {
  /** Re-run the active route's loader after the action settles (default `true`). Set `false` to
   * keep the current `data` and rely on the action's `actionData` alone. */
  readonly revalidate?: boolean
}

/** A fetcher's observable state - independent of the main router. `pending` covers its in-flight
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
 * with the main router and with other fetchers - each is single-flight against *itself* (its own
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
   * (No `revalidate` opt-out - a fetcher has no active loader of its own to skip.) */
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
   * revalidation - keep the current `data` and just publish the action's `actionData` (useful when
   * the action already returned everything that changed, saving the extra round-trip). A redirect
   * always loads its target regardless. Rejects on failure (caller falls back).
   */
  submit: (
    action: string,
    body: NonNullable<RequestInit["body"]>,
    opts?: SubmitOptions,
  ) => Promise<void>
  /** Run the initial route's client loader after the adapter has hydrated the SSR markup. */
  hydrate: () => Promise<void>
  /**
   * Mark cached route data stale and refresh the active view. With `paths`, target exactly those
   * (e.g. the routes a mutation changed); without, invalidate the whole cache. The active route
   * refreshes immediately - refetched + republished - whenever it's in scope (an explicit list that
   * includes it, or an invalidate-all); other stale entries refetch lazily when next read (a
   * fetcher, or the next navigation/access). Rejects if the active refetch fails (like `navigate`).
   * The keyed substrate for targeted revalidation (the `X-Nifra-Revalidate` header) and fetchers.
   */
  invalidate: (paths?: readonly string[]) => Promise<void>
  /**
   * Warm a path's chunk + loader data into a bounded one-shot cache without publishing state -
   * a later `navigate` to it transitions with no network round-trip. Best-effort: failures and
   * unmatched paths are no-ops. Wired to link hover/focus by `installHistory`.
   */
  prefetch: (path: string) => Promise<void>
  /**
   * Get (lazily creating) the stable {@link Fetcher} for `key` - an independent, concurrent
   * load/submit state machine for row-level mutations or side-channel loads that must not disturb
   * the active view. The same `key` always returns the same fetcher (so a binding can subscribe to a
   * stable store). Keys are app-chosen and typically stable (e.g. a row id).
   */
  fetcher: (key: string) => Fetcher
  /** All live fetchers - for a global busy view (e.g. a `useFetchers` binding). */
  fetchers: () => readonly Fetcher[]
  /** Subscribe to any-fetcher-changed (a transition on any fetcher, or a new one created) - backs a
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
  /** Terminal status → client route id. Generated entries populate this from `_404` and
   * `_<status>` files so soft navigation renders the same boundary as a hard request. */
  readonly statusRoutes?: Readonly<Record<number, string>>
  /** routeId → the route's client-only search keys (its `searchClientKeys` export). When a soft
   * navigation stays on the same route + pathname and changes ONLY these keys, `navigate` publishes the
   * new URL WITHOUT re-running the loader (re-render, not revalidate). Populated lazily by the generated
   * entry's `loadModule` (so a route's keys are present once it has been visited, which is exactly when a
   * same-route nav can consult them). Omit ⇒ every search change revalidates (the safe default). */
  readonly searchClientKeys?: Readonly<Record<string, readonly string[]>>
  /** routeId → client-only loader/action hooks, populated by the generated route entry. */
  readonly routeHooks?: Readonly<Record<string, ClientRouteHooks | undefined>>
}

/** Options for a per-adapter `mountRouter` (the Router binding that hydrates + re-renders). */
export interface MountRouterOptions {
  readonly router: ClientRouter
  /** routeId → layout chain (outermost layout → page); built by `generateClientEntry`. */
  readonly routes: Record<string, readonly unknown[]>
  /** routeId → the route's search-schema CHAIN (its layout chain's `searchSchema` exports, outermost
   * first, then the page's; each entry `undefined` when that module declares none); built by
   * `generateClientEntry`. The mount derives each route's typed `search` from this chain plus the URL via
   * `searchOfChain` (layout keys merged with page keys, page-wins), matching the server's
   * `ctx.search`/`RenderProps.search`. Omitted by callers with no typed search (tests, a hand-built mount)
   * ⇒ every route sees the raw parsed query. */
  readonly searchSchemas?: Readonly<Record<string, readonly (StandardSchemaV1 | undefined)[]>>
  /** Hydration container (opaque - the adapter casts it to its DOM element type). */
  readonly container: unknown
}

/** Read a nifra data response: a deferred loader/action streams NDJSON (parse line 1 + settle
 * `<Await>` markers as resolution lines arrive); a non-deferred one returns a single JSON. Shared by
 * navigation fetches and action submits - both transports are identical. */
const readResponseData = (res: Response, signal?: AbortSignal): Promise<unknown> =>
  (res.headers.get("content-type") ?? "").includes("application/x-ndjson") && res.body !== null
    ? parseNdjsonData(res.body, signal)
    : res.json()

// Index scan, not `/\/+$/` - the unanchored-start trailing-run replace backtracks quadratically and
// the pathname is caller-controlled.
const trimTrailingSlashes = (path: string): string => {
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47 /* '/' */) end--
  return path.slice(0, end)
}

// The static `_data.json` URL for a prerendered path: `/` → `/_data.json`, `/users/7` →
// `/users/7/_data.json` (mirrors the build's `dataFileFor`).
const dataUrlFor = (pathname: string): string =>
  pathname === "/" ? "/_data.json" : `${trimTrailingSlashes(pathname)}/_data.json`

// The generated prerender list is immutable for the lifetime of a client entry. Cache its Set by
// array identity so a large SSG site pays the O(n) build once, while repeated navigations stay O(1).
// A WeakMap avoids retaining a list after its router/test instance is gone.
const PRERENDERED_SET_CACHE = new WeakMap<object, ReadonlySet<unknown>>()
const prerenderedSetOf = (paths: object): ReadonlySet<unknown> => {
  const cached = PRERENDERED_SET_CACHE.get(paths)
  if (cached !== undefined) return cached
  const set = new Set(paths as Iterable<unknown>)
  PRERENDERED_SET_CACHE.set(paths, set)
  return set
}

const defaultFetchData: FetchRouteData = async (path, _match, signal, navigation) => {
  // SSG fast path: if this path was prerendered, its loader data is a static file - fetch that (no
  // worker). Falls through to the dynamic header-GET on any miss (file absent, e.g. a deferred route,
  // or a stale set), so it's always safe. Non-SSG apps have no global → the dynamic path, unchanged.
  const prerendered = (globalThis as { [PRERENDERED_GLOBAL]?: unknown })[PRERENDERED_GLOBAL]
  if (Array.isArray(prerendered)) {
    const query = path.indexOf("?")
    const hash = path.indexOf("#")
    // `indexOf` rather than `replace(/[?#].*$/)`: no regex allocation or backtracking on a
    // caller-controlled navigation path.
    const cut = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash)
    const pathname = cut === -1 ? path : path.slice(0, cut)
    if (prerenderedSetOf(prerendered).has(pathname)) {
      const staticRes = await fetch(dataUrlFor(pathname), { signal: signal ?? null })
      if (staticRes.ok) return readResponseData(staticRes, signal)
    }
  }
  const headers = new Headers({ [DATA_HEADER]: "1" })
  if (navigation !== undefined && navigation.retain.length > 0) {
    headers.set(RETAIN_HEADER, navigation.retain.join(","))
    headers.set(NAV_FROM_HEADER, navigation.from)
  }
  const res = await fetch(path, { headers, signal: signal ?? null })
  const status = Number(res.headers.get(STATUS_HEADER))
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return { v: 1, data: null, status } satisfies RouteDataEnvelope
  }
  if (!res.ok) throw new Error(`[nifra/web] navigation data fetch failed (${res.status}): ${path}`)
  return readResponseData(res, signal)
}

/**
 * Create the agnostic router store. `navigate` is guarded by a monotonic token so that when
 * navigations overlap, only the latest result is applied (rapid clicks don't flash stale data).
 * A failed fetch clears `pending` and rethrows so the caller can fall back to a full-page load.
 */
// Split a `pathname + search` into its two parts. `rawSearchOf` keeps the leading `?` (what
// `parseSearch` accepts); an empty query yields `""`.
const pathnameOf = (path: string): string => {
  const q = path.indexOf("?")
  return q === -1 ? path : path.slice(0, q)
}
const rawSearchOf = (path: string): string => {
  const q = path.indexOf("?")
  return q === -1 ? "" : path.slice(q)
}

/** Validate the client-action envelope before reading it. Its `body` is deliberately not treated as
 * trusted data: it is an opaque RequestInit body that the server action must parse and authorize. */
const isClientActionResult = (value: unknown): value is ClientActionResult =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function createClientRouter(options: ClientRouterOptions): ClientRouter {
  const match = createMatcher(options.patterns)
  const fetchData = options.fetchData ?? defaultFetchData
  // routeId → the route's client-only search keys. Read by reference (the generated entry keeps writing
  // to it as routes load), so a same-route nav always sees the current route's keys.
  const searchClientKeys = options.searchClientKeys ?? {}
  // routeId → client hooks. The generated entry mutates this object only while loading a route module;
  // route navigation reads it after `loadModule` resolves, so an app without hooks pays only a map
  // lookup and keeps the existing route-chunk split.
  const routeHooks = options.routeHooks ?? {}
  /**
   * Fetch a route's data and normalise it.
   *
   * The payload is either the versioned envelope (a chain with layout loaders) or the bare loader
   * value (everything else, and every response written before layout loaders existed). Deciding by
   * structure rather than by version-of-the-deploy is what lets a prerendered `_data.json` written by
   * an older build be read by newer client code.
   */
  type LoadedRouteData = {
    readonly data: unknown
    readonly layoutData?: readonly unknown[] | undefined
    readonly terminalRouteId?: string | undefined
    readonly boundaries?: BoundaryStates
  }
  const loadRouteData = async (
    path: string,
    match: { routeId: string; params: Record<string, string> },
    signal?: AbortSignal,
    retainFrom?: { readonly path: string; readonly layoutData: readonly unknown[] },
  ): Promise<LoadedRouteData> => {
    const retain = retainFrom?.layoutData.map((_, index) => index) ?? []
    const payload = await fetchData(
      path,
      match,
      signal,
      retainFrom === undefined ? undefined : { from: retainFrom.path, retain },
    )
    if (!isRouteDataEnvelope(payload)) return { data: payload }
    if (payload.status !== undefined) {
      const terminalRouteId = options.statusRoutes?.[payload.status] ?? options.statusRoutes?.[404]
      if (terminalRouteId === undefined) {
        throw new Error(
          `[nifra/web] no client status boundary is available for terminal status ${payload.status}`,
        )
      }
      return { data: null, terminalRouteId }
    }
    if (retainFrom === undefined || payload.retained === undefined) {
      return {
        data: payload.data,
        layoutData: payload.layoutData,
        ...(payload.boundaries !== undefined ? { boundaries: payload.boundaries } : {}),
      }
    }
    const retained = new Set(
      payload.retained.filter(
        (index) => Number.isInteger(index) && index >= 0 && index < retainFrom.layoutData.length,
      ),
    )
    const layoutData = payload.layoutData?.map((value, index) =>
      retained.has(index) ? retainFrom.layoutData[index] : value,
    )
    return {
      data: payload.data,
      layoutData,
      ...(payload.boundaries !== undefined ? { boundaries: payload.boundaries } : {}),
    }
  }
  /**
   * Apply a client loader without making the server loader eager. The thunk is memoized per navigation
   * (or per hydration), so a hook can call it repeatedly without duplicate requests. The returned
   * client value is never sent back to the server.
   */
  const applyClientLoader = async (
    path: string,
    route: { routeId: string; params: Record<string, string> },
    signal: AbortSignal | undefined,
    serverLoad: () => Promise<LoadedRouteData>,
    initial?: LoadedRouteData,
  ): Promise<LoadedRouteData> => {
    const hook = routeHooks[route.routeId]?.clientLoader
    if (hook === undefined) return initial ?? serverLoad()
    let serverResult: Promise<LoadedRouteData> | undefined =
      initial === undefined ? undefined : Promise.resolve(initial)
    const serverLoader = async (): Promise<unknown> => {
      if (signal?.aborted === true)
        throw new DOMException("The operation was aborted", "AbortError")
      serverResult ??= serverLoad()
      return (await serverResult).data
    }
    const clientData = await hook({
      url: path,
      params: route.params,
      signal: signal ?? new AbortController().signal,
      serverLoader,
    })
    const loaded = await serverResult
    if (loaded === undefined) return { data: clientData }
    // A server terminal status always wins over client-derived data. The client hook can enrich a
    // normal response, but it cannot turn a server 404/410 into a rendered success route.
    if (loaded.terminalRouteId !== undefined) return loaded
    return { ...loaded, data: clientData }
  }
  const loadModule = options.loadModule
  const prepareClientAction = async (
    action: string,
    body: ClientRequestBody,
    signal: AbortSignal,
  ): Promise<{ readonly body: ClientRequestBody; readonly optimisticData?: unknown }> => {
    const target = match(action)
    if (target === null) return { body }
    await loadModule?.(target.routeId)
    const hook = routeHooks[target.routeId]?.clientAction
    if (hook === undefined) return { body }
    const result = await hook({
      url: action,
      params: target.params,
      signal,
      body,
      serverLoader: async () => state.data,
    })
    if (result === undefined) return { body }
    if (!isClientActionResult(result)) {
      throw new TypeError("[nifra/web] clientAction must return an object or undefined")
    }
    return {
      body: result.body ?? body,
      ...(Object.hasOwn(result, "optimisticData") ? { optimisticData: result.optimisticData } : {}),
    }
  }
  let hydrated = false
  const hydrate = async (): Promise<void> => {
    if (hydrated) return
    hydrated = true
    const route = { routeId: state.routeId, params: state.params }
    if (routeHooks[route.routeId]?.clientLoader === undefined) return
    const mine = ++token
    navAbort?.abort()
    const ac = new AbortController()
    navAbort = ac
    const initial = {
      data: state.data,
      layoutData: state.layoutData,
      ...(state.boundaries !== undefined ? { boundaries: state.boundaries } : {}),
    }
    const loaded = await applyClientLoader(
      state.path,
      route,
      ac.signal,
      () => Promise.resolve(initial),
      initial,
    )
    if (mine !== token) return
    if (loaded.terminalRouteId !== undefined) {
      await loadModule?.(loaded.terminalRouteId)
      state = { ...state, routeId: loaded.terminalRouteId, params: {}, data: null }
    } else {
      state = {
        ...state,
        data: loaded.data,
        layoutData: loaded.layoutData,
        ...(loaded.boundaries !== undefined ? { boundaries: loaded.boundaries } : {}),
      }
    }
    emit()
  }
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
  const prefetched = new Map<string, LoadedRouteData>()
  const inflight = new Set<string>()
  // Keyed data cache (path → latest loader data + freshness). Written on every published data
  // (navigate/submit), read by `invalidate` (+ targeted revalidation and fetchers in later F16
  // increments). Bounded - evict the oldest-inserted past the cap (route data is small; this just
  // caps memory). `status` is the staleness ledger: `invalidate` flips entries to `stale`; readers
  // refetch stale ones. Client-only - never serialized/hydrated.
  const MAX_CACHE = 50
  const cache = new Map<
    string,
    {
      data: unknown
      layoutData?: readonly unknown[] | undefined
      boundaries?: BoundaryStates
      status: "fresh" | "stale"
    }
  >()
  const cachePut = (path: string, loaded: LoadedRouteData): void => {
    if (!cache.has(path) && cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    // The PAIR, not just the value: navigating back to a cached route must restore its layouts' data
    // too, or they would render empty on a hit and populated on a miss.
    cache.set(path, {
      data: loaded.data,
      layoutData: loaded.layoutData,
      ...(loaded.boundaries !== undefined ? { boundaries: loaded.boundaries } : {}),
      status: "fresh",
    })
  }
  // Flip cached entries to stale (a no-op for paths not in the cache). Shared by `invalidate` and the
  // `X-Nifra-Revalidate` handling in `submit`.
  const markStale = (paths: readonly string[]): void => {
    for (const p of paths) {
      const entry = cache.get(p)
      if (entry !== undefined) {
        cache.set(p, {
          data: entry.data,
          layoutData: entry.layoutData,
          ...(entry.boundaries !== undefined ? { boundaries: entry.boundaries } : {}),
          status: "stale",
        })
      }
    }
  }
  // Parse the `X-Nifra-Revalidate` response header into validated paths. The header is response data
  // (a trust boundary), so each path must match a real manifest pattern - unknown/garbage is dropped
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
      const active = { routeId: state.routeId, params: state.params }
      const loaded = await applyClientLoader(state.path, active, ac.signal, () =>
        loadRouteData(state.path, active, ac.signal),
      )
      if (mine !== token) return // superseded - drop the stale result
      cachePut(state.path, loaded)
      state = {
        ...state,
        data: loaded.data,
        layoutData: loaded.layoutData,
        ...(loaded.boundaries !== undefined ? { boundaries: loaded.boundaries } : {}),
        pending: false,
      }
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
  // swallowed - a failed targeted refresh must not fail the mutation that triggered it.
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
        const [, loaded] = await Promise.all([
          loadModule?.(matched.routeId),
          loadRouteData(path, matched, ac.signal),
        ])
        if (mine !== fToken) return // a newer load/submit on THIS fetcher superseded us
        // Record the loaded path only on SUCCESS - a thrown or superseded load must not
        // leave `loadedPath` pointing at a path this fetcher never actually showed, or a later
        // `X-Nifra-Revalidate` for it would spuriously refetch onto unexpected data.
        loadedPath = path
        cachePut(path, loaded)
        fState = { ...fState, data: loaded.data, pending: false }
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
        // Abort any prior in-flight load/submit on THIS fetcher (its fetch + NDJSON drain) - like
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
          // A fetcher has no loader of its own - its mutation's freshness flows through the cache:
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
      // Client-only search fast path: same route + same pathname, and every changed search key is
      // declared client-only. Publish the new URL (so `useSearch`/`useLocation` update) WITHOUT a data
      // fetch - the loader's inputs did not change. Any loader-affecting key change falls through to the
      // normal match → fetch → publish below, so data is never stale. Abort an in-flight fetch first: a
      // rapid `?tab` after a real nav must not let the older fetch overwrite this synchronous update.
      if (
        matched.routeId === state.routeId &&
        pathnameOf(path) === pathnameOf(state.path) &&
        isClientOnlySearchChange(
          rawSearchOf(state.path),
          rawSearchOf(path),
          searchClientKeys[state.routeId] ?? [],
        )
      ) {
        ++token // supersede any in-flight navigation so its late result is dropped
        navAbort?.abort()
        cachePut(path, {
          data: state.data,
          layoutData: state.layoutData,
          ...(state.boundaries !== undefined ? { boundaries: state.boundaries } : {}),
        })
        state = { ...state, path, pending: false, pendingPath: undefined }
        emit()
        return
      }
      const mine = ++token
      navAbort?.abort() // abandon any in-flight navigation's stream
      const ac = new AbortController()
      navAbort = ac
      state = { ...state, pending: true, pendingPath: path }
      emit()
      try {
        // Load the route chunk before invoking a client loader. A route without a client loader still
        // uses the same server-data path; a route with one gets a lazy `serverLoader()` thunk.
        await loadModule?.(matched.routeId)
        // Use prefetched server data when present (one-shot - drop it); clientLoader still runs over
        // that cached result without causing another network request.
        const hit = prefetched.has(path)
        const prefetchedData = hit ? (prefetched.get(path) as LoadedRouteData) : undefined
        if (hit) prefetched.delete(path)
        const loaded = await applyClientLoader(
          path,
          matched,
          ac.signal,
          () =>
            loadRouteData(
              path,
              matched,
              ac.signal,
              state.layoutData === undefined
                ? undefined
                : { path: state.path, layoutData: state.layoutData },
            ),
          prefetchedData,
        )
        if (loaded.terminalRouteId !== undefined) await loadModule?.(loaded.terminalRouteId)
        if (mine !== token) return // a newer navigation superseded this one - drop the stale result
        cachePut(path, loaded) // keep the keyed cache coherent with what we publish
        state = {
          routeId: loaded.terminalRouteId ?? matched.routeId,
          params: loaded.terminalRouteId === undefined ? matched.params : {},
          path,
          data: loaded.data,
          layoutData: loaded.layoutData,
          ...(loaded.boundaries !== undefined ? { boundaries: loaded.boundaries } : {}),
          actionData: undefined, // a fresh navigation has no action result
          pending: false,
        }
        emit()
      } catch (err) {
        // Clear our pending flag + target (only if still current) and rethrow - the caller decides how
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
      const previousActionData = state.actionData
      // A superseding navigation/submit aborts this submit's FOLLOW-UP reads (revalidation / redirect
      // fetch + their NDJSON drains) - not the mutation POST itself, which should complete.
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
        const prepared = await prepareClientAction(action, body, ac.signal)
        if (Object.hasOwn(prepared, "optimisticData")) {
          state = { ...state, actionData: prepared.optimisticData }
          emit()
        }
        const res = await fetch(action, {
          method: "POST",
          body: prepared.body,
          headers: { [DATA_HEADER]: "1" },
        })
        if (!res.ok) throw new Error(`[nifra/web] action failed (${res.status}): ${action}`)
        const redirectTo = res.headers.get(REDIRECT_HEADER)
        if (redirectTo !== null) {
          // The action redirected (Post/Redirect/Get) - treat it as a client navigation.
          const target = match(redirectTo)
          if (target === null)
            throw new Error(`[nifra/web] action redirect off-route: ${redirectTo}`)
          await loadModule?.(target.routeId)
          const loaded = await applyClientLoader(redirectTo, target, ac.signal, () =>
            loadRouteData(
              redirectTo,
              target,
              ac.signal,
              state.layoutData === undefined
                ? undefined
                : { path: state.path, layoutData: state.layoutData },
            ),
          )
          if (loaded.terminalRouteId !== undefined) await loadModule?.(loaded.terminalRouteId)
          if (mine !== token) return
          cachePut(redirectTo, loaded)
          state = {
            routeId: loaded.terminalRouteId ?? target.routeId,
            params: loaded.terminalRouteId === undefined ? target.params : {},
            path: redirectTo,
            data: loaded.data,
            layoutData: loaded.layoutData,
            ...(loaded.boundaries !== undefined ? { boundaries: loaded.boundaries } : {}),
            actionData: undefined,
            pending: false,
          }
          emit()
          return
        }
        // The action's data - streamed NDJSON if it `defer()`'d slow parts (markers settle as lines
        // arrive, for `<Await actionData>`), else one JSON. Abortable so a superseding nav cancels the
        // drain.
        const actionData = res.status === 204 ? undefined : await readResponseData(res, ac.signal)
        // Routes the action declared changed (via the `revalidate()` helper → `X-Nifra-Revalidate`),
        // validated against the manifest.
        const changed = parseRevalidate(res.headers.get(REVALIDATE_HEADER))
        // Revalidate the active route's loader so the mutation is reflected - unless the caller opted
        // out (`revalidate: false`). A server-declared revalidate of the active path overrides the
        // opt-out (the server says it changed, so stale data would be wrong). Default is to revalidate.
        const skipActive = opts?.revalidate === false && !changed.includes(state.path)
        const active = { routeId: state.routeId, params: state.params }
        const loaded = skipActive
          ? {
              data: state.data,
              layoutData: state.layoutData,
              ...(state.boundaries !== undefined ? { boundaries: state.boundaries } : {}),
            }
          : await applyClientLoader(state.path, active, ac.signal, () =>
              loadRouteData(state.path, active, ac.signal),
            )
        if (mine !== token) return
        cachePut(state.path, loaded) // the revalidated (or kept) data is now the cache's truth
        // Mark the OTHER changed routes stale so the next access refetches.
        markStale(changed.filter((p) => p !== state.path))
        // Reconcile: publish the revalidated data + actionData; omit `submission` (the optimistic
        // window is over - the real data now drives the view).
        state = {
          routeId: state.routeId,
          params: state.params,
          path: state.path,
          data: loaded.data,
          layoutData: loaded.layoutData,
          ...(loaded.boundaries !== undefined ? { boundaries: loaded.boundaries } : {}),
          actionData,
          pending: false,
        }
        emit()
        // Refresh any mounted fetcher showing one of the changed routes (the active route was just
        // revalidated inline above, so skip it here). Best-effort - never rejects the submit.
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
            actionData: previousActionData,
            pending: false,
          }
          emit()
        }
        throw err
      }
    },
    hydrate,
    invalidate: async (paths) => {
      // Mark targeted cache entries stale (all entries when no `paths`) - unmounted ones refetch
      // lazily on next access.
      const targets = paths ?? [...cache.keys()]
      markStale(targets)
      // Refresh mounted readers now: the active route (when in scope - an explicit list including it,
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
        // Unwrapped here, so a prefetched entry is the same shape `navigate` builds state from -
        // otherwise a prefetch hit would publish an envelope where a miss publishes loader data.
        const [, loaded] = await Promise.all([
          loadModule?.(matched.routeId),
          loadRouteData(path, matched),
        ])
        if (prefetched.size >= MAX_PREFETCH) {
          const oldest = prefetched.keys().next().value
          if (oldest !== undefined) prefetched.delete(oldest)
        }
        prefetched.set(path, loaded)
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
      emitFetchers() // a new fetcher appeared - wake any `useFetchers` subscriber
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
