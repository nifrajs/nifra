/**
 * The agnostic client-side router core - pure logic, no `window`, no framework. A per-adapter
 * Router binding subscribes via `subscribe`/`snapshot` and renders the matched chain; a
 * browser-only `installHistory` (history + link interception) wires on top. Kept DOM-free so it
 * unit-tests without a browser and is safe to import from the SSR core's main entry.
 */
import { decodeRouteParams } from "@nifrajs/core/pattern"
import { Router as CoreRouter } from "@nifrajs/core/router"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import type { BoundaryDescriptor, BoundaryState, BoundaryStates } from "./boundary.ts"
import { parseNdjsonData } from "./deferred.ts"
import { epochOf, IDENTITY_CHANNEL, onIdentityChange } from "./identity.ts"
import { parsePageData } from "./internal/revive-dates.ts"
import { appUrl, requestPattern } from "./internal/route-path.ts"
import { shareData } from "./internal/share-data.ts"
import type { ClientActionResult, ClientRequestBody, ClientRouteHooks } from "./manifest.ts"
import type { MatchChain } from "./render-seam.ts"
import { isClientOnlySearchChange } from "./search.ts"

/**
 * Request header that asks a nifra route's GET to return just the loader data as JSON (instead of
 * the full HTML document). Set by client-side navigation; read by `createWebApp`'s GET handler.
 */
export const DATA_HEADER = "x-nifra-data"

/**
 * Sent beside {@link DATA_HEADER} by a prefetch. A partially prerendered route answers it with its
 * shell data and starts no hole: nothing could cancel that work if the link is never followed.
 */
export const PREFETCH_HEADER = "x-nifra-prefetch"

/**
 * Global the server injects (`createWebApp({ prerenderedPaths })`) listing the SSG-prerendered paths.
 * The client's default data fetch reads it: a soft-nav INTO a prerendered route fetches its static
 * `<path>/_data.json` (a CDN file - no worker round-trip) instead of the dynamic header-GET, unless
 * the target carries a query string.
 */
export const PRERENDERED_GLOBAL = "__NIFRA_PRERENDERED__"

/** Where `createWebApp` serves a prerendered set too large to inline; the global then holds this URL
 * plus a `?v=` content version, so the browser may cache it for good. */
export const PRERENDERED_LIST_PATH = "/__nifra/prerendered.json"

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
 * Sent on a data request that reloads the route instance on screen: the holes, comma separated, whose
 * hosts the partially prerendered page holds. Each one's state then carries its fill (server HTML,
 * plus props when it hydrates) instead of its data, so the client updates the host in place.
 */
export const HOLE_FILL_HEADER = "x-nifra-hole-fill"

/**
 * Holes of a partially prerendered page the client keeps, comma separated: they are not loaded, and
 * each state says so. Only the live load endpoint sets it, for holes whose keys did not change. A name
 * the route does not declare is refused with a 400.
 */
export const KEEP_HOLES_HEADER = "x-nifra-keep-holes"

/**
 * The data-mode payload once a chain can carry layout data.
 *
 * Versioned because a prerendered `_data.json` is a static file on a CDN and outlives the deploy that
 * wrote it: a browser running new client code can be handed an envelope written by the previous
 * build. The reader therefore accepts BOTH the bare pre-envelope value and this shape, and decides by
 * structure rather than by assuming the deploy was atomic.
 */
export interface RouteDataEnvelope {
  readonly serverComponents?: import("./server-components/types.ts").ComponentState | undefined
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
  /** A live load's handle, carried through to {@link RouterState.live} untouched. */
  readonly live?: unknown
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
  readonly serverComponents?: import("./server-components/types.ts").ComponentState | undefined
  readonly routeId: string
  readonly params: Record<string, string>
  /** The current URL path (used to revalidate the active loader after an action). While
   * {@link intercepted} is set it is the target shown in the boundary, not the page's own. */
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
  /** The path a navigation or a submit's redirect is loading while `pending`; a redirect the router
   * follows moves it to the target. Lets a `NavLink` know whether its own `to` is the one loading;
   * `undefined` when idle. */
  readonly pendingPath?: string | undefined
  /** The in-flight submit (set during a `submit`, cleared when it settles) - for optimistic UI. */
  readonly submission?: Submission
  /** Set while an intercept boundary shows a navigation's target over the page: the boundary holding
   * it, and the path the page underneath was loaded from. The page revalidates under `pagePath`, the
   * boundary under `path`. */
  readonly intercepted?: Intercepted
  /** Opaque: which live load the page data on screen came from (`@nifrajs/web/live-client`). */
  readonly live?: unknown
  /** The page instance on screen, when the app keeps pages alive (`@nifrajs/web/keep-alive`). */
  readonly instance?: string | undefined
  /** Pages kept mounted and hidden, least recently shown first. Absent when none is kept. */
  readonly kept?: readonly KeptPage[] | undefined
  /** This publish showed a kept page again. */
  readonly restored?: boolean | undefined
  /** A page shown again is reloading its data in place: not a navigation, so `pending` stays false. */
  readonly revalidating?: boolean | undefined
}

/** A page kept mounted while its history entry is not the one on screen. */
export interface KeptPage {
  readonly instance: string
  /** Its last settled state, which it renders from while hidden. */
  readonly state: RouterState
}

