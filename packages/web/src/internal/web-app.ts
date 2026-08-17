import {
  type BackendMount,
  type BackendMountHandler,
  NIFRA_BACKEND_MOUNT,
} from "@nifrajs/core/mount"
import { type ServerOptions, server, type UrlParts, urlPartsOf } from "@nifrajs/core/server"
import {
  type BoundaryRequestCtx,
  type BoundaryStates,
  boundaryDescriptors,
  resolveStaticBoundaries,
  startDynamicBoundaries,
} from "../boundary.ts"
import { defer, ndjsonStream, prepareDeferred } from "../deferred.ts"
import { isDraftEnabled } from "../draft.ts"
import { generateLlmsTxt } from "../llms-txt.ts"
import type {
  LayoutEntry,
  LoaderContext,
  Manifest,
  Meta,
  MetaArgs,
  RouteEntry,
  RouteModule,
} from "../manifest.ts"
import type { RenderAdapter } from "../render-seam.ts"
import {
  createMatcher,
  DATA_HEADER,
  NAV_FROM_HEADER,
  RETAIN_HEADER,
  REVALIDATE_HEADER,
  STATUS_HEADER,
} from "../router.ts"
import { searchOf, searchOfChain } from "../search.ts"
import { mergeHeads, resolveMeta } from "./head-merge.ts"
import {
  actionResponse,
  EMPTY_RETAIN,
  type HeadersLike,
  isControlFlow,
  isStatusSignal,
  type LoadedLayoutModules,
  layoutErrorId,
  type RenderAssemblyCache,
  type RenderedPage,
  type RevalidateResult,
  renderPageResult,
  STATUS_SIGNAL,
  STATUS_TEXT,
  type StatusSignal,
  scopeParams,
  tagLayoutError,
  withDuplicateInstanceHint,
} from "./render-document.ts"
export interface CreateWebAppOptions<Env = unknown> {
  readonly adapter: RenderAdapter
  readonly manifest: Manifest
  /** URL of the built client entry (module script) injected into every page. */
  readonly clientEntry: string
  /** Default document title for all pages. */
  readonly title?: string
  /**
   * Options for the underlying `server()` - `requestTimeoutMs`, `admission`, `gracefulSignals`, and
   * the rest of {@link ServerOptions}.
   *
   * Needed because the `Server` is constructed in here, so a caller has no other way to reach its
   * constructor: a page app could set no request timeout and no capacity gate, which are exactly the
   * two knobs a production readiness check looks for. An SSR app wants them MORE than a backend does -
   * a render is slow and allocation-heavy, so a burst that a JSON API would absorb is the one that
   * exhausts the pod.
   *
   * Applies to the whole app, {@link mounts} and the {@link api} auto-mount included: the capacity gate
   * sits at the fetch entry, ahead of the request hooks those are dispatched from.
   */
  readonly server?: ServerOptions
  /**
   * Runs against the app BEFORE any page route is registered - the seam for `securityHeaders()`,
   * `requestId()`, `logger()`, a rate limit, or anything else applied with `use`.
   *
   * ```ts
   * createWebApp({
   *   …,
   *   use: (app) => {
   *     app.use(securityHeaders())
   *     app.use(requestId())
   *   },
   * })
   * ```
   *
   * A callback rather than an array because `use` is overloaded - `Middleware`, `IdentityPlugin`,
   * `ContextPlugin` - and only the real call site instantiates the right overload. The return value
   * is ignored: this is for cross-cutting concerns, not for declaring routes (declare those on the
   * returned app, where they get their types).
   *
   * **Why the timing matters.** `beforeHandle`, `afterHandle`, `around`, `derive`/`decorate`, and
   * `onError` are snapshotted into each route AS IT IS DECLARED, and `createWebApp` declares every
   * page (plus the `/*` catch-all) before it returns - so a caller's `app.use(…)` afterwards binds
   * them to nothing, silently. `requestId()` is exactly that case: it is a `derive`, so applied late
   * it leaves every page without `c.requestId`. Route assurance evidence is order-scoped the same
   * way, so a late `securityHeaders()` leaves the pages unable to PROVE the header to `nifra assure`
   * even though it does still set it.
   *
   * `onRequest`/`onResponse` (and the response header/body hooks) are app-global arrays read at
   * request time, so those alone DO work when added late. Using this seam for everything avoids
   * having to remember which is which.
   *
   * Runs ahead of the {@link mounts} / {@link api} request hooks, so an `onRequest` middleware guards
   * a mounted auth handler too.
   *
   * A `ContextPlugin` applied here takes runtime effect but cannot widen the declared return type of
   * this function, so `c.requestId` is not typed on routes you declare afterwards. Named plugins are
   * idempotent, so `app.use(requestId())` on the returned app recovers the TYPE without applying the
   * plugin a second time.
   */
  readonly use?: (app: ReturnType<typeof server<Env>>) => void
  /** Injected into each loader's `ctx.api` - typically an `inProcessClient(app)` (typed
   * per-route via `@nifrajs/client`'s `createRoutes`). Opaque to the core.
   *
   * **Auto-mount.** Every `inProcessClient(backend)` exposes the symbol-keyed platform-aware backend
   * mount interface from `@nifrajs/core/mount`; `createWebApp` also serves that backend over HTTP at
   * {@link apiPrefix} (default `/api`): a request whose pathname starts with the prefix is dispatched
   * before page routing with the same `env`/`waitUntil` platform context, and the backend's `Response`
   * is returned untouched. The mount runs in `nifra dev` too. Pass `apiPrefix: ""` to disable it. */
  readonly api?: unknown
  /** HTTP path prefix the {@link api} backend is auto-mounted at (default `"/api"`). A request whose
   * pathname is exactly the prefix or starts with `prefix + "/"` is dispatched to the backend before
   * page routing; the backend therefore defines its routes at the **full** path (`server().post("/api/
   * sync", …)`), matching the in-process `inProcessClient` call sites. Set to `""` to disable the
   * auto-mount entirely (the app serves pages only and `api` stays a loader-only `ctx.api`). Mounting
   * is also a no-op when `api` does not expose the symbol mount. */
  readonly apiPrefix?: string
  /**
   * Strip {@link apiPrefix} from the pathname before dispatching to `api` (default `false`).
   *
   * The default suits a backend that declares FULL paths (`server().post("/api/sync", …)`), which is
   * right when it is only ever mounted here. Set this when the backend declares its routes WITHOUT the
   * prefix because it also runs standalone behind its own shell, so its paths cannot carry a prefix that
   * only exists when it is mounted. Without it every request 404s inside the backend, and the workaround
   * is a `Proxy` that rewrites each URL.
   */
  readonly apiStrip?: boolean
  /**
   * Sub-apps mounted ahead of page routing - an auth handler, a webhook receiver, a stack's routes.
   *
   * Structural on purpose: anything with `{ path, app: { fetch } }` fits, so a library that exposes its
   * routes as such a list mounts as `mounts: theirRoutes` without `@nifrajs/web` taking a dependency on
   * it. `better-auth` is the motivating case - it is not a `backend` route, so `/api/auth/*` used to 404
   * silently.
   *
   * Tried longest-path-first and BEFORE the `api` mount, so a mount at `/api/auth` wins over a backend
   * at `/api` no matter which was declared first. `stripPrefix` is the per-mount form of {@link apiStrip}:
   * leave it off to pass the full path through.
   */
  readonly mounts?: ReadonlyArray<{
    readonly path: string
    readonly app: { fetch(request: Request): Response | Promise<Response> }
    readonly stripPrefix?: boolean
  }>
  /** Secret for **draft / preview mode** (see `enableDraft`). When set, a request carrying a valid
   * signed `__nifra_draft` cookie gets `ctx.draft === true` in loaders/actions (else always `false`).
   * Pair with `withISR({ draftSecret })` so editors bypass the cache. Omit to disable draft mode. */
  readonly draftSecret?: string
  /** Per-route chunk URLs (`buildClient`'s `BuildManifest.routes`) - `routeId → [layout chunks…, own
   * chunk]`. When present, each page `modulepreload`s its matched route's chunks alongside the entry,
   * so the route code downloads in parallel (no entry→route-chunk waterfall). Omit ⇒ entry-only. */
  readonly routePreload?: Readonly<Record<string, readonly string[]>>
  /** The app's bundled stylesheet URLs (`buildClient`'s `BuildManifest.css`) - the aggregate, injected
   * as `<link rel="stylesheet">` in a page's `<head>`. Used as the fallback for any route absent from
   * {@link routeStyles}. Omit ⇒ no links (dev, where Vite injects CSS, or a CSS-free app). */
  readonly styles?: readonly string[]
  /** Per-route stylesheet URLs (`buildClient`'s `BuildManifest.routeStyles`) - `routeId → [chain CSS]`.
   * When a matched route has an entry here, only those (its layout chain + own CSS) are linked instead
   * of the aggregate `styles`, so a page ships only the CSS it uses. An empty array ⇒ no `<link>` (the
   * page imports no CSS). Routes absent here fall back to `styles`. Omit ⇒ always use `styles`. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
  /** SSG: the prerendered-path set (e.g. `enumerateStaticRoutes(routes).paths` or the build's
   * `prerendered.json`). Injected as `window.__NIFRA_PRERENDERED__` on every page so a client soft-nav
   * into a prerendered route fetches its static `_data.json` instead of hitting the worker. */
  readonly prerenderedPaths?: readonly string[]
  /** Publish the project's `AGENTS.md` inside `/llms.txt` and `/llms-full.txt`. **Off by default**:
   * those endpoints are public and unauthenticated, while `AGENTS.md` is a repo file written for the
   * team - unreleased feature names, internal hostnames, and "don't touch X yet" notes live there
   * routinely. Turn it on only for a repo whose guidelines you would publish as a page. */
  readonly publishLocalGuidelines?: boolean
  /** SSG: per dynamic route pattern, its `getStaticPaths` `fallback` (from `enumerateStaticRoutes` or
   * the build's `prerendered.json`). A route mapped to `"404"` rejects any path NOT in
   * `prerenderedPaths` with the 404 page - the unlisted path simply doesn't exist. `"ssr"` (the
   * default for unmapped routes) renders unlisted paths on-demand. */
  readonly staticFallbacks?: Readonly<Record<string, "ssr" | "404">>
  /** In-memory reference cache for explicitly `static` boundary values. It never persists payloads
   * across processes; operated/durable cache implementations stay outside the public framework. */
  readonly staticBoundaryCache?: import("../boundary.ts").StaticBoundaryCache
  /** Observe every loader/action failure - for error-reporting plugins (Sentry-style). Called for
   * real throws (not control-flow `Response`s like `redirect`), **before** the nearest `_error`
   * boundary renders / a soft-nav 500 / a rethrow - so it sees errors that the boundary would
   * otherwise hide. Observation only; its own throws are swallowed so a faulty reporter can't break
   * rendering. (`beforeLoader` is intentionally omitted - the core HTTP hooks already cover
   * pre-request work.) */
  readonly onLoaderError?: (
    error: unknown,
    ctx: {
      readonly request: Request
      readonly params: Readonly<Record<string, string>>
      readonly route: string
    },
  ) => void
}

