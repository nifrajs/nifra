import {
  type BackendPlatformBinder,
  NIFRA_BACKEND_BIND_PLATFORM,
  NIFRA_PLATFORM_CLIENT_IP_DERIVED,
} from "@nifrajs/core/mount"
import { type Platform, type ResponseResult, status as statusResult } from "@nifrajs/core/server"
import {
  type BoundaryRequestCtx,
  type BoundaryStates,
  boundaryDescriptors,
  resolveStaticBoundaries,
  type StaticBoundaryCache,
  startDynamicBoundaries,
} from "../boundary.ts"
import type { CspPolicy } from "../csp.ts"
import { type CssLoadingMode, DEFAULT_CSS_LOADING, normalizeCssLoading } from "../css-contract.ts"
import { defer, ndjsonStream, prepareDeferred } from "../deferred.ts"
import { isDraftEnabled } from "../draft.ts"
import type {
  LayoutEntry,
  LoaderContext,
  Manifest,
  Meta,
  MetaArgs,
  NotFoundEntry,
  RouteEntry,
  RouteModule,
  ShouldRevalidate,
} from "../manifest.ts"
import type { NonceResolver } from "../nonce.ts"
import type { MatchChain, RenderAdapter } from "../render-seam.ts"
import {
  createMatcher,
  DATA_HEADER,
  NAV_FROM_HEADER,
  REDIRECT_HEADER,
  RETAIN_HEADER,
  REVALIDATE_HEADER,
  STATUS_HEADER,
} from "../router.ts"
import { searchOf, searchOfChain } from "../search.ts"
import { mergeHeads, resolveMeta } from "./head-merge.ts"
import {
  EMPTY_RETAIN,
  type HeadersLike,
  isControlFlow,
  isResponseResult,
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
import { urlPartsFor } from "./request-url.ts"
import {
  ACTION_SCOPE,
  type CoreResponseControls,
  DATA_RESPONSE_HEADERS,
  MIDDLEWARE_SCOPE,
  PAGE_SCOPE,
  PageResponseControls,
  PRIVATE_NO_STORE,
  PRIVATE_PAGE_HEADERS,
  privateOutcome,
  varyOnDataHeader,
} from "./response-controls.ts"

export type { NonceResolver } from "../nonce.ts"

/** Structural context supplied by the core server to one page route handler. */
export interface PageRouteContext<Env = unknown> {
  readonly params: Record<string, string>
  readonly req: Request
  readonly env: Env
  /** The serving app's response controls; a loader's `ctx.set` queues its cookies through them. */
  readonly set: CoreResponseControls
  /** The visitor's IP as the serving app derived it; forwarded to a request-bound `ctx.api`. */
  readonly clientIp?: string | undefined
  readonly waitUntil?: (promise: Promise<unknown>) => void
}

/** The page slot of an `ssr = false` route with no `HydrateFallback`: a component that renders nothing. */
const EMPTY_LEAF = (): null => null

/** The request-scoping seam of an in-process `api` (see `inProcessClient`), if it carries one. */
function platformBinderOf(api: unknown): BackendPlatformBinder | undefined {
  if ((typeof api !== "object" && typeof api !== "function") || api === null) return undefined
  const bind = (api as { [NIFRA_BACKEND_BIND_PLATFORM]?: unknown })[NIFRA_BACKEND_BIND_PLATFORM]
  return typeof bind === "function" ? (bind as BackendPlatformBinder) : undefined
}

/**
 * The page request's platform identity for loader calls: `clientIp` (read lazily, so a backend that
 * never reads `c.clientIp` never pays the socket lookup), `env` and `waitUntil` - and nothing else. The
 * page request's headers (cookie, authorization) never travel; a loader passes them explicitly if it
 * wants an authenticated call. The prototype marker tells the backend its `clientIp` is already derived,
 * so its own trust declaration does not re-read forwarding headers the synthesized request does not
 * carry; a spread copy drops both the getter and the marker, so it falls back to re-deriving.
 */
class LoaderPlatform {
  readonly env: unknown
  readonly waitUntil: ((promise: Promise<unknown>) => void) | undefined
  readonly #c: PageRouteContext<unknown>
  constructor(c: PageRouteContext<unknown>) {
    this.#c = c
    this.env = c.env
    this.waitUntil = c.waitUntil
  }
  get clientIp(): string | undefined {
    return this.#c.clientIp
  }
}
;(LoaderPlatform.prototype as { [NIFRA_PLATFORM_CLIENT_IP_DERIVED]?: true })[
  NIFRA_PLATFORM_CLIENT_IP_DERIVED
] = true

/**
 * A redirect answering a data request (a client navigation or form submit), as the client router reads
 * one: fetch would follow a 3xx and hand the router another page's data, so the target rides
 * `x-nifra-redirect` on a 204 that keeps the redirect's own headers. `undefined` for any other outcome
 * or request.
 */
function dataRedirect(req: Request, outcome: unknown): Response | ResponseResult | undefined {
  if (req.headers.get(DATA_HEADER) === null) return undefined
  if (isResponseResult(outcome)) {
    const plain = outcome.plain
    if (plain === undefined) return dataRedirect(req, outcome.toResponse())
    if (plain.status < 300 || plain.status >= 400) return undefined
    const { location, ...own } = plain.headers ?? {}
    if (location === undefined) return undefined
    return statusResult(204, undefined, {
      headers: {
        ...own,
        [REDIRECT_HEADER]: appTarget(location, req.url),
        ...DATA_RESPONSE_HEADERS,
      },
    })
  }
  if (!(outcome instanceof Response) || outcome.status < 300 || outcome.status >= 400) {
    return undefined
  }
  const location = outcome.headers.get("location")
  if (location === null) return undefined
  const headers = new Headers(outcome.headers)
  headers.delete("location")
  headers.delete("content-length")
  headers.set(REDIRECT_HEADER, appTarget(location, req.url))
  for (const [name, value] of Object.entries(DATA_RESPONSE_HEADERS)) headers.set(name, value)
  return new Response(null, { status: 204, headers })
}

/** A same-origin target as a path, which the client router can follow without loading a document. */
function appTarget(location: string, requestUrl: string): string {
  let target: URL
  try {
    target = new URL(location, requestUrl)
  } catch {
    return location // the browser fails on it the same way when it loads it
  }
  return target.origin === new URL(requestUrl).origin
    ? target.pathname + target.search + target.hash
    : location
}

export interface PageExecutionOptions<Env = unknown> {
  readonly adapter: RenderAdapter
  readonly manifest: Manifest
  readonly clientEntry: string
  readonly title?: string
  readonly api?: unknown
  readonly draftSecret?: string
  readonly routePreload?: Readonly<Record<string, readonly string[]>>
  readonly styles?: readonly string[]
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
  readonly cssLoading?: CssLoadingMode
  readonly prerenderedPaths?: readonly string[]
  readonly staticFallbacks?: Readonly<Record<string, "ssr" | "404">>
  readonly staticBoundaryCache?: StaticBoundaryCache
  /** Per-request CSP nonce for framework-owned executable document scripts. */
  readonly nonce?: NonceResolver<Env>
  /** A hash-based CSP policy: every document is rendered under it, carrying `nonce` only when needed. */
  readonly csp?: CspPolicy
  /** Set once a cache wrapper attaches; until then a route's freshness and tags stay off the response. */
  readonly cacheChannel?: { readonly enabled: boolean }
  readonly onLoaderError?: (
    error: unknown,
    ctx: {
      readonly request: Request
      readonly params: Readonly<Record<string, string>>
      readonly route: string
    },
  ) => void
}

type PageResponse = Response | ResponseResult | RenderedPage

export interface PageRequestExecutor<Env = unknown> {
  get(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  post(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  /** Answer a URL no route matched: the nearest nested `_404` for it, else the root one. */
  fallback(ctx: PageRouteContext<Env>): Promise<PageResponse>
}

/** One URL pattern a nested `_404` answers, as the executor indexes it. */
interface NotFoundTarget {
  readonly id: string
  readonly page: NotFoundEntry
  /** The pattern's param names in order; the index holds them by position. */
  readonly names: readonly string[]
  /** The page's layout chain as a route, so layouts, gates and boundaries run as they do for one. */
  readonly route: RouteEntry
}

/** The browser's side of a client navigation: the page it is leaving and the layout slots it holds. */
type RetainContext = {
  readonly requested: ReadonlySet<number>
  readonly from: RouteEntry
  readonly fromParams: Readonly<Record<string, string>>
  readonly fromUrl: URL
  readonly toUrl: URL
}

type LayoutRun = {
  readonly modules: LoadedLayoutModules
  readonly layoutData: readonly unknown[] | undefined
  readonly retained: readonly number[]
  readonly pending: Promise<unknown> | undefined
}

/**
 * Own the page request program behind one private seam.
 *
 * `createWebApp` remains responsible for app construction, mount ordering, and route registration.
 * This module owns the page-specific contract: context, layout execution, control-flow precedence,
 * data/document assembly, and error/status rendering. GET and POST retain their distinct ordering
 * (ordinary layout data may run after an action; a gate must run before it) while sharing the same
 * outcome and render decisions.
 */
export function createPageRequestExecutor<Env = unknown>(
  options: PageExecutionOptions<Env>,
): PageRequestExecutor<Env> {
  const { adapter, manifest, clientEntry, api } = options
  // Bound once per render, so every loader, action and boundary in that render shares one view of the
  // in-process client carrying the visitor's platform. An `api` without the seam passes through as-is.
  const bindApi = platformBinderOf(api)
  // One view per render, shared by every loader, action and boundary it runs.
  const apiFor = (c: PageRouteContext<Env>): unknown =>
    bindApi === undefined ? api : bindApi.call(api, new LoaderPlatform(c) as Platform)
  const cssLoading = normalizeCssLoading(options.cssLoading ?? DEFAULT_CSS_LOADING)
  const titleOption = options.title === undefined ? {} : { title: options.title }
  const cspOption = options.csp === undefined ? {} : { csp: options.csp }
  const prerenderedSet = new Set(options.prerenderedPaths ?? [])
  const matchManifestRoute = createMatcher(
    manifest.routes.map((route) => ({ routeId: route.id, pattern: route.pattern })),
  )
  const routeById = new Map(manifest.routes.map((route) => [route.id, route]))

  // A nested `_404` answers an unmatched URL from inside the catch-all, never as a route of its own:
  // a registered `/admin/*` would take URLs from a route the router only reaches by backtracking.
  // Param names are indexed by position, so two directories that name one segment differently share
  // the index; each target keeps its own names to read a match back.
  const notFoundTargets: NotFoundTarget[] = []
  const notFoundPatterns: Array<{ routeId: string; pattern: string }> = []
  for (const [id, page] of Object.entries(manifest.notFounds ?? {})) {
    for (const scope of page.scopes) {
      const names: string[] = []
      const pattern = scope.pattern.replace(
        /([:*])([A-Za-z_][A-Za-z0-9_]*)/g,
        (_match, sigil: string, name: string) => `${sigil}p${names.push(name) - 1}`,
      )
      notFoundPatterns.push({ routeId: String(notFoundTargets.length), pattern })
      notFoundTargets.push({
        id,
        page,
        names,
        route: {
          id,
          pattern: scope.pattern,
          layoutIds: page.layoutIds,
          layoutParams: scope.layoutParams,
          ...(page.middlewareIds === undefined
            ? {}
            : {
                middlewareIds: page.middlewareIds,
                ...(scope.middlewareParams === undefined
                  ? {}
                  : { middlewareParams: scope.middlewareParams }),
              }),
          errorIds: page.errorIds,
          file: page.file,
          load: page.load,
        },
      })
    }
  }
  const matchNotFoundScope =
    notFoundPatterns.length === 0 ? undefined : createMatcher(notFoundPatterns)

  const draftFlag = (req: Request): Promise<boolean> =>
    options.draftSecret === undefined
      ? Promise.resolve(false)
      : isDraftEnabled(req, options.draftSecret)

  const preloadOf = (id: string): { preload?: readonly string[] } => {
    const chunks = options.routePreload?.[id]
    return chunks ? { preload: chunks } : {}
  }

  const resolveNonce = (
    request: Request,
    env: Env,
  ): string | undefined | Promise<string | undefined> =>
    options.nonce === undefined ? undefined : options.nonce({ request, env })

  const stylesOf = (id: string): { styles?: readonly string[]; cssLoading?: CssLoadingMode } => {
    const perRoute = options.routeStyles?.[id]
    const styles = perRoute ?? options.styles
    if (styles === undefined || styles.length === 0) return {}
    return {
      styles,
      ...(cssLoading === "deferred" ? { cssLoading } : {}),
    }
  }

  // Load a route's layout modules once for the current execution. The render path needs each whole
  // module for its component + meta, while the data path also needs loader/gate/boundary declarations.
  const loadLayoutModules = async (route: RouteEntry): Promise<LoadedLayoutModules> => {
    const modules = await Promise.all(
      route.layoutIds.map((id) => (manifest.layouts[id] as LayoutEntry).load()),
    )
    for (let i = 0; i < modules.length; i++) {
      if ((modules[i] as { action?: unknown }).action === undefined) continue
      const id = route.layoutIds[i] as string
      throw new Error(
        `[nifra/web] "${(manifest.layouts[id] as LayoutEntry).file}" exports an \`action\`, but layouts do not run one - only route files do. Move the mutation into the route that submits to it.`,
      )
    }
    return modules
  }

  // No modules, data, or per-request state: reuse the settled result for page-only routes.
  const emptyLayoutRun: LayoutRun = {
    modules: [],
    layoutData: undefined,
    retained: [],
    pending: undefined,
  }

  /** Run layout loaders, awaiting gates before starting the page loader and retaining only safe data. */
  const runLayoutChain = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
    retain?: RetainContext,
  ): Promise<LayoutRun> => {
    if (route.layoutIds.length === 0) return emptyLayoutRun
    const modules = await loadLayoutModules(route)
    if (!modules.some((m) => m.loader !== undefined)) {
      return { modules, layoutData: undefined, retained: [], pending: undefined }
    }
    const results: unknown[] = new Array(modules.length).fill(null)
    const retained: number[] = []
    const pending: Array<Promise<void>> = []
    for (let i = 0; i < modules.length; i++) {
      const layout = modules[i] as LoadedLayoutModules[number]
      const loader = layout.loader
      if (loader === undefined) continue
      if (retain !== undefined && layout.gate !== true) {
        let keep: boolean
        try {
          keep = keepsLayoutData(route, i, layout, ctx.params, retain)
        } catch (err) {
          throw tagLayoutError(err, route.layoutIds[i] as string)
        }
        if (keep) {
          retained.push(i)
          continue
        }
      }
      const scoped: LoaderContext = {
        ...ctx,
        params: scopeParams(ctx.params, route.layoutParams?.[i]),
        set: controls.scope(i),
      }
      if (modules[i]?.gate === true) {
        try {
          results[i] = await loader(scoped)
        } catch (err) {
          throw tagLayoutError(err, route.layoutIds[i] as string)
        }
        continue
      }
      const layoutId = route.layoutIds[i] as string
      const index = i
      try {
        const value = loader(scoped)
        // Scalars settle synchronously. Objects keep await's intrinsic promise/thenable
        // assimilation: property-presence and prototype probes are unsafe for proxies.
        if (value !== null && (typeof value === "object" || typeof value === "function")) {
          pending.push(
            (async () => {
              try {
                results[index] = await value
              } catch (err) {
                throw tagLayoutError(err, layoutId)
              }
            })(),
          )
        } else results[index] = value
      } catch (err) {
        // Preserve a synchronous throw as a pending layout failure, just like the async lane.
        pending.push(Promise.reject(tagLayoutError(err, layoutId)))
      }
    }
    return {
      modules,
      layoutData: results,
      retained,
      pending:
        pending.length === 0 ? undefined : pending.length === 1 ? pending[0] : Promise.all(pending),
    }
  }

  /** Run only authorization gates before an action; ordinary layout data runs after a native action. */
  const runLayoutGates = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
  ): Promise<LoadedLayoutModules> => {
    const modules = await loadLayoutModules(route)
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i]
      if (mod?.gate !== true || mod.loader === undefined) continue
      try {
        await mod.loader({
          ...ctx,
          params: scopeParams(ctx.params, route.layoutParams?.[i]),
          set: controls.scope(i),
        })
      } catch (err) {
        throw tagLayoutError(err, route.layoutIds[i] as string)
      }
    }
    return modules
  }

  /** Outermost first; a failure carries its directory so the nearest `_error` above it renders. */
  const runMiddleware = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
  ): Promise<void> => {
    const ids = route.middlewareIds ?? []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string
      const entry = manifest.middlewares?.[id] as LayoutEntry
      const dirTag = `${id.slice(0, id.length - "_middleware".length)}_layout`
      let outcome: unknown
      try {
        const middleware = (await entry.load()).default
        // A `_layout.backend.ts` that exports no middleware is a layout data module, nothing more.
        if (middleware === undefined) continue
        if (typeof middleware !== "function") {
          throw new Error(
            `[nifra/web] "${entry.file}" exports a middleware that is not a function.`,
          )
        }
        outcome = await middleware({
          ...ctx,
          params: scopeParams(ctx.params, route.middlewareParams?.[i]),
          set: controls.scope(MIDDLEWARE_SCOPE + i),
        })
      } catch (err) {
        throw tagLayoutError(err, dirTag)
      }
      if (outcome === undefined) continue
      throw tagLayoutError(
        isControlFlow(outcome)
          ? outcome
          : new Error(
              `[nifra/web] the middleware in "${entry.file}" returned a value. Middleware returns nothing to let the request through, or a redirect(), a status such as notFound(), or a Response to answer it.`,
            ),
        dirTag,
      )
    }
  }

  const retainedIndices = (header: string | null): ReadonlySet<number> => {
    if (header === null || header === "") return EMPTY_RETAIN
    const out = new Set<number>()
    for (const part of header.split(",")) {
      if (!/^\d+$/.test(part)) continue
      out.add(Number(part))
    }
    return out
  }

  /**
   * The browser's side of a client navigation: the page it is leaving and the layout slots it asked
   * to keep. Undefined unless this is a data request whose `from` is same-origin and routable.
   */
  const retainContextOf = (req: Request): RetainContext | undefined => {
    if (req.headers.get(DATA_HEADER) === null) return undefined
    const requested = retainedIndices(req.headers.get(RETAIN_HEADER))
    const from = req.headers.get(NAV_FROM_HEADER)
    if (requested.size === 0 || from === null) return undefined
    let toUrl: URL
    let fromUrl: URL
    try {
      toUrl = new URL(req.url)
      fromUrl = new URL(from, toUrl)
    } catch {
      return undefined
    }
    if (fromUrl.origin !== toUrl.origin) return undefined
    const previousMatch = matchManifestRoute(fromUrl.pathname + fromUrl.search)
    if (previousMatch === null) return undefined
    const previous = routeById.get(previousMatch.routeId)
    if (previous === undefined) return undefined
    return { requested, from: previous, fromParams: previousMatch.params, fromUrl, toUrl }
  }

  /** A query change re-runs layout loaders by default: any can read it, and none declares keys. */
  const keepsLayoutData = (
    route: RouteEntry,
    index: number,
    layout: LoadedLayoutModules[number],
    params: Readonly<Record<string, string>>,
    retain: RetainContext,
  ): boolean => {
    if (!retain.requested.has(index)) return false
    const previous = retain.from
    if (route.layoutIds[index] !== previous.layoutIds[index]) return false
    const owned = route.layoutParams?.[index] ?? []
    const previouslyOwned = previous.layoutParams?.[index] ?? []
    const defaultShouldRevalidate =
      retain.fromUrl.search !== retain.toUrl.search ||
      owned.length !== previouslyOwned.length ||
      owned.some((name, i) => name !== previouslyOwned[i]) ||
      owned.some((name) => params[name] !== retain.fromParams[name])
    const decide = layout.shouldRevalidate
    if (typeof decide !== "function") return !defaultShouldRevalidate
    // Copies, so a hook that mutates its arguments cannot reach the request's params or the next
    // layout's view of the navigation.
    const answer = (decide as ShouldRevalidate)({
      currentUrl: new URL(retain.fromUrl),
      nextUrl: new URL(retain.toUrl),
      currentParams: { ...retain.fromParams },
      nextParams: { ...params },
      defaultShouldRevalidate,
    })
    return answer === false
  }

  const loaderSearch = (searchSchema: RouteModule["searchSchema"], request: Request) =>
    searchOf(searchSchema, urlPartsFor(request).search)

  const searchChainOf = (
    layoutMods: LoadedLayoutModules,
    mod: RouteModule,
    request: Request,
  ): Record<string, unknown> =>
    searchOfChain(
      [...layoutMods.map((m) => m.searchSchema), mod.searchSchema],
      urlPartsFor(request).search,
    )

  // `ssr = false`: the slot holds `HydrateFallback`, which the browser hydrates before the page.
  const serverLeafOf = (route: RouteEntry, mod: RouteModule): unknown => {
    if (mod.ssr !== false) return mod.default
    if (mod.hydrate === false) {
      throw new Error(
        `[nifra/web] route "${route.id}" sets both \`ssr = false\` and \`hydrate = false\`: the ` +
          "server skips its component and no client would ever render it. Remove one of the two.",
      )
    }
    return mod.HydrateFallback ?? EMPTY_LEAF
  }

  const resolveChainAndHead = (
    layoutModules: LoadedLayoutModules,
    page: RouteModule,
    metaArgs: MetaArgs,
    leaf: unknown = page.default,
  ): { chain: unknown[]; head: Meta } => {
    const chain = [...layoutModules.map((m) => m.default), leaf]
    const heads = [
      ...layoutModules.map((m) => resolveMeta(m.meta, metaArgs)),
      resolveMeta(page.meta, metaArgs),
    ]
    return { chain, head: mergeHeads(heads) }
  }

  /** What `useMatches` reports for a chain: the layouts' ids and `handle`s, then the page's. */
  const matchChainOf = (
    layoutIds: readonly string[],
    layoutModules: LoadedLayoutModules,
    pageId: string,
    page: { readonly handle?: unknown },
  ): MatchChain => ({
    ids: [...layoutIds, pageId],
    handles: [...layoutModules.map((layout) => layout.handle), page.handle],
  })

  const dirOfId = (id: string, suffix: string): string =>
    id === suffix ? "" : id.slice(0, id.length - suffix.length - 1)

  const boundaryFor = (route: RouteEntry, err: unknown): string | undefined => {
    const ids = route.errorIds ?? []
    const failing = layoutErrorId(err)
    if (failing === undefined) return ids.at(-1)
    const layoutDir = dirOfId(failing, "_layout")
    for (let i = ids.length - 1; i >= 0; i--) {
      const errDir = dirOfId(ids[i] as string, "_error")
      if (errDir === "" || errDir === layoutDir || layoutDir.startsWith(`${errDir}/`)) return ids[i]
    }
    return undefined
  }

  const originOf = (req: Request): string => {
    try {
      return new URL(req.url).origin
    } catch {
      return ""
    }
  }

  const pathOf = (req: Request): string => {
    try {
      const parts = urlPartsFor(req)
      return parts.pathname + parts.search
    } catch {
      return "/"
    }
  }

  const renderError = async (
    route: RouteEntry,
    errorId: string,
    err: unknown,
    personalized: boolean,
    nonce?: string,
  ): Promise<PageResponse> => {
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
      ...(personalized ? { headers: PRIVATE_PAGE_HEADERS } : {}),
      ...(nonce === undefined ? {} : { nonce }),
      ...cspOption,
      ...titleOption,
    })
  }

  const renderTerminalStatus = async (
    status: number,
    path?: string,
    extraHeaders?: HeadersLike,
    nonce?: string,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.[String(status)] ?? manifest.notFound
    if (page === undefined) {
      const headers = new Headers(extraHeaders)
      headers.set("content-type", "text/plain; charset=utf-8")
      return new Response(STATUS_TEXT[status] ?? "Error", { status, headers })
    }
    const routeId = manifest.statusPages?.[String(status)] !== undefined ? `_${status}` : "_404"
    const loaded = (await page.load()) as {
      readonly default: unknown
      readonly searchSchema?: RouteModule["searchSchema"]
      readonly handle?: unknown
    }
    return renderPageResult({
      adapter,
      chain: [loaded.default],
      data: null,
      clientEntry,
      routeId,
      matchChain: { ids: [routeId], handles: [loaded.handle] },
      ...(path !== undefined
        ? {
            search: searchOf(
              loaded.searchSchema,
              path.includes("?") ? path.slice(path.indexOf("?")) : "",
            ),
          }
        : {}),
      ...(path !== undefined ? { path } : {}),
      status,
      ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      ...(nonce === undefined ? {} : { nonce }),
      ...cspOption,
      ...preloadOf(routeId),
      ...stylesOf(routeId),
      prerenderedPaths: options.prerenderedPaths ?? [],
      ...titleOption,
    })
  }

  const renderStatusSignal = async (
    req: Request,
    env: Env,
    signal: StatusSignal,
    personalized: boolean,
  ): Promise<PageResponse> => {
    const { status, headers } = signal[STATUS_SIGNAL]
    if (req.headers.get(DATA_HEADER) !== null) {
      // Same URL as the status page, so it is never storable: a cache keyed on the URL alone would
      // otherwise answer a document request with this empty body.
      const responseHeaders = new Headers(headers)
      responseHeaders.set(STATUS_HEADER, String(status))
      responseHeaders.set("cache-control", PRIVATE_NO_STORE)
      responseHeaders.set("vary", varyOnDataHeader(responseHeaders.get("vary")))
      return new Response(null, { status, headers: responseHeaders })
    }
    const nonce = await resolveNonce(req, env)
    if (headers === undefined && !personalized) {
      return renderTerminalStatus(status, pathOf(req), undefined, nonce)
    }
    const documentHeaders = new Headers(headers)
    if (headers !== undefined) {
      documentHeaders.set("vary", varyOnDataHeader(documentHeaders.get("vary")))
    }
    // A cookie queued before the signal makes the status page specific to this visitor.
    if (personalized) documentHeaders.set("cache-control", PRIVATE_NO_STORE)
    return renderTerminalStatus(status, pathOf(req), documentHeaders, nonce)
  }

  const reportLoaderError = (
    route: RouteEntry,
    req: Request,
    params: Record<string, string>,
    err: unknown,
  ): void => {
    if (options.onLoaderError === undefined) return
    try {
      options.onLoaderError(err, { request: req, params, route: route.pattern })
    } catch {
      // A faulty reporter must never break error rendering.
    }
  }

  const handleDataOrDocument = async (
    req: Request,
    env: Env,
    route: RouteEntry,
    params: Readonly<Record<string, string>>,
    mod: RouteModule,
    data: unknown,
    layoutData: readonly unknown[] | undefined,
    layoutModules: LoadedLayoutModules,
    layoutRetained: readonly number[],
    boundaryStates: BoundaryStates | undefined,
    assemblyCache: RenderAssemblyCache | undefined,
    responseHeaders: Record<string, string> | undefined,
    personalized: boolean,
  ): Promise<PageResponse> => {
    if (isStatusSignal(data)) return renderStatusSignal(req, env, data, personalized)
    if (isControlFlow(data)) return data
    if (req.headers.get(DATA_HEADER) !== null) {
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
        boundaryStates === undefined ? undefined : prepareDeferred(boundaryStates, deferred.length)
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
      if (allDeferred.length === 0) {
        return Response.json(payload ?? null, { headers: DATA_RESPONSE_HEADERS })
      }
      return new Response(ndjsonStream(payload, allDeferred), {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          ...DATA_RESPONSE_HEADERS,
        },
      })
    }

    const nonce = options.nonce === undefined ? undefined : await resolveNonce(req, env)
    const { chain, head } = resolveChainAndHead(
      layoutModules,
      mod,
      {
        data,
        params,
        origin: originOf(req),
        ...(nonce === undefined ? {} : { nonce }),
      },
      serverLeafOf(route, mod),
    )
    try {
      return await renderPageResult({
        adapter,
        chain,
        data,
        head,
        clientEntry,
        routeId: route.id,
        params,
        path: pathOf(req),
        search: searchChainOf(layoutModules, mod, req),
        matchChain: matchChainOf(route.layoutIds, layoutModules, route.id, mod),
        hydrate: mod.hydrate !== false,
        ...(layoutData !== undefined ? { layoutData } : {}),
        ...(boundaryStates !== undefined ? { boundaries: boundaryStates } : {}),
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        prerenderedPaths: options.prerenderedPaths ?? [],
        ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
        // A response that sets a cookie is one visitor's: it never advertises ISR freshness.
        ...(mod.revalidate !== undefined && !personalized && options.cacheChannel?.enabled === true
          ? { revalidate: mod.revalidate }
          : {}),
        ...(mod.revalidateTags !== undefined &&
        !personalized &&
        options.cacheChannel?.enabled === true
          ? { revalidateTags: mod.revalidateTags }
          : {}),
        ...(mod.islandScripts !== undefined ? { islandScripts: mod.islandScripts } : {}),
        ...(nonce === undefined ? {} : { nonce }),
        ...cspOption,
        ...titleOption,
        ...(assemblyCache === undefined ? {} : { assemblyCache }),
      })
    } catch (err) {
      if (isStatusSignal(err)) return renderStatusSignal(req, env, err, personalized)
      if (isControlFlow(err)) throw err
      reportLoaderError(route, req, { ...params }, err)
      const errorId = boundaryFor(route, err)
      if (errorId === undefined) throw err
      return renderError(route, errorId, withDuplicateInstanceHint(err), personalized, nonce)
    }
  }

  /** What a failed loader answers with, once a status signal has been ruled out. */
  const renderLoaderFailure = async (
    route: RouteEntry,
    req: Request,
    env: Env,
    params: Record<string, string>,
    err: unknown,
    personalized: boolean,
  ): Promise<PageResponse> => {
    if (isControlFlow(err)) throw err
    reportLoaderError(route, req, params, err)
    const errorId = boundaryFor(route, err)
    if (errorId === undefined) throw err
    if (req.headers.get(DATA_HEADER) !== null) {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    return renderError(
      route,
      errorId,
      withDuplicateInstanceHint(err),
      personalized,
      options.nonce === undefined ? undefined : await resolveNonce(req, env),
    )
  }

  /**
   * Render a nested `_404` inside its layouts. `layoutModules` and `layoutData` are exactly the
   * layouts at or above the page, their gates already passed.
   */
  const renderNestedNotFound = async (
    req: Request,
    env: Env,
    id: string,
    page: NotFoundEntry,
    params: Readonly<Record<string, string>>,
    layoutModules: LoadedLayoutModules,
    layoutData: readonly unknown[] | undefined,
    personalized: boolean,
    signalHeaders?: HeadersLike,
  ): Promise<PageResponse> => {
    // The page can show what a layout loaded for this visitor, and a 404 is storable by default.
    const isPrivate = personalized || layoutData !== undefined
    if (req.headers.get(DATA_HEADER) !== null) {
      // No status header: the page has no client chunk, so the navigation falls back to loading the
      // URL as a document, which renders it here.
      const headers = new Headers(signalHeaders)
      headers.set("cache-control", PRIVATE_NO_STORE)
      headers.set("vary", varyOnDataHeader(headers.get("vary")))
      return new Response(null, { status: 404, headers })
    }
    const mod = await page.load()
    const nonce = options.nonce === undefined ? undefined : await resolveNonce(req, env)
    const { chain, head } = resolveChainAndHead(layoutModules, mod, {
      data: null,
      params,
      origin: originOf(req),
      ...(nonce === undefined ? {} : { nonce }),
    })
    let headers: Headers | undefined
    if (signalHeaders !== undefined || isPrivate) {
      headers = new Headers(signalHeaders)
      if (signalHeaders !== undefined) headers.set("vary", varyOnDataHeader(headers.get("vary")))
      if (isPrivate) headers.set("cache-control", PRIVATE_NO_STORE)
    }
    return renderPageResult({
      adapter,
      chain,
      data: null,
      head,
      clientEntry,
      routeId: id,
      params,
      path: pathOf(req),
      search: searchChainOf(layoutModules, mod, req),
      matchChain: matchChainOf(page.layoutIds, layoutModules, id, mod),
      status: 404,
      hydrate: false,
      ...(layoutData !== undefined ? { layoutData } : {}),
      ...stylesOf(id),
      ...(headers === undefined ? {} : { headers }),
      ...(nonce === undefined ? {} : { nonce }),
      ...cspOption,
      ...titleOption,
    })
  }

  /** The nearest nested `_404` for the route's own `notFound()`, else `undefined` (root page). */
  const renderRouteNotFound = async (
    req: Request,
    env: Env,
    route: RouteEntry,
    params: Readonly<Record<string, string>>,
    signal: StatusSignal,
    run: LayoutRun | undefined,
    personalized: boolean,
  ): Promise<PageResponse | undefined> => {
    const id = route.notFoundIds?.at(-1)
    if (id === undefined || run === undefined) return undefined
    if (signal[STATUS_SIGNAL].status !== 404 || layoutErrorId(signal) !== undefined) {
      return undefined
    }
    const page = manifest.notFounds?.[id]
    if (page === undefined) return undefined
    try {
      await run.pending
    } catch {
      return undefined
    }
    // The page's layouts are the leading ones of the route's: its directory contains the route.
    const kept = page.layoutIds.length
    return renderNestedNotFound(
      req,
      env,
      id,
      page,
      params,
      run.modules.slice(0, kept),
      run.layoutData?.slice(0, kept),
      personalized,
      signal[STATUS_SIGNAL].headers,
    )
  }

  const renderNotFound = async (
    request: Request,
    env: Env,
    path?: string,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.["404"] ?? manifest.notFound
    if (page === undefined) return renderTerminalStatus(404, path)
    return renderTerminalStatus(
      404,
      path,
      undefined,
      options.nonce === undefined ? undefined : await resolveNonce(request, env),
    )
  }

  /**
   * Run a page handler with the request's `ctx.set`, sealed once the handler settles - whatever it
   * answered with - so a write that arrives after the response was decided throws. A request that
   * queued a cookie answers with a response no shared cache may store, returned or thrown. A redirect
   * answering a data request, returned or thrown, reaches the client router intact.
   */
  const withResponseControls =
    (run: (c: PageRouteContext<Env>, controls: PageResponseControls) => Promise<PageResponse>) =>
    async (c: PageRouteContext<Env>): Promise<PageResponse> => {
      const controls = new PageResponseControls(c)
      try {
        const outcome = await run(c, controls)
        const answer = dataRedirect(c.req, outcome) ?? outcome
        return controls.personalized ? (privateOutcome(answer) as PageResponse) : answer
      } catch (err) {
        if (!isControlFlow(err)) throw err
        const answer = dataRedirect(c.req, err)
        // Returned rather than rethrown: the serving app sends a thrown `Response` exactly as it is,
        // without the cookies the request queued.
        if (controls.personalized) return privateOutcome(answer ?? err) as PageResponse
        if (answer !== undefined) return answer
        throw err
      } finally {
        controls.seal()
      }
    }

  return {
    get: (route) => {
      const is404Fallback = options.staticFallbacks?.[route.pattern] === "404"
      let assemblySlot: RenderAssemblyCache | undefined
      let assemblySlotMod: unknown
      let assemblySlotLayouts: LoadedLayoutModules | undefined
      const assemblyCacheFor = (
        mod: RouteModule,
        layouts: LoadedLayoutModules,
      ): RenderAssemblyCache | undefined => {
        if (typeof mod.meta === "function") return undefined
        for (const layout of layouts) if (typeof layout.meta === "function") return undefined
        const layoutsUnchanged =
          assemblySlotLayouts !== undefined &&
          assemblySlotLayouts.length === layouts.length &&
          assemblySlotLayouts.every((layout, index) => layout === layouts[index])
        if (assemblySlotMod !== mod || !layoutsUnchanged) {
          assemblySlot = {}
          assemblySlotMod = mod
          assemblySlotLayouts = layouts
        }
        return assemblySlot
      }

      return withResponseControls(async (c, controls) => {
        if (is404Fallback && !prerenderedSet.has(urlPartsFor(c.req).pathname)) {
          return renderNotFound(c.req, c.env, pathOf(c.req))
        }
        const mod = await route.load()
        const draft = await draftFlag(c.req)
        let data: unknown
        let layoutData: readonly unknown[] | undefined
        let boundaryStates: BoundaryStates | undefined
        let layoutModules: LoadedLayoutModules | undefined
        let layoutRetained: readonly number[] = []
        let responseHeaders: Record<string, string> | undefined
        const requestApi = apiFor(c)
        let run: LayoutRun | undefined
        try {
          const ctx: LoaderContext = {
            params: c.params,
            request: c.req,
            req: c.req,
            api: requestApi,
            env: c.env,
            draft,
            search: loaderSearch(mod.searchSchema, c.req),
            set: controls.scope(PAGE_SCOPE),
          }
          if (route.middlewareIds !== undefined) await runMiddleware(route, ctx, controls)
          run = await runLayoutChain(route, ctx, controls, retainContextOf(c.req))
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
                  api: requestApi,
                  env: c.env,
                  draft,
                  search: effectiveSearch,
                  signal: c.req.signal,
                } satisfies BoundaryRequestCtx)
          const staticBoundaryPromise =
            boundaryDefinitions.length === 0
              ? undefined
              : resolveStaticBoundaries(
                  boundaryDefinitions,
                  { phase: "build", origin: originOf(c.req) },
                  options.staticBoundaryCache,
                )
          const pageResult = mod.loader ? mod.loader({ ...ctx, search: effectiveSearch }) : null
          const [pageData, , staticBoundaries] =
            run.pending === undefined && staticBoundaryPromise === undefined
              ? ([await pageResult, undefined, undefined] as const)
              : staticBoundaryPromise === undefined
                ? await Promise.all([pageResult, run.pending])
                : await Promise.all([pageResult, run.pending, staticBoundaryPromise])
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
          // Inside the loader `try`: a header the response cannot carry is a loader error, rendered
          // by the same boundary as one.
          responseHeaders = controls.documentHeaders()
        } catch (err) {
          if (isStatusSignal(err)) {
            return (
              (await renderRouteNotFound(
                c.req,
                c.env,
                route,
                c.params,
                err,
                run,
                controls.personalized,
              )) ?? renderStatusSignal(c.req, c.env, err, controls.personalized)
            )
          }
          return renderLoaderFailure(route, c.req, c.env, c.params, err, controls.personalized)
        }
        if (isStatusSignal(data)) {
          const nested = await renderRouteNotFound(
            c.req,
            c.env,
            route,
            c.params,
            data,
            run,
            controls.personalized,
          )
          if (nested !== undefined) return nested
        }
        return handleDataOrDocument(
          c.req,
          c.env,
          route,
          c.params,
          mod,
          data,
          layoutData,
          layoutModules ?? (await loadLayoutModules(route)),
          layoutRetained,
          boundaryStates,
          layoutModules === undefined ? undefined : assemblyCacheFor(mod, layoutModules),
          responseHeaders,
          controls.personalized,
        )
      })
    },

    post: (route) =>
      withResponseControls(async (c, controls) => {
        const mod = await route.load()
        const draft = await draftFlag(c.req)
        if (mod.action === undefined) {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
          })
        }
        const requestApi = apiFor(c)
        const actionContext: LoaderContext = {
          params: c.params,
          request: c.req,
          req: c.req,
          api: requestApi,
          env: c.env,
          draft,
          search: loaderSearch(mod.searchSchema, c.req),
          set: controls.scope(ACTION_SCOPE),
        }
        const isDataRequest = c.req.headers.get(DATA_HEADER) !== null
        let layoutModules: LoadedLayoutModules
        let result: unknown
        try {
          if (route.middlewareIds !== undefined) await runMiddleware(route, actionContext, controls)
          layoutModules = await runLayoutGates(route, actionContext, controls)
          result = await mod.action(actionContext)
        } catch (err) {
          if (isControlFlow(err)) return err
          throw err
        }
        const isRevalidate =
          result !== null && typeof result === "object" && "__nifraRevalidate" in result
        const actionResult = isRevalidate ? (result as RevalidateResult<unknown>).data : result
        const revalidateHeader: Record<string, string> = isRevalidate
          ? {
              [REVALIDATE_HEADER]: (result as RevalidateResult<unknown>).__nifraRevalidate.join(
                ",",
              ),
            }
          : {}
        if (isControlFlow(actionResult)) return actionResult
        if (isDataRequest) {
          // Headers shape the document only, but a bad one fails here too, so a navigation and a full
          // page load agree on whether the action's response is valid.
          controls.commit()
          const { forClient, deferred } = prepareDeferred(actionResult)
          if (deferred.length === 0) {
            return Response.json(actionResult ?? null, {
              headers: { ...DATA_RESPONSE_HEADERS, ...revalidateHeader },
            })
          }
          return new Response(ndjsonStream(forClient, deferred), {
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8",
              ...DATA_RESPONSE_HEADERS,
              ...revalidateHeader,
            },
          })
        }
        const search = searchChainOf(layoutModules, mod, c.req)
        const data = mod.loader
          ? await mod.loader({
              params: c.params,
              request: c.req,
              req: c.req,
              api: requestApi,
              env: c.env,
              draft,
              search,
              set: controls.scope(PAGE_SCOPE),
            })
          : null
        const responseHeaders = controls.documentHeaders()
        const nonce = options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env)
        const { chain, head } = resolveChainAndHead(
          layoutModules,
          mod,
          {
            data,
            params: c.params,
            origin: originOf(c.req),
            ...(nonce === undefined ? {} : { nonce }),
          },
          serverLeafOf(route, mod),
        )
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
          matchChain: matchChainOf(route.layoutIds, layoutModules, route.id, mod),
          hydrate: mod.hydrate !== false,
          ...preloadOf(route.id),
          ...stylesOf(route.id),
          prerenderedPaths: options.prerenderedPaths ?? [],
          ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
          ...(nonce === undefined ? {} : { nonce }),
          ...cspOption,
          ...titleOption,
        })
      }),

    fallback: withResponseControls(async (c, controls) => {
      const match = matchNotFoundScope?.(pathOf(c.req)) ?? null
      const target = match === null ? undefined : notFoundTargets[Number(match.routeId)]
      if (match === null || target === undefined) {
        return renderNotFound(c.req, c.env, pathOf(c.req))
      }
      const params: Record<string, string> = {}
      for (let i = 0; i < target.names.length; i++) {
        params[target.names[i] as string] = match.params[`p${i}`] as string
      }
      const mod = await target.page.load()
      let run: LayoutRun
      try {
        const ctx: LoaderContext = {
          params,
          request: c.req,
          req: c.req,
          api: apiFor(c),
          env: c.env,
          draft: await draftFlag(c.req),
          search: loaderSearch(mod.searchSchema, c.req),
          set: controls.scope(PAGE_SCOPE),
        }
        if (target.route.middlewareIds !== undefined) {
          await runMiddleware(target.route, ctx, controls)
        }
        run = await runLayoutChain(target.route, ctx, controls)
        await run.pending
      } catch (err) {
        if (isStatusSignal(err)) {
          return renderStatusSignal(c.req, c.env, err, controls.personalized)
        }
        return renderLoaderFailure(target.route, c.req, c.env, params, err, controls.personalized)
      }
      return renderNestedNotFound(
        c.req,
        c.env,
        target.id,
        target.page,
        params,
        run.modules,
        run.layoutData,
        controls.personalized,
      )
    }),
  }
}