/** Which intercept boundary is open, and the page underneath it. */
export interface Intercepted {
  readonly boundary: string
  readonly pagePath: string
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
    routeIndex.add("GET", requestPattern(pattern.pattern), pattern.routeId)
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

/**
 * What the router knows about the response text a path's data on screen was read from. The router's
 * own transport resolves a reload answering that same text to this object itself, and the router keeps
 * the data on screen without parsing it; for any other plain JSON response it records the text in
 * `text`. A response with deferred parts sets neither, and a custom transport may ignore it.
 */
export interface DataText {
  readonly previous: string | undefined
  text?: string
}

/** How a router fetches a route's loader data on navigation. `signal` aborts a superseded fetch
 * (and its deferred stream). `purpose` is `"prefetch"` when no navigation is waiting on the result.
 * `hosts` names the holes of the page on screen whose hosts reload in place
 * ({@link HOLE_FILL_HEADER}). `read` is the {@link DataText} of the data on screen, which a custom
 * transport may ignore. */
export type FetchRouteData = (
  path: string,
  match: RouteMatch,
  signal?: AbortSignal,
  navigation?: {
    readonly from: string
    readonly retain: readonly number[]
  },
  purpose?: "prefetch",
  hosts?: readonly string[],
  read?: DataText,
) => Promise<unknown>

/** Per-submit options. `revalidate: false` opts out of the post-action loader re-fetch. */
export interface SubmitOptions {
  /** Re-run the active route's loaders after the action settles (default `true`). Set `false` to
   * keep the current `data` and rely on the action's `actionData` alone. When the action redirects,
   * the target's layouts all re-run by default; with `false` it keeps the layout data an ordinary
   * navigation would. */
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
 * monotonic generation), so N row-level mutations / side-channel loads can be in flight at once without
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
  /**
   * Navigate to a path: match → fetch loader data → publish. No-op for an unmatched path. A loader
   * redirect to another route is followed; one that leaves the app (another origin, a `#fragment`, no
   * route) rejects with its target as `redirectTo`.
   */
  navigate: (path: string) => Promise<void>
  /**
   * Submit an action (POST `body` to `action` in data mode): a redirect becomes a client
   * navigation; otherwise the data return is published as `actionData` and the active route's
   * loader is revalidated so the mutation is reflected. Pass `{ revalidate: false }` to SKIP that
   * revalidation - keep the current `data` and just publish the action's `actionData` (useful when
   * the action already returned everything that changed, saving the extra round-trip). A redirect
   * always loads its target regardless. Rejects on failure (caller falls back); once the server has
   * answered, at any status, the rejection's `redirectTo` names the page to load instead of posting
   * again. A revalidation answered with a terminal status renders that status route in the page's
   * place.
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
   * A refetch answered with a terminal status renders that status route in the page's place; one
   * whose status page renders inside layouts rejects, so the caller can load the page as a document.
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
   * with the loader data, so `pending` covers both. Omit when the bundle isn't split. `path` is the URL
   * the route is about to render, for code loaded per URL (a production build's copy chunks). */
  readonly loadModule?: (routeId: string, path?: string) => Promise<void>
  /** Terminal status → client route id. Generated entries populate this from `_404` and
   * `_<status>` files so soft navigation renders the same boundary as a hard request. */
  readonly statusRoutes?: Readonly<Record<number, string>>
  /** Status route ids whose page renders inside layouts (all but `inLayouts = false`), filled in by the generated entry's
   * `loadModule`. A soft navigation that ends on one loads the URL as a document, as one ending on a
   * nested `_404` does: only the server runs those layouts' loaders. */
  readonly layoutStatusRoutes?: Readonly<Record<string, true>>
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
  /** routeId → the ids and `handle` exports `useMatches` reports for that chain; built by
   * `generateClientEntry` as each route's modules load. The mount hands the current route's entry to
   * the render as `RenderProps.matchChain`. Omitted ⇒ `useMatches` returns an empty list. */
  readonly matchChains?: Readonly<Record<string, MatchChain>>
  /** Hydration container (opaque - the adapter casts it to its DOM element type). */
  readonly container: unknown
}

/** Read a nifra data response: a deferred loader/action streams NDJSON (parse line 1 + settle
 * `<Await>` markers as resolution lines arrive); a non-deferred one returns a single JSON. Shared by
 * navigation fetches and action submits - both transports are identical. */
const readResponseData = (
  res: Response,
  signal?: AbortSignal,
  read?: DataText,
): Promise<unknown> =>
  (res.headers.get("content-type") ?? "").includes("application/x-ndjson") && res.body !== null
    ? parseNdjsonData(res.body, signal)
    : res.text().then((text) => {
        if (read === undefined) return parsePageData(text)
        if (text === read.previous) return read
        read.text = text
        return parsePageData(text)
      })

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

// A handed-over URL is fetched once: the global then holds the pending list every navigation shares.
// A failed fetch leaves navigations on the dynamic path, which is always correct.
const prerenderedOf = (): unknown => {
  const handed = Reflect.get(globalThis, PRERENDERED_GLOBAL)
  if (typeof handed !== "string") return handed
  const list = fetch(handed)
    .then((res) => (res.ok ? res.json() : undefined))
    .catch(() => undefined)
  Reflect.set(globalThis, PRERENDERED_GLOBAL, list)
  return list
}

/**
 * The page to load as a document, when that is why a navigation or submit rejected. Only an `http:` or
 * `https:` target: the caller hands it to `location`, which runs a `javascript:` URL in this page,
 * where the same target in a real redirect's `Location` never runs.
 */
export const redirectOf = (error: unknown): string | undefined => {
  const to = (error as { redirectTo?: unknown } | null | undefined)?.redirectTo
  return typeof to === "string" && /^https?:$/.test(targetUrl(to)?.protocol ?? "") ? to : undefined
}

/** A redirect target resolved against a placeholder origin, or `undefined` when it does not parse. */
const targetUrl = (to: string): URL | undefined => {
  try {
    return new URL(to, "http://n.invalid")
  } catch {
    return undefined
  }
}

const redirected = (to: string, cause?: unknown): Error =>
  Object.assign(new Error(`[nifra/web] redirected to ${to}`, { cause }), { redirectTo: to })

/**
 * A route data response as `fetchData` resolves it: a loader's in-app redirect rejects with its
 * target, a terminal status becomes an envelope carrying it, and any other failure rejects.
 */