/** The handler context fields createWebApp uses - a structural subset of nifra's `Context`. */
interface RouteContext {
  readonly params: Record<string, string>
  readonly req: Request
  /** Platform bindings (Workers env), forwarded to each route's loader/action as `args.env`. */
  readonly env: unknown
}

/**
 * Re-issue `request` with `prefix` removed from its pathname.
 *
 * Needed because two conventions exist and both are reasonable. `createWebApp`'s auto-mount assumes a
 * backend that declares FULL paths (`server().post("/api/sync")`), which is right when the backend is
 * only ever mounted here. A backend that also runs standalone declares paths WITHOUT the prefix and
 * lets its own shell supply it - and mounting one of those here used to require the caller to wrap it
 * in a `Proxy` that rewrote every URL. Two apps wrote that same wrapper independently, which is the
 * signal that it belonged in the framework.
 *
 * The `Request` is rebuilt rather than mutated (`url` is read-only), preserving method, headers, body,
 * and duplex streaming - the body is passed through unread, so a large or streamed upload is untouched.
 */
function stripMountPrefix(request: Request, prefix: string): Request {
  const url = new URL(request.url)
  const rest = url.pathname.slice(prefix.length)
  url.pathname = rest === "" ? "/" : rest
  // `url.href`, not the `URL`: this type set only declares the string and Request overloads.
  return new Request(url.href, request)
}

/**
 * Resolve the explicit symbol-keyed backend mount interface. The symbol seam forwards platform
 * context without making web depend on client.
 */
function backendMountOf(api: unknown): BackendMountHandler | undefined {
  if ((typeof api !== "object" && typeof api !== "function") || api === null) return undefined
  const explicit = (api as Partial<BackendMount>)[NIFRA_BACKEND_MOUNT]
  if (typeof explicit !== "function") return undefined
  return (request, platform) => explicit.call(api, request, platform)
}