export const routeDataOf = async (
  res: Response,
  path: string,
  signal?: AbortSignal,
  read?: DataText,
): Promise<unknown> => {
  const redirectTo = res.headers.get(REDIRECT_HEADER)
  if (redirectTo !== null) throw redirected(redirectTo)
  const status = Number(res.headers.get(STATUS_HEADER))
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return { v: 1, data: null, status } satisfies RouteDataEnvelope
  }
  if (!res.ok) throw new Error(`[nifra/web] navigation data fetch failed (${res.status}): ${path}`)
  return readResponseData(res, signal, read)
}

/** The router's own transport, which a `fetchData` override may layer over. */
export const fetchRouteData: FetchRouteData = async (
  path,
  _match,
  signal,
  navigation,
  purpose,
  hosts,
  read,
) => {
  // SSG fast path: if this path was prerendered, its loader data is a static file - fetch that (no
  // worker). Falls through to the dynamic header-GET on any miss (file absent, e.g. a deferred route,
  // or a stale set), so it's always safe. Non-SSG apps have no global → the dynamic path, unchanged.
  const prerendered = await prerenderedOf()
  // `indexOf` rather than a regex: no allocation or backtracking on a caller-controlled path.
  const query = path.indexOf("?")
  const hash = path.indexOf("#")
  // The file was rendered without a query, so a query-bearing path renders on demand, exactly as
  // `servePrerenderedPages` answers the same URL on a hard request.
  if (Array.isArray(prerendered) && (query === -1 || (hash !== -1 && hash < query))) {
    const pathname = hash === -1 ? path : path.slice(0, hash)
    if (prerenderedSetOf(prerendered).has(pathname)) {
      const staticRes = await fetch(appUrl(dataUrlFor(pathname)), { signal: signal ?? null })
      if (staticRes.ok) return readResponseData(staticRes, signal, read)
    }
  }
  const headers = new Headers({ [DATA_HEADER]: "1" })
  if (purpose === "prefetch") headers.set(PREFETCH_HEADER, "1")
  if (hosts !== undefined && hosts.length > 0) headers.set(HOLE_FILL_HEADER, hosts.join(","))
  if (navigation !== undefined && navigation.retain.length > 0) {
    headers.set(RETAIN_HEADER, navigation.retain.join(","))
    headers.set(NAV_FROM_HEADER, navigation.from)
  }
  return routeDataOf(
    await fetch(appUrl(path), { headers, signal: signal ?? null }),
    path,
    signal,
    read,
  )
}

/**
 * Create the agnostic router store. `navigate` is guarded by a monotonic generation so that when
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
  const fetchData = options.fetchData ?? fetchRouteData
  // Start a handed-over list's fetch now, so the first navigation rarely waits for it.
  if (fetchData === fetchRouteData) prerenderedOf()
  // routeId → the route's client-only search keys. Read by reference (the generated entry keeps writing
  // to it as routes load), so a same-route nav always sees the current route's keys.
  const searchClientKeys = options.searchClientKeys ?? {}
  // routeId → client hooks. The generated entry mutates this object only while loading a route module;
  // route navigation reads it after `loadModule` resolves, so an app without hooks pays only a map
  // lookup and keeps the existing route-chunk split.
  const routeHooks = options.routeHooks ?? {}
  // Intercept patterns are compiled lazily from the already-loaded source route descriptor. Invalid
  // client metadata is ignored (the server's register-time boundary validation remains authoritative),
  // so a hand-built client manifest fails closed into an ordinary navigation.
  const interceptMatchers = new Map<string, ReturnType<typeof createMatcher> | null>()
  const interceptionFor = (
    sourceRouteId: string,
    path: string,
    target: RouteMatch,
  ): Omit<BoundaryDescriptor, "hasLoad"> | undefined => {
    const boundaries = routeHooks[sourceRouteId]?.boundaries ?? []
    const pathname = pathnameOf(path)
    for (const boundary of boundaries) {
      if (typeof boundary.mode === "string") continue
      const pattern = boundary.mode.intercept
      if (
        pattern.length === 0 ||
        pattern.length > 2048 ||
        !pattern.startsWith("/") ||
        pattern.startsWith("//")
      )
        continue
      let matcher = interceptMatchers.get(pattern)
      if (matcher === undefined) {
        try {
          matcher = createMatcher([{ routeId: "__nifra_intercept__", pattern }])
        } catch {
          matcher = null
        }
        interceptMatchers.set(pattern, matcher)
      }
      if (matcher?.(pathname)?.routeId === "__nifra_intercept__") return boundary
    }
    // Keep `target` in the signature so the caller cannot accidentally install an interceptor for an
    // unmatched route; the match is intentionally performed before this helper is called.
    void target
    return undefined
  }
  /**
   * Fetch a route's data and normalise it.
   *
   * The payload is either the versioned envelope (a chain with layout loaders) or the bare loader
   * value (everything else, and every response written before layout loaders existed). Deciding by
   * structure rather than by version-of-the-deploy is what lets a prerendered `_data.json` written by
   * an older build be read by newer client code.
   */
  type LoadedRouteData = {
    readonly serverComponents?: import("./server-components/types.ts").ComponentState | undefined
    readonly data: unknown
    readonly layoutData?: readonly unknown[] | undefined
    readonly terminalRouteId?: string | undefined
    readonly boundaries?: BoundaryStates
    readonly live?: unknown
    /** The response text this was read from, when it was plain JSON. */
    readonly text?: string | undefined
  }
  const dataFields = (value: LoadedRouteData) => ({
    data: value.data,
    layoutData: value.layoutData,
    serverComponents: value.serverComponents,
    live: value.live,
    ...(value.boundaries === undefined ? {} : { boundaries: value.boundaries }),
  })
  // The path the page on screen was loaded from. While a boundary holds an intercepted target, `path`
  // is that target's URL, so anything that reloads or caches the page must read this instead.
  const pagePathOf = (current: RouterState): string => current.intercepted?.pagePath ?? current.path
  // `boundaries` with `name` holding a target's outcome. The URL names one target, so every other
  // intercept boundary goes back to unresolved. A target that answered with a status, or failed, is
  // an error state: its data never reaches the boundary.
  const holdTarget = (
    boundaries: BoundaryStates | undefined,
    descriptor: Omit<BoundaryDescriptor, "hasLoad">,
    outcome: LoadedRouteData | undefined,
  ): BoundaryStates => {
    const next: Record<string, BoundaryState> = {}
    for (const [name, boundary] of Object.entries(boundaries ?? {})) {
      next[name] =
        typeof boundary.mode === "string" || name === descriptor.name
          ? boundary
          : {
              name: boundary.name,
              mode: boundary.mode,
              status: "unresolved",
              ...(boundary.errorId === undefined ? {} : { errorId: boundary.errorId }),
            }
    }
    const base = {
      name: descriptor.name,
      mode: descriptor.mode,
      ...(descriptor.errorId === undefined ? {} : { errorId: descriptor.errorId }),
    }
    next[descriptor.name] =
      outcome === undefined || outcome.terminalRouteId !== undefined
        ? { ...base, status: "error", error: { name: "Error", message: "Boundary failed" } }
        : { ...base, status: "ready", data: outcome.data, live: outcome.live }
    return next
  }
  // `boundaries` with `name`'s action result set (or cleared, for `undefined`). Only a boundary showing
  // its target's data carries one.
  const withActionData = (
    boundaries: BoundaryStates | undefined,
    name: string,
    actionData: unknown,
  ): BoundaryStates | undefined => {
    const held = boundaries?.[name]
    if (held === undefined || held.status !== "ready") return boundaries
    const { actionData: _previous, ...rest } = held
    return { ...boundaries, [name]: actionData === undefined ? rest : { ...rest, actionData } }
  }
  const loadRouteData = async (
    path: string,
    match: { routeId: string; params: Record<string, string> },
    signal?: AbortSignal,
    // Offer the server the layout data on screen: it re-runs whichever of those loaders it must.
    keepLayouts?: boolean,
    purpose?: "prefetch",
    hosts?: readonly string[],
    // What this path shows, when this is a reload of it: the same response text again is that, unparsed.
    shown?: LoadedRouteData,
  ): Promise<LoadedRouteData> => {
    const retainFrom = keepLayouts
      ? state.layoutData && { path: pagePathOf(state), layoutData: state.layoutData }
      : undefined
    const retain = retainFrom?.layoutData.map((_, index) => index) ?? []
    const hooks = routeHooks[match.routeId]
    // A client loader's output is not what the text says, and an opted-out route takes fresh data.
    const read: DataText = {
      previous:
        hooks?.clientLoader === undefined && hooks?.shareData !== false ? shown?.text : undefined,
    }
    const payload = await fetchData(
      path,
      match,
      signal,
      retainFrom === undefined ? undefined : { from: retainFrom.path, retain },
      purpose,
      hosts,
      read,
    )
    if (shown !== undefined && payload === read) return shown
    const text = read.text
    if (!isRouteDataEnvelope(payload)) return { data: payload, text }
    if (payload.status !== undefined) {
      const terminalRouteId = options.statusRoutes?.[payload.status] ?? options.statusRoutes?.[404]
      if (terminalRouteId === undefined) {
        throw new Error(
          `[nifra/web] no client status boundary is available for terminal status ${payload.status}`,
        )
      }
      return { data: null, terminalRouteId }
    }
    let layoutData = payload.layoutData
    if (retainFrom !== undefined && payload.retained !== undefined) {
      const retained = new Set(
        payload.retained.filter(
          (index) => Number.isInteger(index) && index >= 0 && index < retainFrom.layoutData.length,
        ),
      )
      layoutData = layoutData?.map((value, index) =>
        retained.has(index) ? retainFrom.layoutData[index] : value,
      )
    }
    return {
      data: payload.data,
      layoutData,
      serverComponents: payload.serverComponents,
      live: payload.live,
      ...(payload.boundaries !== undefined ? { boundaries: payload.boundaries } : {}),
      text,
    }
  }
  // A reload with every part equal to what its path shows replaced by that part, so what the reload
  // did not change keeps its identity on screen (`shareData`), unless the route exports
  // `shareData = false`.
  const shareShown = (
    routeId: string,
    shown: LoadedRouteData,
    loaded: LoadedRouteData,
  ): LoadedRouteData => {
    if (loaded.terminalRouteId !== undefined || routeHooks[routeId]?.shareData === false)
      return loaded
    // Parsed JSON is a tree; a client loader/custom transport can return cyclic or aliased data.
    const plainJson = loaded.text !== undefined && routeHooks[routeId]?.clientLoader === undefined
    return {
      ...loaded,
      data: shareData(shown.data, loaded.data, plainJson),
      layoutData: shareData(shown.layoutData, loaded.layoutData, plainJson),
      serverComponents: shareData(shown.serverComponents, loaded.serverComponents, plainJson),
      ...(loaded.boundaries === undefined
        ? {}
        : { boundaries: shareData(shown.boundaries, loaded.boundaries, plainJson) }),
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
      // An action posted to the target an intercept boundary holds belongs to that target.
      serverLoader: async () =>
        state.intercepted !== undefined && pathnameOf(action) === pathnameOf(state.path)
          ? state.boundaries?.[state.intercepted.boundary]?.data
          : state.data,
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
    const mine = ++generation
    navAbort?.abort()
    const ac = new AbortController()
    navAbort = ac
    const initial = dataFields(state)
    const loaded = await applyClientLoader(
      state.path,
      route,
      ac.signal,
      () => Promise.resolve(initial),
      initial,
    )
    if (mine !== generation) return
    // No terminal status can arrive here: the server already rendered this route (a status page
    // included) and its data is the only server result the client loader sees.
    state = { ...state, ...dataFields(loaded) }
    emit()
  }
  let state = options.initial
  // The page as last published from a load, with the response text it was read from. Every publish of
  // page data replaces it, and a reload reuses it only for the same text, which says the same.
  let shownPage: LoadedRouteData | undefined
  const listeners = new Set<() => void>()
  let generation = 0
  // Snapshot listeners to defend against accidental un/subscribe during notification. The adapters
  // don't do this (un/subscribe runs in effect/cleanup ticks), so the overhead is negligible
  // (5-20 listeners typically), and the defensiveness is valuable.
  const emit = (): void => {
    if (listeners.size === 0) return
    for (const listener of [...listeners]) listener()
  }
  // Bounded one-shot prefetch cache (path → loader data, and when it arrived) + an in-flight guard so
  // hover spam doesn't double-fetch. Consumed (and dropped) by the next navigate to that path - while
  // fresh: a link warmed as it scrolled into view can be clicked minutes later.
  const MAX_PREFETCH = 10
  const PREFETCH_MAX_AGE_MS = 30_000
  // path -> [data, when it arrived, the identity epoch it was loaded under]
  const prefetched = new Map<string, readonly [LoadedRouteData, number, string]>()
  // path -> the token of the prefetch loading it; a prefetch stores what it read only while its
  // token is still there, so dropping the token discards a load that started before the drop.
  const inflight = new Map<string, object>()
  // Read without the DOM types: this module also builds in tsconfigs that leave the DOM lib out.
  const readEpoch = (): string => {
    const cookie: unknown = Reflect.get(Reflect.get(globalThis, "document") ?? {}, "cookie")
    return typeof cookie === "string" ? epochOf(cookie) : ""
  }
  const freshPrefetch = (path: string): LoadedRouteData | undefined => {
    const held = prefetched.get(path)
    return held !== undefined &&
      Date.now() - held[1] < PREFETCH_MAX_AGE_MS &&
      held[2] === readEpoch()
      ? held[0]
      : undefined
  }
  // Warmed data was loaded before a mutation or for the previous visitor, so either one drops all of
  // it, along with what a prefetch still in flight read.
  const dropPrefetched = (): void => {
    inflight.clear()
    prefetched.clear()
  }
  onIdentityChange(dropPrefetched)
  if (typeof BroadcastChannel !== "undefined")
    new BroadcastChannel(IDENTITY_CHANNEL).addEventListener("message", dropPrefetched)
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
    if (loaded.serverComponents !== undefined) {
      cache.delete(path)
      return
    }
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
      prefetched.delete(p)
      inflight.delete(p)
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

  // The route path an in-app redirect target leads to. Undefined when the browser has to load it: another
  // origin, a `#fragment` to scroll to, or no route.
  const appRedirect = (to: string | undefined): readonly [string, RouteMatch] | undefined => {
    if (to === undefined || !to.startsWith("/") || to.includes("#")) return undefined
    const url = targetUrl(to)
    if (url?.host !== "n.invalid") return undefined // `//host`, `/\host`, unparseable
    const path = url.pathname + url.search
    const target = match(path)
    return target === null ? undefined : [path, target]
  }

  // Load the status route a terminal answer for `at` renders. One inside layouts needs those layouts'
  // loaders, which only a document request runs, so the caller loads `at` as a document instead.
  const loadTerminal = async (routeId: string, at: string): Promise<void> => {
    await loadModule?.(routeId, at)
    if (options.layoutStatusRoutes?.[routeId] === true) {
      throw new Error(`[nifra/web] ${routeId} renders inside layouts; loading ${at} as a document`)
    }
  }

  // Load `path` for the navigation or submit `mine`, following the redirects its loaders answer with
  // while they stay in the app (20 at most, as a browser allows).
  const loadFollowing = async (
    mine: number,
    path: string,
    target: RouteMatch,
    signal: AbortSignal,
    keepLayouts: boolean,
    usePrefetch: boolean,
  ): Promise<readonly [string, RouteMatch, LoadedRouteData]> => {
    let current: readonly [string, RouteMatch] = [path, target]
    for (let hops = 0; ; hops++) {
      const [at, route] = current
      if (mine === generation && state.pendingPath !== at) {
        state = { ...state, pendingPath: at }
        emit()
      }
      await loadModule?.(route.routeId, at)
      // Prefetched server data is one-shot; a clientLoader still runs over it without another request.
      const prefetchedData = usePrefetch ? freshPrefetch(at) : undefined
      if (usePrefetch) prefetched.delete(at)
      try {
        const loaded = await applyClientLoader(
          at,
          route,
          signal,
          () => loadRouteData(at, route, signal, keepLayouts),
          prefetchedData,
        )
        if (loaded.terminalRouteId !== undefined) await loadTerminal(loaded.terminalRouteId, at)
        return [at, route, loaded]
      } catch (error) {
        const next = hops < 20 ? appRedirect(redirectOf(error)) : undefined
        if (next === undefined) throw error
        current = next
      }
    }
  }

  // Reload what is on screen: the page under its own path when `page`, and, while an intercept boundary
  // holds a target, that target under its URL when `target`. The part not reloaded is kept as shown.
  // Returns the fields to publish, both parts together. `route` is set when the page's reload names
  // another route - the status route it answered with, or, on a status page, its URL's own route
  // answering again - which then replaces the page and any boundary over it, so data is only ever
  // rendered by the route it was loaded for. A target that fails becomes its
  // boundary's error state rather than failing the page, as a dynamic boundary's load does. Nothing is
  // cached once `mine` is superseded: a newer action's reload owns the cache.
  const reloadActive = async (
    signal: AbortSignal,
    page: boolean,
    target: boolean,
    mine: number,
  ): Promise<{
    readonly fields: ReturnType<typeof dataFields>
    readonly route?: { readonly routeId: string; readonly params: Record<string, string> }
  }> => {
    const pagePath = pagePathOf(state)
    const intercepted = state.intercepted
    const targetPath = state.path
    // The route the page's URL matches: the one on screen, except on a status page.
    const pageRoute = match(pagePath) ?? { routeId: state.routeId, params: state.params }
    const rematched = pageRoute.routeId !== state.routeId
    const targetRoute = intercepted !== undefined && target ? match(targetPath) : null
    // The page's own route shares with what the page shows; a status page answered by its URL's route
    // has nothing of that route on screen.
    const shown = rematched ? undefined : (shownPage ?? state)
    const shownTarget = { data: intercepted && state.boundaries?.[intercepted.boundary]?.data }
    // A hole on screen that is a host stays one: it reloads as a fill.
    const hosts = rematched
      ? []
      : Object.values(state.boundaries ?? {})
          .filter((held) => held.ppr === true)
          .map((held) => held.name)
    const [reloaded, targetOutcome] = await Promise.all([
      page
        ? (async (): Promise<LoadedRouteData> => {
            if (rematched) await loadModule?.(pageRoute.routeId, pagePath)
            const loaded = await applyClientLoader(pagePath, pageRoute, signal, () =>
              loadRouteData(
                pagePath,
                pageRoute,
                signal,
                false,
                undefined,
                hosts.length === 0 ? undefined : hosts,
                shown,
              ),
            )
            return shown === undefined ? loaded : shareShown(pageRoute.routeId, shown, loaded)
          })()
        : undefined,
      targetRoute === null
        ? undefined
        : (async (): Promise<LoadedRouteData | undefined> => {
            try {
              await loadModule?.(targetRoute.routeId, targetPath)
              const outcome = shareShown(
                targetRoute.routeId,
                shownTarget,
                await applyClientLoader(targetPath, targetRoute, signal, () =>
                  loadRouteData(targetPath, targetRoute, signal),
                ),
              )
              if (mine === generation) cachePut(targetPath, outcome)
              return outcome
            } catch {
              return undefined
            }
          })(),
    ])
    if (reloaded?.terminalRouteId !== undefined)
      await loadTerminal(reloaded.terminalRouteId, pagePath)
    if (reloaded !== undefined && mine === generation) {
      cachePut(pagePath, reloaded)
      shownPage = reloaded
    }
    const fields = dataFields(reloaded ?? state)
    if (reloaded?.terminalRouteId !== undefined)
      return { fields, route: { routeId: reloaded.terminalRouteId, params: {} } }
    if (reloaded !== undefined && rematched) return { fields, route: pageRoute }
    if (intercepted === undefined) return { fields }
    const held = state.boundaries?.[intercepted.boundary]
    if (held === undefined) return { fields }
    if (targetRoute === null)
      return {
        fields: {
          ...fields,
          boundaries: { ...(fields.boundaries ?? {}), [intercepted.boundary]: held },
        },
      }
    // A reload keeps the result of the last action posted to the target, as the page keeps its own.
    const boundaries = withActionData(
      holdTarget(fields.boundaries, held, targetOutcome),
      intercepted.boundary,
      held.actionData,
    )
    return { fields: { ...fields, ...(boundaries === undefined ? {} : { boundaries }) } }
  }

  // Refetch what is on screen + republish, single-flight via the shared `generation`. Shared by
  // `invalidate` and targeted revalidation: `inScope` says which paths to refresh, and a page or held
  // target outside it is kept. Rejects if the page's fetch fails (clearing its own `pending` first).
  const refetchActive = async (inScope?: (path: string) => boolean): Promise<void> => {
    const page = inScope === undefined || inScope(pagePathOf(state))
    const target = state.intercepted !== undefined && (inScope === undefined || inScope(state.path))
    if (!page && !target) return
    const mine = ++generation
    navAbort?.abort()
    const ac = new AbortController()
    navAbort = ac
    state = { ...state, pending: true }
    emit()
    try {
      const { fields, route } = await reloadActive(ac.signal, page, target, mine)
      if (mine !== generation) return // superseded - drop the stale result
      // A terminal answer for the page (the session expired, the record is gone) replaces it, and any
      // boundary over it, with its status route, as a navigation to this URL would.
      state =
        route === undefined
          ? { ...state, ...fields, pending: false }
          : {
              routeId: route.routeId,
              params: route.params,
              path: state.path,
              ...fields,
              actionData: undefined,
              pending: false,
            }
      emit()
    } catch (err) {
      if (mine === generation) {
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
    if (!skipActive) jobs.push(refetchActive((path) => paths.includes(path)).catch(() => {}))
    for (const entry of fetchers.values()) jobs.push(entry.refreshIfShowing(paths))
    await Promise.all(jobs)
  }

  const createFetcher = (): FetcherEntry => {
    let fState: FetcherState = { pending: false, data: undefined }
    let fGeneration = 0
    let fAbort: AbortController | undefined
    let loadedPath: string | undefined
    // `data` as loaded, with the response text it was read from.
    let shown: LoadedRouteData | undefined
    const fListeners = new Set<() => void>()
    const fEmit = (): void => {
      if (fListeners.size > 0) for (const l of [...fListeners]) l() // snapshot for defensiveness
      emitFetchers()
    }
    const runLoad = async (path: string): Promise<void> => {
      const matched = match(path)
      if (matched === null) return // unmatched path → no-op
      const mine = ++fGeneration
      fAbort?.abort()
      const ac = new AbortController()
      fAbort = ac
      fState = { ...fState, pending: true }
      fEmit()
      try {
        // Loading the path again is a reload of what this fetcher shows.
        const before = path === loadedPath ? shown : undefined
        const [, fresh] = await Promise.all([
          loadModule?.(matched.routeId),
          loadRouteData(path, matched, ac.signal, false, undefined, undefined, before),
        ])
        if (mine !== fGeneration) return // a newer load/submit on THIS fetcher superseded us
        const loaded = before === undefined ? fresh : shareShown(matched.routeId, before, fresh)
        shown = loaded
        // Record the loaded path only on SUCCESS - a thrown or superseded load must not
        // leave `loadedPath` pointing at a path this fetcher never actually showed, or a later
        // `X-Nifra-Revalidate` for it would spuriously refetch onto unexpected data.
        loadedPath = path
        cachePut(path, loaded)
        fState = { ...fState, data: loaded.data, pending: false }
        fEmit()
      } catch (err) {
        if (mine === fGeneration) {
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
        const mine = ++fGeneration
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
          const res = await fetch(appUrl(action), {
            method: "POST",
            body,
            headers: { [DATA_HEADER]: "1" },
          })
          dropPrefetched()
          if (!res.ok)
            throw new Error(`[nifra/web] fetcher action failed (${res.status}): ${action}`)
          const actionData = res.status === 204 ? undefined : await readResponseData(res, ac.signal)
          const changed = parseRevalidate(res.headers.get(REVALIDATE_HEADER))
          if (mine !== fGeneration) return
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
          if (mine === fGeneration) {
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
      // The target an open boundary already shows (a `#fragment` entry inside it, a link to itself):
      // reloading it would rebuild the boundary and drop its action result. One in its error state
      // loads again, so a link can retry it.
      if (
        state.intercepted !== undefined &&
        state.boundaries?.[state.intercepted.boundary]?.status === "ready" &&
        !state.pending &&
        path === state.path
      ) {
        emit()
        return
      }
      // Client-only search fast path: same route + same pathname, and every changed search key is
      // declared client-only. Publish the new URL (so `useSearch`/`useLocation` update) WITHOUT a data
      // fetch - the loader's inputs did not change. Any loader-affecting key change falls through to the
      // normal match → fetch → publish below, so data is never stale. Abort an in-flight fetch first: a
      // rapid `?tab` after a real nav must not let the older fetch overwrite this synchronous update.
      if (
        state.intercepted === undefined &&
        matched.routeId === state.routeId &&
        pathnameOf(path) === pathnameOf(state.path) &&
        isClientOnlySearchChange(
          rawSearchOf(state.path),
          rawSearchOf(path),
          searchClientKeys[state.routeId] ?? [],
        )
      ) {
        ++generation // supersede any in-flight navigation so its late result is dropped
        navAbort?.abort()
        cachePut(path, dataFields(state))
        state = { ...state, path, pending: false, pendingPath: undefined }
        emit()
        return
      }
      const mine = ++generation
      navAbort?.abort() // abandon any in-flight navigation's stream
      const ac = new AbortController()
      navAbort = ac
      state = { ...state, pending: true, pendingPath: path }
      emit()
      try {
        const [to, target, loaded] = await loadFollowing(mine, path, matched, ac.signal, true, true)
        if (mine !== generation) return // a newer navigation superseded this one - drop the stale result
        cachePut(to, loaded) // keep the keyed cache coherent with what we publish
        // The page's own URL is never intercepted: navigating there (Back out of a boundary, a link
        // to itself) shows the page, even when a boundary's pattern matches it.
        const pagePath = pagePathOf(state)
        const interception =
          loaded.terminalRouteId === undefined && pathnameOf(to) !== pathnameOf(pagePath)
            ? interceptionFor(state.routeId, to, target)
            : undefined
        if (interception !== undefined) {
          // The target's ordinary data request has already completed (including its server authz and
          // optional client wrapper). Only the presentation route is retained; the current page stays
          // mounted underneath the named slot. A target that returned a terminal status never reaches
          // this branch, so an unauthorized/missing target cannot become a modal.
          state = {
            ...state,
            path: to,
            boundaries: holdTarget(state.boundaries, interception, loaded),
            intercepted: { boundary: interception.name, pagePath },
            pending: false,
            pendingPath: undefined,
          }
          emit()
          return
        }
        state = {
          routeId: loaded.terminalRouteId ?? target.routeId,
          params: loaded.terminalRouteId === undefined ? target.params : {},
          path: to,
          ...dataFields(loaded),
          actionData: undefined, // a fresh navigation has no action result
          pending: false,
        }
        shownPage = loaded
        emit()
      } catch (err) {
        // Clear our pending flag + target (only if still current) and rethrow - the caller decides how
        // to recover (the history layer falls back to a full-page navigation).
        if (mine === generation) {
          state = { ...state, pending: false, pendingPath: undefined }
          emit()
        }
        throw err
      }
    },
    submit: async (action, body, opts) => {
      const mine = ++generation
      const previousActionData = state.actionData
      // An action posted to the target an intercept boundary holds answers that boundary, not the page.
      const actionBoundary =
        state.intercepted !== undefined && pathnameOf(action) === pathnameOf(state.path)
          ? state.intercepted.boundary
          : undefined
      const previousBoundaryActionData =
        actionBoundary === undefined ? undefined : state.boundaries?.[actionBoundary]?.actionData
      // The state with `value` as the action's result, on whichever owns the action.
      const answered = (
        current: { readonly boundaries?: BoundaryStates | undefined },
        value: unknown,
      ): Partial<RouterState> => {
        if (actionBoundary === undefined) return { actionData: value }
        const boundaries = withActionData(current.boundaries, actionBoundary, value)
        return boundaries === undefined ? {} : { boundaries }
      }
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
      // Once the action has run, falling back to posting the form again would run it twice.
      let posted = false
      let landing: string | undefined
      try {
        const prepared = await prepareClientAction(action, body, ac.signal)
        if (Object.hasOwn(prepared, "optimisticData")) {
          state = { ...state, ...answered(state, prepared.optimisticData) }
          emit()
        }
        const res = await fetch(appUrl(action), {
          method: "POST",
          body: prepared.body,
          headers: { [DATA_HEADER]: "1" },
        })
        // Whatever the status, the server took the POST: the action may have run before it failed.
        posted = true
        dropPrefetched()
        if (!res.ok) throw new Error(`[nifra/web] action failed (${res.status}): ${action}`)
        const redirectTo = res.headers.get(REDIRECT_HEADER)
        if (redirectTo !== null) {
          // The action redirected (Post/Redirect/Get) - treat it as a client navigation.
          const next = appRedirect(redirectTo)
          if (next === undefined) throw redirected(redirectTo)
          landing = next[0]
          // The action may have changed what any layout shows, so the target loads its whole chain,
          // the same as the non-redirect revalidation below. `revalidate: false` keeps layout data
          // the server agrees is unchanged, like an ordinary navigation.
          const [to, target, loaded] = await loadFollowing(
            mine,
            next[0],
            next[1],
            ac.signal,
            opts?.revalidate === false,
            false,
          )
          if (mine !== generation) return
          cachePut(to, loaded)
          state = {
            routeId: loaded.terminalRouteId ?? target.routeId,
            params: loaded.terminalRouteId === undefined ? target.params : {},
            path: to,
            ...dataFields(loaded),
            actionData: undefined,
            pending: false,
          }
          shownPage = loaded
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
        // Revalidate what is on screen so the mutation is reflected - the page, and a target an
        // intercept boundary holds - unless the caller opted out (`revalidate: false`). A
        // server-declared revalidate of a path on screen overrides the opt-out (the server says it
        // changed, so stale data would be wrong). Default is to revalidate.
        const pagePath = pagePathOf(state)
        const reloadPage = opts?.revalidate !== false || changed.includes(pagePath)
        const reloadTarget =
          state.intercepted !== undefined &&
          (opts?.revalidate !== false || changed.includes(state.path))
        const { fields, route } = await reloadActive(ac.signal, reloadPage, reloadTarget, mine)
        if (mine !== generation) return
        // Mark the OTHER changed routes stale so the next access refetches.
        markStale(changed.filter((p) => p !== pagePath && (!reloadTarget || p !== state.path)))
        // Reconcile: publish the revalidated data + actionData; omit `submission` (the optimistic
        // window is over - the real data now drives the view). A reload that names another route (a
        // terminal answer for the page) renders it in the page's place, closing any boundary, and the
        // action's result goes with the page.
        state =
          route === undefined
            ? {
                routeId: state.routeId,
                params: state.params,
                path: state.path,
                ...fields,
                actionData: previousActionData,
                ...answered(fields, actionData),
                pending: false,
                ...(state.intercepted === undefined ? {} : { intercepted: state.intercepted }),
              }
            : {
                routeId: route.routeId,
                params: route.params,
                path: state.path,
                ...fields,
                actionData: undefined,
                pending: false,
              }
        emit()
        // Refresh any mounted fetcher showing one of the changed routes (the active route was just
        // revalidated inline above, so skip it here). Best-effort - never rejects the submit.
        await refreshMounted(changed, true)
      } catch (err) {
        if (mine === generation) {
          // Revert: clear `submission` (the optimistic view vanishes) leaving the data untouched, so the
          // pre-submit page shows through.
          state = {
            routeId: state.routeId,
            params: state.params,
            path: state.path,
            ...dataFields(state),
            actionData: previousActionData,
            ...(actionBoundary === undefined
              ? {}
              : answered(dataFields(state), previousBoundaryActionData)),
            pending: false,
            ...(state.intercepted === undefined ? {} : { intercepted: state.intercepted }),
          }
          emit()
        }
        if (!posted) throw err
        if (mine !== generation) return // a newer navigation or submit owns the page
        // Otherwise show the route that owns the action, as a native post to it would.
        const owner = actionBoundary === undefined ? pagePathOf(state) : state.path
        throw redirectOf(err) === undefined ? redirected(landing ?? owner, err) : err
      }
    },
    hydrate,
    invalidate: async (paths) => {
      // Mark targeted cache entries stale (all entries when no `paths`) - unmounted ones refetch
      // lazily on next access. A warmed prefetch of a target is dropped: it would show the old data.
      const targets = paths ?? [...cache.keys()]
      markStale(targets)
      if (paths === undefined) dropPrefetched()
      // Refresh mounted readers now: the active route (when in scope - an explicit list including it,
      // or an invalidate-all) + any fetcher showing a targeted path. The active refetch rejects on
      // failure (the caller asked to refresh); fetcher refreshes are best-effort (swallowed).
      const jobs: Promise<void>[] = []
      jobs.push(refetchActive(paths === undefined ? undefined : (path) => paths.includes(path)))
      for (const entry of fetchers.values()) jobs.push(entry.refreshIfShowing(targets))
      await Promise.all(jobs)
    },
    prefetch: async (path) => {
      if (inflight.has(path) || freshPrefetch(path) !== undefined) return
      const matched = match(path)
      if (matched === null) return
      const token = {}
      inflight.set(path, token)
      const epoch = readEpoch()
      try {
        // Unwrapped here, so a prefetched entry is the same shape `navigate` builds state from -
        // otherwise a prefetch hit would publish an envelope where a miss publishes loader data.
        const [, loaded] = await Promise.all([
          loadModule?.(matched.routeId, path),
          loadRouteData(path, matched, undefined, false, "prefetch"),
        ])
        prefetched.delete(path) // a stale entry re-enters as the newest
        if (prefetched.size >= MAX_PREFETCH) {
          const oldest = prefetched.keys().next().value
          if (oldest !== undefined) prefetched.delete(oldest)
        }
        // A prefetched hole is an empty host nothing fills; the navigation fetches it, cancellably.
        const holes = Object.values(loaded.boundaries ?? {}).some((state) => state.ppr === true)
        if (
          loaded.serverComponents === undefined &&
          !holes &&
          inflight.get(path) === token &&
          epoch === readEpoch()
        )
          prefetched.set(path, [loaded, Date.now(), epoch])
      } catch {
        // Best-effort: a failed prefetch just means the eventual navigate fetches normally.
      } finally {
        if (inflight.get(path) === token) inflight.delete(path)
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