// `createWebApp` reaches the same Request object through the mount hook and the page route. Cache the
// allocation-light core split once so API mounting, path hydration, search parsing, and SSG fallback
// checks do not each rescan the absolute URL. WeakMap keeps this bounded to requests that are alive.
const REQUEST_URL_PARTS = new WeakMap<Request, UrlParts>()
const urlPartsFor = (request: Request): UrlParts => {
  const cached = REQUEST_URL_PARTS.get(request)
  if (cached !== undefined) return cached
  const parts = urlPartsOf(request.url)
  REQUEST_URL_PARTS.set(request, parts)
  return parts
}

/**
 * Build a nifra app from a route manifest: every route SSRs its layout chain via `renderPage`,
 * and a wildcard catch-all renders `_404` (or a plain 404). Reuses @nifrajs/core's router +
 * lifecycle, so matching, params, and precedence are battle-tested. fs-free - feed it a
 * manifest from `discoverRoutes` (`@nifrajs/web/fs`) at startup, so the served app stays portable.
 *
 * **Typed platform bindings.** Pass `Env` - `createWebApp<Env>({ … })` - to declare the app's Workers
 * bindings ONCE. It seeds the returned `Server`'s context with `{ env: Env }` (exactly as the backend's
 * `server<Env>()` does), so `app.fetch(req, { env })` / `toFetchHandler(app)` type-check the `env`
 * argument against the declared shape - no per-binding cast at the edge entry. Per-route loaders/actions
 * stay typed independently of this call: annotate them with `@nifrajs/client`'s `LoaderArgs<Api, Env>`
 * (same `Env`) so `ctx.env.MY_KV` is typed there too. Omit the parameter and `Env` is `unknown` - the
 * secure default; validate at the trust boundary before use.
 */
export function createWebApp<Env = unknown>(
  options: CreateWebAppOptions<Env>,
): ReturnType<typeof server<Env>> {
  const { adapter, manifest, clientEntry, title, api } = options
  const titleOption = title === undefined ? {} : { title }
  // Draft/preview: when a `draftSecret` is configured, each request's signed `__nifra_draft` cookie is
  // verified once and surfaced to loaders/actions as `ctx.draft`. No secret ⇒ always `false` (sync, free).
  const draftFlag = (req: Request): Promise<boolean> =>
    options.draftSecret === undefined
      ? Promise.resolve(false)
      : isDraftEnabled(req, options.draftSecret)
  // Per-route preload chunks (spread into renderPage; omitted when unmapped, for exactOptionalPropertyTypes).
  const preloadOf = (id: string): { preload?: readonly string[] } => {
    const chunks = options.routePreload?.[id]
    return chunks ? { preload: chunks } : {}
  }
  // The matched route's stylesheet links (spread into renderPage). Per-route when the build mapped it
  // (`routeStyles[id]` - only the chain's CSS; an empty array ⇒ no `<link>`), else the aggregate
  // `styles`. Omitted entirely when CSS-free (for exactOptionalPropertyTypes).
  const stylesOf = (id: string): { styles?: readonly string[] } => {
    const perRoute = options.routeStyles?.[id]
    if (perRoute !== undefined) return { styles: perRoute }
    return options.styles && options.styles.length > 0 ? { styles: options.styles } : {}
  }
  // Seed the context with the declared `Env` so `app.fetch(req, { env })` / `toFetchHandler(app)` type
  // the platform bindings (see the `createWebApp` doc). The runtime `env` still arrives per-request via
  // `app.fetch(req, { env })`; this is a compile-time-only seed (`server<Env>()` casts, doesn't store).
  const app = server<Env>(options.server)
  // Before the mount hooks and before every page route, so the order-scoped hooks (`derive`,
  // `beforeHandle`, assurance evidence) actually bind to them - see the `use` option. A caller
  // cannot do this after the fact: by the time this function returns, the routes are declared.
  options.use?.(app)
  // Auto-mount the in-process backend over HTTP at `apiPrefix` (default `/api`), BEFORE page routing.
  // `onRequest` runs on the raw request ahead of the router, so this wins over the page wildcard `/*`
  // for every method (POST/GET/PUT/…) - not just the GET page routes - and a backend 404 (`/api/none`)
  // surfaces as the backend's own response, never the page 404. We dispatch the SAME `Request` object
  // (its body unread) so streamed/large bodies pass through untouched; the backend defines its routes
  // at the full prefixed path (`server().post("/api/sync", …)`), matching the `inProcessClient` call
  // sites. `apiPrefix: ""` opts out; a non-mountable `api` (no symbol mount) is left pages-only. The hook
  // is registered ONLY when both hold, so a pages-only app keeps core's synchronous no-hook fast path.
  const apiPrefix = options.apiPrefix ?? "/api"
  const apiStrip = options.apiStrip === true
  const mountedApi = backendMountOf(api)
  // Longest path first, so a more specific mount (`/api/auth`) is tried before a broader one (`/api`)
  // regardless of the order they were declared in.
  const mounts = [...(options.mounts ?? [])].sort((a, b) => b.path.length - a.path.length)
  const underPrefix = (pathname: string, prefix: string): boolean =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)

  if (mounts.length > 0 || (apiPrefix !== "" && mountedApi !== undefined)) {
    app.onRequest((req, platform) => {
      const { pathname } = urlPartsFor(req)
      // Sub-app mounts win over the backend prefix: they are the more specific declaration, and an
      // auth handler mounted at `/api/auth` must not be swallowed by the backend mounted at `/api`.
      for (const mount of mounts) {
        if (!underPrefix(pathname, mount.path)) continue
        return mount.app.fetch(mount.stripPrefix === true ? stripMountPrefix(req, mount.path) : req)
      }
      // Exactly the prefix (`/api`) or a sub-path (`/api/…`) - NOT a sibling like `/apixyz` that merely
      // shares the prefix as a string head. Dispatch the original `req` (body intact) to the backend.
      if (mountedApi !== undefined && apiPrefix !== "" && underPrefix(pathname, apiPrefix)) {
        return mountedApi(apiStrip ? stripMountPrefix(req, apiPrefix) : req, platform)
      }
      return undefined // not an API path → continue to page routing
    })
  }
  // SSG `fallback: "404"`: the set of concrete paths that actually exist for those routes. An unlisted
  // path under a `"404"` route is rejected (it isn't a static file, and the route declared it shouldn't
  // SSR on demand). O(1) membership via a Set.
  const prerenderedSet = new Set(options.prerenderedPaths ?? [])
  const matchManifestRoute = createMatcher(
    manifest.routes.map((route) => ({ routeId: route.id, pattern: route.pattern })),
  )
  const routeById = new Map(manifest.routes.map((route) => [route.id, route]))

  // Load a route's layout modules (outermost layout → innermost), keeping each module whole so the
  // render path can take both its `default` (the component chain) AND its `meta` (the sitewide head it
  // contributes). Loaded lazily - the data-only and 405 branches return before any layout is needed.
  const loadLayoutModules = async (route: RouteEntry): Promise<LoadedLayoutModules> => {
    const modules = await Promise.all(
      // layoutIds only reference layouts present in the manifest (buildManifest invariant).
      route.layoutIds.map((id) => (manifest.layouts[id] as LayoutEntry).load()),
    )
    // A layout is not a form target, so an `action` there is a mistake with no meaning to give it.
    // A `loader`, by contrast, now runs (see `runLayoutChain`).
    for (let i = 0; i < modules.length; i++) {
      if ((modules[i] as { action?: unknown }).action === undefined) continue
      const id = route.layoutIds[i] as string
      throw new Error(
        `[nifra/web] "${(manifest.layouts[id] as LayoutEntry).file}" exports an \`action\`, but layouts do not run one - only route files do. Move the mutation into the route that submits to it.`,
      )
    }
    return modules
  }

  /**
   * Run a route's layout-chain loaders, honouring declared gates.
   *
   * Returns once every **gate** has resolved, with the non-gate loaders still in flight, so the caller
   * can start the page loader at exactly the right moment: after anything that might reject the
   * request, alongside anything that merely fetches.
   *
   * The ordering is the security-relevant part. Parallel loaders are NOT an authorization boundary -
   * a page loader running concurrently with a guard has already queried by the time the guard says no.
   * Remix documents that as a footgun; here it is a declaration instead. `export const gate = true`
   * makes a layout blocking for everything beneath it, and nothing beneath a rejected gate runs.
   *
   * Each layout receives only the params it OWNS ({@link RouteEntry.layoutParams}), not the route's
   * full set, so a layout at `orgs/[org]/` cannot read a param belonging to a route below it.
   */
  /**
   * Layout indices a client navigation asked to keep, from {@link RETAIN_HEADER}.
   *
   * The CLIENT decides retainability: it knows each layout's scoped params (shipped in the bootstrap)
   * and both the old and new match, so it can tell whether a layout's own prefix changed - without the
   * server re-matching a path the client already matched.
   *
   * It is a HINT, not an instruction. The client is asking to keep data it already holds, which is
   * harmless for data and unacceptable for a guard, so `runLayoutChain` refuses to skip a gate no
   * matter what arrives here. Anything unparseable is ignored rather than rejected: the worst case of
   * a bad hint is a loader that runs when it need not.
   */
  const retainedIndices = (header: string | null): ReadonlySet<number> => {
    if (header === null || header === "") return EMPTY_RETAIN
    const out = new Set<number>()
    for (const part of header.split(",")) {
      // Digits only. `Number("")` is 0 and `Number(" ")` is 0, so a stray comma would otherwise read
      // as "retain index 0" and silently skip the outermost layout.
      if (!/^\d+$/.test(part)) continue
      out.add(Number(part))
    }
    return out
  }

  /**
   * Validate a data-navigation's retain request against the manifest and its declared source path.
   * A client may ask to retain every slot it currently has; the server only honours indices whose
   * layout identity and owned params are unchanged. Hard document GETs never retain anything.
   */
  const validatedRetainedIndices = (
    req: Request,
    route: RouteEntry,
    params: Readonly<Record<string, string>>,
  ): ReadonlySet<number> => {
    if (req.headers.get(DATA_HEADER) === null) return EMPTY_RETAIN
    const requested = retainedIndices(req.headers.get(RETAIN_HEADER))
    const from = req.headers.get(NAV_FROM_HEADER)
    if (requested.size === 0 || from === null) return EMPTY_RETAIN
    let fromPath: string
    try {
      const current = new URL(req.url)
      const source = new URL(from, current)
      if (source.origin !== current.origin) return EMPTY_RETAIN
      fromPath = source.pathname + source.search
    } catch {
      return EMPTY_RETAIN
    }
    const previousMatch = matchManifestRoute(fromPath)
    if (previousMatch === null) return EMPTY_RETAIN
    const previous = routeById.get(previousMatch.routeId)
    if (previous === undefined) return EMPTY_RETAIN
    const valid = new Set<number>()
    for (const index of requested) {
      if (route.layoutIds[index] !== previous.layoutIds[index]) continue
      const owned = route.layoutParams?.[index] ?? []
      const previouslyOwned = previous.layoutParams?.[index] ?? []
      if (
        owned.length !== previouslyOwned.length ||
        owned.some((name, i) => name !== previouslyOwned[i]) ||
        owned.some((name) => params[name] !== previousMatch.params[name])
      ) {
        continue
      }
      valid.add(index)
    }
    return valid
  }

  // The validated (or raw-parsed) search a route's loader context receives; `searchOf` fails closed to
  // the schema's defaults on hostile input, so this never throws on an attacker-picked query.
  const loaderSearch = (searchSchema: RouteModule["searchSchema"], request: Request) =>
    searchOf(searchSchema, urlPartsFor(request).search)

  // The route's EFFECTIVE search once its layout chain is loaded: the layout schemas merged with the
  // page's (page-wins), the same chain the client mount builds for `useSearch`. Used for the page loader's
  // `ctx.search` and the render's `RenderProps.search`, so both agree with the client and with each other.
  const searchChainOf = (
    layoutMods: LoadedLayoutModules,
    mod: RouteModule,
    request: Request,
  ): Record<string, unknown> =>
    searchOfChain(
      [...layoutMods.map((m) => m.searchSchema), mod.searchSchema],
      urlPartsFor(request).search,
    )

  const runLayoutChain = async (
    route: RouteEntry,
    ctx: LoaderContext,
    retain: ReadonlySet<number> = new Set(),
  ): Promise<{
    readonly modules: LoadedLayoutModules
    readonly layoutData: readonly unknown[] | undefined
    readonly retained: readonly number[]
    readonly pending: Promise<unknown>
  }> => {
    const modules = await loadLayoutModules(route)
    if (!modules.some((m) => m.loader !== undefined)) {
      // Nothing to run: no array is produced, so a page-only app serializes nothing extra and its
      // HTML is byte-identical to before this feature.
      return { modules, layoutData: undefined, retained: [], pending: Promise.resolve() }
    }
    const results: unknown[] = new Array(modules.length).fill(null)
    const retained: number[] = []
    const pending: Array<Promise<void>> = []
    for (let i = 0; i < modules.length; i++) {
      const loader = modules[i]?.loader
      if (loader === undefined) continue
      // Unchanged scope: the client keeps what it has. A GATE is never skipped - it is a guard, and a
      // guard that only runs when the URL prefix changed is not a guard.
      if (retain.has(i) && modules[i]?.gate !== true) {
        retained.push(i)
        continue
      }
      const scoped: LoaderContext = {
        ...ctx,
        params: scopeParams(ctx.params, route.layoutParams?.[i]),
      }
      if (modules[i]?.gate === true) {
        // Blocking: awaited here, so a throw propagates before anything deeper is started.
        try {
          results[i] = await loader(scoped)
        } catch (err) {
          throw tagLayoutError(err, route.layoutIds[i] as string)
        }
        continue
      }
      const layoutId = route.layoutIds[i] as string
      const index = i
      // The loader is invoked INSIDE the async function, not before it. `Promise.resolve(loader(x))`
      // would let a synchronously-throwing loader escape past the rejection handler entirely - the
      // exception happens while evaluating the argument, before any promise exists to reject.
      pending.push(
        (async () => {
          try {
            results[index] = await loader(scoped)
          } catch (err) {
            throw tagLayoutError(err, layoutId)
          }
        })(),
      )
    }
    return { modules, layoutData: results, retained, pending: Promise.all(pending) }
  }

  /** Run only blocking layout gates before a route action. Non-gate loaders fetch render data and
   * therefore run after the mutation when a native POST needs a fresh document. */
  const runLayoutGates = async (
    route: RouteEntry,
    ctx: LoaderContext,
  ): Promise<LoadedLayoutModules> => {
    const modules = await loadLayoutModules(route)
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i]
      if (mod?.gate !== true || mod.loader === undefined) continue
      try {
        await mod.loader({
          ...ctx,
          params: scopeParams(ctx.params, route.layoutParams?.[i]),
        })
      } catch (err) {
        throw tagLayoutError(err, route.layoutIds[i] as string)
      }
    }
    return modules
  }

  // Build a route's render chain + its merged `<head>` from the already-loaded layout modules + the
  // page module. The chain is `[…layout components, page]`; the head merges each layout's `meta`
  // export (outermost→innermost) with the page's (last), so a `head`/`meta` on `_layout.tsx`
  // contributes sitewide tags. `metaArgs` (loader data + params) feed function-form `meta`s.
  const resolveChainAndHead = (
    layoutModules: LoadedLayoutModules,
    page: RouteModule,
    metaArgs: MetaArgs,
  ): { chain: unknown[]; head: Meta } => {
    const chain = [...layoutModules.map((m) => m.default), page.default]
    const heads = [
      ...layoutModules.map((m) => resolveMeta(m.meta, metaArgs)),
      resolveMeta(page.meta, metaArgs),
    ]
    return { chain, head: mergeHeads(heads) }
  }

  // Dir a special-file id lives in: `_error`→"" , `a/b/_error`→"a/b" (and likewise for `_layout`).
  const dirOfId = (id: string, suffix: string): string =>
    id === suffix ? "" : id.slice(0, id.length - suffix.length - 1)

  /**
   * Choose the `_error` boundary for a failure, respecting where a LAYOUT loader failed.
   *
   * A route error uses the nearest boundary, as it always has. A layout error must not: the nearest
   * boundary can sit BELOW the layout that threw, and rendering there would wrap the boundary in that
   * very layout - the one whose loader just failed and whose data therefore never arrived.
   */
  const boundaryFor = (route: RouteEntry, err: unknown): string | undefined => {
    const ids = route.errorIds ?? []
    const failing = layoutErrorId(err)
    if (failing === undefined) return ids.at(-1)
    const layoutDir = dirOfId(failing, "_layout")
    // Deepest boundary at or ABOVE the failing layout's directory.
    for (let i = ids.length - 1; i >= 0; i--) {
      const errDir = dirOfId(ids[i] as string, "_error")
      if (errDir === "" || errDir === layoutDir || layoutDir.startsWith(`${errDir}/`)) return ids[i]
    }
    return undefined
  }

  // The request's origin (scheme + host + port, NO trailing slash) - the one server fact `meta()` needs
  // for absolute `canonical`/`og:url`/`og:image` but can't otherwise see (it also runs on the client).
  // `URL.origin` is exactly that shape; it matches the browser's `location.origin` for the same URL, so
  // a soft-nav's `applyHead` resolves an identical `<head>` (no hydration drift). A malformed `req.url`
  // (shouldn't happen on a real request) degrades to `""` - the documented unknown-origin default -
  // rather than throwing during render.
  const originOf = (req: Request): string => {
    try {
      return new URL(req.url).origin
    } catch {
      return ""
    }
  }

  // The request's `pathname + search` - threaded into `renderPage` so an adapter's `useLocation`/
  // `useSearchParams` render the current URL server-side and hydrate against the client's initial state
  // (which the client entry seeds from `location.pathname + location.search`). No hash: it never reaches
  // the server. A malformed `req.url` degrades to "/" rather than throwing during render.
  const pathOf = (req: Request): string => {
    try {
      const parts = urlPartsFor(req)
      return parts.pathname + parts.search
    } catch {
      return "/"
    }
  }

  /**
   * Render the **nearest `_error` boundary** when a route's loader throws (the agnostic, server-side
   * half of error UI - works on every adapter, no client takeover). The boundary renders in place of
   * the page, wrapped by the layouts **at or above** its segment (deeper layouts are dropped). It's
   * served **non-hydrated** at status 500: a terminal page, and rendering a boundary (not the page the
   * client maps this route to) would otherwise hydrate-mismatch. The component receives `{ name,
   * message }` - never the stack (no internals leak into HTML).
   */
  const renderError = async (
    route: RouteEntry,
    errorId: string,
    err: unknown,
  ): Promise<Response | RenderedPage> => {
    const errDir = dirOfId(errorId, "_error")
    const keptLayoutIds = route.layoutIds.filter((id) => {
      const ld = dirOfId(id, "_layout")
      return ld === "" || ld === errDir || errDir.startsWith(`${ld}/`)
    })
    const layouts = await Promise.all(
      keptLayoutIds.map((id) =>
        (manifest.layouts[id] as LayoutEntry).load().then((m) => m.default),
      ),
    )
    const { default: errComp } = await (manifest.errors?.[errorId] as LayoutEntry).load()
    const e = err instanceof Error ? err : new Error(String(err))
    return renderPageResult({
      adapter,
      chain: [...layouts, errComp],
      data: { name: e.name, message: e.message },
      clientEntry,
      routeId: errorId,
      status: 500,
      hydrate: false,
      ...titleOption,
    })
  }

  // The 404 response - the `_404` page (status 404) or a plain-text fallback. Shared by the wildcard
  // catch-all (unmatched paths) and the `fallback: "404"` enforcement (unlisted paths under a route
  // that opted out of on-demand SSR).
  const renderNotFound = (path?: string): Promise<Response | RenderedPage> =>
    renderTerminalStatus(404, path)

  /**
   * Render a terminal-status page: the `_<status>` page if the app authored one, else `_404`, else
   * plain text. Shared by the wildcard catch-all, `fallback: "404"` enforcement, and a loader's
   * `notFound()` / `gone()` / `statusPage()`, so all of them resolve the page and set the status
   * through one path rather than forking.
   *
   * Hydrates, following the `_404` precedent rather than `_error`'s non-hydrated 500: these are
   * ordinary pages the client router can own, and a 404 arrived at by clicking a link should behave
   * like any other route.
   */
  const renderTerminalStatus = async (
    status: number,
    path?: string,
    extraHeaders?: HeadersLike,
  ): Promise<Response | RenderedPage> => {
    const page = manifest.statusPages?.[String(status)] ?? manifest.notFound
    if (page === undefined) {
      const headers = new Headers(extraHeaders)
      headers.set("content-type", "text/plain; charset=utf-8")
      return new Response(STATUS_TEXT[status] ?? "Error", { status, headers })
    }
    // The routeId decides which preload/style bundle and which client component this maps to, so it
    // must name the page actually rendered - `_410` when `_410.tsx` exists, `_404` when it fell back.
    const routeId = manifest.statusPages?.[String(status)] !== undefined ? `_${status}` : "_404"
    const loaded = (await page.load()) as {
      readonly default: unknown
      readonly searchSchema?: RouteModule["searchSchema"]
    }
    const component = loaded.default
    return renderPageResult({
      adapter,
      chain: [component],
      data: null,
      clientEntry,
      routeId,
      // The page hydrates, so besides `path` its SSR `search` must equal the client mount's derivation for
      // this routeId (`searchOf(searchSchema, url.search)`), or a status page reading `useSearch` drifts.
      // Only when `path` is present (a real URL); a schema-less status page then gets the raw parsed query.
      ...(path !== undefined
        ? {
            search: searchOf(
              loaded.searchSchema,
              path.includes("?") ? path.slice(path.indexOf("?")) : "",
            ),
          }
        : {}),
      // The page hydrates, so its SSR `path` must equal the client's initial
      // `location.pathname+search` (an unmatched path yields no params → `{}`), or a `useLocation`
      // on it would drift.
      ...(path !== undefined ? { path } : {}),
      status,
      ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      ...preloadOf(routeId),
      ...stylesOf(routeId),
      prerenderedPaths: options.prerenderedPaths ?? [],
      ...titleOption,
    })
  }

  /**
   * Answer a loader's terminal-status signal, in whichever form the caller asked for.
   *
   * A hard navigation wants the document, so it gets the rendered boundary. A client-side navigation
   * fetched DATA, not a document, so it gets an empty body plus the status on `X-Nifra-Status`, and
   * the client router renders the same boundary from its own manifest. Sending the HTML back to a
   * soft-nav would be answering a different question than the one asked - and skipping the header
   * entirely is what leaves a crawler seeing a correct 404 while a user who clicked a link sees a
   * blank page.
   */
  const renderStatusSignal = (
    req: Request,
    signal: StatusSignal,
  ): Promise<Response | RenderedPage> | Response => {
    const { status, headers } = signal[STATUS_SIGNAL]
    if (req.headers.get(DATA_HEADER) !== null) {
      const responseHeaders = new Headers(headers)
      responseHeaders.set(STATUS_HEADER, String(status))
      return new Response(null, { status, headers: responseHeaders })
    }
    return renderTerminalStatus(status, pathOf(req), headers)
  }

  for (const route of manifest.routes) {
    // A dynamic route whose `getStaticPaths` declared `fallback: "404"` - only its prerendered paths
    // exist; anything else 404s (computed once per route, not per request).
    const is404Fallback = options.staticFallbacks?.[route.pattern] === "404"
    // Per-route document-assembly cache (see RenderAssemblyCache): filled on the first GET render and
    // reused while the route + layout MODULE IDENTITIES are unchanged. Attached only when every meta
    // in the chain is static - a `meta(data)` function makes the head per-request, so those routes
    // always assemble fresh. A module reload (dev HMR) yields new module objects, dropping the slot.
    let assemblySlot: RenderAssemblyCache | undefined
    let assemblySlotMod: unknown
    let assemblySlotLayouts: LoadedLayoutModules | undefined
    const assemblyCacheFor = (
      mod: RouteModule,
      lms: LoadedLayoutModules,
    ): { assemblyCache: RenderAssemblyCache } | Record<string, never> => {
      if (typeof mod.meta === "function") return {}
      for (const m of lms) if (typeof m.meta === "function") return {}
      const layoutsUnchanged =
        assemblySlotLayouts !== undefined &&
        assemblySlotLayouts.length === lms.length &&
        assemblySlotLayouts.every((m, i) => m === lms[i])
      if (assemblySlotMod !== mod || !layoutsUnchanged) {
        assemblySlot = {}
        assemblySlotMod = mod
        assemblySlotLayouts = lms
      }
      return { assemblyCache: assemblySlot as RenderAssemblyCache }
    }
    app.register("GET", route.pattern, undefined, async (c: RouteContext) => {
      // Enforce `fallback: "404"` before any work: an unlisted path under this route doesn't exist.
      // Covers hard navigation directly; a client soft-nav's data fetch gets the 404, throws, and the
      // history layer falls back to a full-page navigation (which lands here again, as a document).
      if (is404Fallback && !prerenderedSet.has(urlPartsFor(c.req).pathname)) {
        return renderNotFound(pathOf(c.req))
      }
      const mod = await route.load()
      const draft = await draftFlag(c.req)
      let data: unknown
      let layoutData: readonly unknown[] | undefined
      let boundaryStates: BoundaryStates | undefined
      let layoutModules: LoadedLayoutModules | undefined
      let layoutRetained: readonly number[] = []
      try {
        const ctx = {
          params: c.params,
          request: c.req,
          req: c.req,
          api,
          env: c.env,
          draft,
          search: loaderSearch(mod.searchSchema, c.req),
        }
        // Layout loaders run for BOTH the document and the data-only request. A gate that only ran on
        // the document path would be bypassed by adding the data header, which is exactly the request
        // a client navigation makes - a guard has to hold on the path an attacker can pick.
        //
        // `runLayoutChain` returns once every GATE has resolved, with the non-gate loaders still in
        // flight. So the page loader starts as late as correctness requires and as early as speed
        // allows, and both are awaited together below.
        const run = await runLayoutChain(
          route,
          ctx,
          validatedRetainedIndices(c.req, route, c.params),
        )
        layoutModules = run.modules
        layoutRetained = run.retained
        const boundaryDefinitions = [
          ...run.modules.flatMap((layout) => layout.boundaries ?? []),
          ...(mod.boundaries ?? []),
        ]
        if (boundaryDefinitions.length > 0) boundaryDescriptors(boundaryDefinitions)
        const effectiveSearch = searchChainOf(run.modules, mod, c.req)
        const boundaryBatch =
          boundaryDefinitions.length === 0
            ? undefined
            : startDynamicBoundaries(boundaryDefinitions, {
                request: c.req,
                params: c.params,
                api,
                env: c.env,
                draft,
                search: effectiveSearch,
                signal: c.req.signal,
              } satisfies BoundaryRequestCtx)
        const staticBoundaryPromise =
          boundaryDefinitions.length === 0
            ? Promise.resolve(undefined)
            : resolveStaticBoundaries(
                boundaryDefinitions,
                { phase: "build", origin: originOf(c.req) },
                options.staticBoundaryCache,
              )
        // Boundary data is attached as one Deferred marker per slot. The shell can render
        // immediately with each slot pending, while the existing deferred protocol emits the first
        // completed sibling independently instead of waiting for the slowest boundary.
        // The page loader gets the EFFECTIVE search (layout chain + page, page-wins), now that the layout
        // modules are loaded - so `ctx.search` includes a layout's shared keys (`?org`), matching `useSearch`.
        const [pageData, , staticBoundaries] = await Promise.all([
          mod.loader ? mod.loader({ ...ctx, search: effectiveSearch }) : null,
          run.pending, // a non-gate layout loader that rejects must still surface, not go unhandled
          staticBoundaryPromise,
        ])
        data = pageData
        layoutData = run.layoutData
        if (boundaryBatch !== undefined) {
          const streamed = { ...boundaryBatch.initial, ...(staticBoundaries ?? {}) }
          for (const entry of boundaryBatch.pending) {
            const initial = streamed[entry.name]
            if (initial !== undefined)
              streamed[entry.name] = { ...initial, data: defer(entry.promise) }
          }
          boundaryStates = streamed
        } else if (staticBoundaries !== undefined) {
          boundaryStates = staticBoundaries
        }
      } catch (err) {
        // A terminal-status signal (`notFound()` / `gone()` / `statusPage(n)`) renders a boundary at
        // that status. Checked BEFORE the pass-through below: a signal IS a `Response`, so the order
        // is what keeps a hand-rolled `throw new Response(...)` served verbatim, as it always was.
        if (isStatusSignal(err)) return renderStatusSignal(c.req, err)
        // A thrown control-flow signal (a guard's `redirect(...)`, an explicit error response) - let
        // it propagate to core, which renders it as-is, whether it is a plain render or a
        // hand-rolled `Response`. Real errors render the nearest `_error` boundary, if any; with
        // none, rethrow (unchanged 500 behavior).
        if (isControlFlow(err)) throw err
        // Let reporting plugins observe the data-layer failure before it's rendered/rethrown/500'd.
        if (options.onLoaderError !== undefined) {
          try {
            options.onLoaderError(err, { request: c.req, params: c.params, route: route.pattern })
          } catch {
            // A faulty reporter must never break error rendering.
          }
        }
        const errorId = boundaryFor(route, err)
        if (errorId === undefined) throw err
        // A soft-nav data fetch can't render a boundary - 500 so the client falls back to a full-page
        // navigation, which lands here as a document and renders the `_error` page.
        if (c.req.headers.get(DATA_HEADER) !== null) {
          return new Response("Internal Server Error", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        }
        return renderError(route, errorId, withDuplicateInstanceHint(err))
      }
      // A loader may RETURN its control-flow signal instead of throwing it - `return redirect(...)`
      // reads naturally and must not silently serialize the signal as loader data. Mirror the catch
      // above exactly: a status signal renders its boundary, any other signal (a redirect, a
      // hand-rolled response) passes through to core verbatim - so return and throw are
      // interchangeable.
      if (isStatusSignal(data)) return renderStatusSignal(c.req, data)
      if (isControlFlow(data)) return data
      // Client-side navigation asks (via the X-Nifra-Data header) for just the loader data - no full
      // document, no layout chain. A route with deferred data streams NDJSON (critical data first,
      // then each deferred value as it settles); otherwise one JSON (the fast path). Same loader,
      // same auth - only the transport differs.
      if (c.req.headers.get(DATA_HEADER) !== null) {
        const pageSplit = prepareDeferred(data)
        const layoutSplits: Array<ReturnType<typeof prepareDeferred>> = []
        let offset = pageSplit.deferred.length
        for (const entry of layoutData ?? []) {
          const split = prepareDeferred(entry, offset)
          layoutSplits.push(split)
          offset += split.deferred.length
        }
        const deferred = [...pageSplit.deferred, ...layoutSplits.flatMap((split) => split.deferred)]
        const boundarySplit =
          boundaryStates === undefined
            ? undefined
            : prepareDeferred(boundaryStates, deferred.length)
        const allDeferred = [
          ...deferred,
          ...(boundarySplit === undefined ? [] : boundarySplit.deferred),
        ]
        const payload =
          layoutData === undefined && boundarySplit === undefined
            ? pageSplit.forClient
            : {
                v: 1 as const,
                data: pageSplit.forClient,
                layoutData: layoutSplits.map((split) => split.forClient),
                retained: layoutRetained,
                ...(boundarySplit === undefined ? {} : { boundaries: boundarySplit.forClient }),
              }
        // Bare value when there is no layout data - the pre-envelope shape, so a client running older
        // code against a newer server keeps working.
        if (allDeferred.length === 0) {
          return Response.json(payload ?? null)
        }
        return new Response(ndjsonStream(payload, allDeferred), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        })
      }
      const chainLayoutModules = layoutModules ?? (await loadLayoutModules(route))
      const { chain, head } = resolveChainAndHead(chainLayoutModules, mod, {
        data,
        params: c.params,
        origin: originOf(c.req),
      })
      const hydrateRoute = mod.hydrate !== false
      try {
        // `await` so a shell-render throw (renderToStream rejects before any byte) is caught here and
        // can render the `_error` page - not just a loader throw. Mid-stream (post-shell) throws can't
        // be recovered to a full page; the per-adapter client boundary catches client render errors.
        return await renderPageResult({
          adapter,
          chain,
          data,
          head,
          clientEntry,
          routeId: route.id,
          params: c.params,
          path: pathOf(c.req),
          // The effective (layout chain + page) search, matching the page loader's `ctx.search` above and
          // the client mount - so `useSearch` renders SSR-correct and hydrates with no drift. `layoutModules`
          // is loaded by now (the loader try succeeded to reach here).
          search: searchChainOf(layoutModules ?? [], mod, c.req),
          hydrate: hydrateRoute,
          ...(layoutData !== undefined ? { layoutData } : {}),
          ...(boundaryStates !== undefined ? { boundaries: boundaryStates } : {}),
          ...preloadOf(route.id),
          ...stylesOf(route.id),
          prerenderedPaths: options.prerenderedPaths ?? [],
          ...(mod.revalidate !== undefined ? { revalidate: mod.revalidate } : {}),
          ...(mod.revalidateTags !== undefined ? { revalidateTags: mod.revalidateTags } : {}),
          ...(mod.islandScripts !== undefined ? { islandScripts: mod.islandScripts } : {}),
          ...titleOption,
          ...assemblyCacheFor(mod, chainLayoutModules),
        })
      } catch (err) {
        // Same precedence as the loader catch above - a `meta()` may signal too.
        if (isStatusSignal(err)) return renderStatusSignal(c.req, err)
        if (isControlFlow(err)) throw err
        // Let reporting plugins observe the data-layer failure before it's rendered/rethrown/500'd.
        if (options.onLoaderError !== undefined) {
          try {
            options.onLoaderError(err, { request: c.req, params: c.params, route: route.pattern })
          } catch {
            // A faulty reporter must never break error rendering.
          }
        }
        const errorId = boundaryFor(route, err)
        if (errorId === undefined) throw err
        return renderError(route, errorId, withDuplicateInstanceHint(err))
      }
    })

    // POST runs the route's `action` (mutation). A control-flow return (e.g. a `redirect(...)`)
    // passes straight through; a data return re-renders the page (the loader re-runs for fresh
    // data) with `actionData`. Routes without an action reject POST with 405 - not a stray 404.
    app.register("POST", route.pattern, undefined, async (c: RouteContext) => {
      const mod = await route.load()
      const draft = await draftFlag(c.req)
      if (mod.action === undefined) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
        })
      }
      const actionContext = {
        params: c.params,
        request: c.req,
        req: c.req,
        api,
        env: c.env,
        draft,
        search: loaderSearch(mod.searchSchema, c.req),
      }
      const isDataRequest = c.req.headers.get(DATA_HEADER) !== null
      let layoutModules: LoadedLayoutModules
      let result: unknown
      try {
        // A gate is an authorization boundary for everything beneath its layout, mutations included.
        // Run only gates before the action; ordinary layout data loaders run after a native mutation.
        layoutModules = await runLayoutGates(route, actionContext)
        result = await mod.action(actionContext)
      } catch (err) {
        // A THROWN signal is the same control flow as a returned one (`throw redirect()` in a gate
        // or an action) - route it through the same conversion as the returned branch below, so
        // throw and return are interchangeable on the mutation path too.
        if (isControlFlow(err)) return actionResponse(err, isDataRequest)
        throw err
      }
      // An action may wrap its data in `revalidate(paths, data)` to declare which routes it changed.
      // Unwrap to the inner data; the paths ride the `X-Nifra-Revalidate` header on the data-mode
      // responses (the client acts on them - a full-page POST re-runs loaders inline, so no header).
      const isRevalidate =
        result !== null && typeof result === "object" && "__nifraRevalidate" in result
      const actionResult = isRevalidate ? (result as RevalidateResult<unknown>).data : result
      const revalidateHeader: Record<string, string> = isRevalidate
        ? { [REVALIDATE_HEADER]: (result as RevalidateResult<unknown>).__nifraRevalidate.join(",") }
        : {}
      if (isControlFlow(actionResult)) return actionResponse(actionResult, isDataRequest)
      // Client submit wants just the action's data (it revalidates the loader itself); a native
      // form POST re-renders the full page (loader re-runs) with the action data.
      if (isDataRequest) {
        // An action may `defer()` slow parts of its result - stream them (critical data first, then
        // each deferred as it settles) exactly like a loader; a non-deferred action returns one JSON.
        const { forClient, deferred } = prepareDeferred(actionResult)
        if (deferred.length === 0)
          return Response.json(actionResult ?? null, { headers: revalidateHeader })
        return new Response(ndjsonStream(forClient, deferred), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8", ...revalidateHeader },
        })
      }
      // Derived once and shared: the loader's `ctx.search` and the render's `RenderProps.search` are the
      // SAME effective (layout chain + page) value, and the client mount rebuilds it identically. The
      // layout modules are already loaded (the action ran through their gates above).
      const search = searchChainOf(layoutModules, mod, c.req)
      const data = mod.loader
        ? await mod.loader({
            params: c.params,
            request: c.req,
            req: c.req,
            api,
            env: c.env,
            draft,
            search,
          })
        : null
      const { chain, head } = resolveChainAndHead(layoutModules, mod, {
        data,
        params: c.params,
        origin: originOf(c.req),
      })
      const hydrateRoute = mod.hydrate !== false
      // A full-page POST streams the action's `defer()`'d parts mid-document behind `<Await>` too -
      // `renderPage` splits `actionData` like loader data (works with JS off; hydrates after).
      return renderPageResult({
        adapter,
        chain,
        data,
        actionData: actionResult,
        head,
        clientEntry,
        routeId: route.id,
        params: c.params,
        path: pathOf(c.req),
        search,
        hydrate: hydrateRoute,
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        prerenderedPaths: options.prerenderedPaths ?? [],
        ...titleOption,
      })
    })
  }

  // Register llms.txt & llms-full.txt
  const llmsOptions = { includeLocalGuidelines: options.publishLocalGuidelines === true }
  app.register("GET", "/llms.txt", undefined, async () => {
    const text = await generateLlmsTxt(false, manifest.routes, api, llmsOptions)
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  })

  app.register("GET", "/llms-full.txt", undefined, async () => {
    const text = await generateLlmsTxt(true, manifest.routes, api, llmsOptions)
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  })

  // Wildcard catch-all: unmatched paths render `_404` (404), or a plain text 404 if absent.
  app.register("GET", "/*", undefined, (c: RouteContext) => renderNotFound(pathOf(c.req)))

  return app
}
