import {
  type BackendPlatformBinder,
  NIFRA_BACKEND_BIND_PLATFORM,
  NIFRA_PLATFORM_CLIENT_IP_DERIVED,
} from "@nifrajs/core/mount"
import {
  isSameOriginForm,
  type Platform,
  type ResponseResult,
  status as statusResult,
} from "@nifrajs/core/server"
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
import { routeTags } from "../isr.ts"
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
import type { MatchChain, PageLocale, PageLocales, RenderAdapter } from "../render-seam.ts"
import { SWAP_HEADER } from "../render-seam.ts"
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
import { mergeHeads, resolveChainMeta } from "./head-merge.ts"
import { keepAliveTable, slotDepths } from "./keep-alive-table.ts"
import type { LiveEnvelope, LiveFinish, LiveLoad, LiveRouteMatch } from "./live-contract.ts"
import { prepareModules } from "./module-preparation.ts"
import {
  EMPTY_RETAIN,
  type HeadersLike,
  isControlFlow,
  isResponseResult,
  isRevalidateResult,
  isStatusSignal,
  type LoadedLayoutModules,
  layoutErrorId,
  notFound,
  type RenderAssemblyCache,
  type RenderedPage,
  type RenderPageOptions,
  type RevalidateResult,
  redirect,
  renderPageResult,
  STATUS_SIGNAL,
  STATUS_TEXT,
  type StatusSignal,
  scopeParams,
  tagLayoutError,
  withDuplicateInstanceHint,
} from "./render-document.ts"
import { originFor, urlPartsFor } from "./request-url.ts"
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
  readonly signal?: AbortSignal
  readonly params: Record<string, string>
  readonly req: Request
  readonly env: Env
  /** The serving app's response controls; a loader's `ctx.set` queues its cookies through them. */
  readonly set: CoreResponseControls
  /** The visitor's IP as the serving app derived it; forwarded to a request-bound `ctx.api`. */
  readonly clientIp?: string | undefined
  readonly waitUntil?: (promise: Promise<unknown>) => void
  /** One request header, read off the serving app's source without building `req.headers`. */
  readonly header?: (name: string) => string | null
}

/** Whether `c` is a client navigation's data request. On Node, `req.headers` builds every header. */
// The slot name is echoed in a response header, so only a plain identifier is honored.
const SLOT_NAME = /^[A-Za-z][\w-]{0,63}$/

/** The slot an `x-nifra-swap` request names, when it is a valid slot name. */
function swapSlotOf(req: Request): string | undefined {
  const name = req.headers.get(SWAP_HEADER)
  return name !== null && SLOT_NAME.test(name) ? name : undefined
}

/** The `swapSlot` render option for `req`, empty when it is not a swap request. */
function swapOption(req: Request): { readonly swapSlot?: string } {
  const swapSlot = swapSlotOf(req)
  return swapSlot === undefined ? {} : { swapSlot }
}

function isDataRequest(c: PageRouteContext<unknown>): boolean {
  return (c.header !== undefined ? c.header(DATA_HEADER) : c.req.headers.get(DATA_HEADER)) !== null
}

/** The page slot of an `ssr = false` route with no `HydrateFallback`: a component that renders nothing. */
const EMPTY_LEAF = (): null => null

/** `ctx.live` outside a live load: keys are declared for nobody. */
const NO_LIVE = (): void => {}

/** Run one owner's loader with its `ctx.live`, closing the collector once the loader settles. */
const runLiveLoader = (
  live: LiveLoad,
  owner: string,
  loader: (ctx: LoaderContext) => unknown,
  ctx: LoaderContext,
): Promise<unknown> => {
  let value: unknown
  try {
    value = loader({ ...ctx, live: live.collector(owner) })
  } catch (err) {
    live.seal(owner)
    return Promise.reject(err)
  }
  return Promise.resolve(value).finally(() => live.seal(owner))
}

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
function dataRedirect(
  req: Request,
  isData: boolean,
  outcome: unknown,
): Response | ResponseResult | undefined {
  if (!isData) return undefined
  if (isResponseResult(outcome)) {
    const plain = outcome.plain
    if (plain === undefined) return dataRedirect(req, isData, outcome.toResponse())
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
  if (target.origin !== new URL(requestUrl).origin) return location
  // A path starting `//` (from `/.//host`) is a protocol-relative URL to whoever resolves it next.
  return target.pathname.startsWith("//")
    ? target.href
    : target.pathname + target.search + target.hash
}

/** The app's locale routing, as page execution reads it. */
export interface PageI18n {
  readonly locales: PageLocales
  /** The served locale key a `pathname + search` is in. */
  localeOf(path: string): string
  /** The answer for a `[lang]` / `[[lang]]` segment's value (`undefined` when an optional one is
   * absent), as `@nifrajs/i18n/routing`'s `matchSegment` gives it. */
  matchSegment(
    value: string | undefined,
    pathname: string,
  ):
    | { readonly kind: "ok" | "not-found" }
    | { readonly kind: "redirect"; readonly location: string }
}

// The route directories whose first segment names the locale.
const LOCALE_SEGMENTS: ReadonlySet<string> = new Set(["[lang]", "[[lang]]"])

export interface PageExecutionOptions<Env = unknown> {
  readonly serverComponents?: import("../server-components/types.ts").ServerComponentRuntime
  readonly rerenderOwnerGET?: (
    request: Request,
    context: PageRouteContext<Env>,
  ) => Promise<Response>
  readonly adapter: RenderAdapter
  readonly manifest: Manifest
  readonly cacheRouteModules?: boolean
  readonly clientEntry: string
  readonly title?: string
  readonly api?: unknown
  readonly draftSecret?: string
  readonly routePreload?: Readonly<Record<string, readonly string[]>>
  readonly styles?: readonly string[]
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
  readonly cssLoading?: CssLoadingMode
  readonly prerenderedPaths?: readonly string[]
  /** Where pages fetch {@link prerenderedPaths} from when the list is too large to inline. */
  readonly prerenderedListUrl?: string
  /** Locale key -> copy chunk URL, from a build that split copy tables by locale. */
  readonly copyChunks?: Readonly<Record<string, string>>
  /** The app's locale routing: each document's locale, and the check on a `[lang]` segment. */
  readonly i18n?: PageI18n
  readonly staticFallbacks?: Readonly<Record<string, "ssr" | "404">>
  readonly staticBoundaryCache?: StaticBoundaryCache
  /** Per-request CSP nonce for framework-owned executable document scripts. */
  readonly nonce?: NonceResolver<Env>
  /** A hash-based CSP policy: every document is rendered under it, carrying `nonce` only when needed. */
  readonly csp?: CspPolicy
  /** Set once a cache wrapper attaches; until then a route's freshness and tags stay off the response. */
  readonly cacheChannel?: { readonly enabled: boolean }
  /**
   * Run, or hand to the cache wrapper, what an action's `revalidate()` made stale. A promise is awaited
   * before the action answers; `undefined` means nothing runs it. Never throws, never changes the answer.
   */
  readonly invalidate?: (
    revalidation: RevalidateResult<unknown>,
    request: Request,
  ) => Promise<void> | undefined
  /** The live load a request belongs to; only set when the app configures `live`. */
  readonly liveLoadOf?: ((request: Request) => LiveLoad | undefined) | undefined
  readonly onLoaderError?: (
    error: unknown,
    ctx: {
      readonly request: Request
      readonly params: Readonly<Record<string, string>>
      readonly route: string
    },
  ) => void
  /** Logs a failure an `_error` boundary answered. Without a boundary the error propagates and the
   * server logs it, so this runs only where the server never sees the throw. */
  readonly logBoundaryError?: (error: unknown, request: Request) => void
}

type PageResponse = Response | ResponseResult | RenderedPage

export interface PageRequestExecutor<Env = unknown> {
  get(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  post(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  /** Answer a URL no route matched: the nearest nested `_404` for it, else the root one. */
  fallback(ctx: PageRouteContext<Env>): Promise<PageResponse>
  /** The route a `pathname + search` renders, with its layout chain. */
  matchRoute(path: string): LiveRouteMatch | null
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

/** A route's layouts after only their gates ran: `gates[i]` is gate `i`'s value. */
type GatedLayouts = {
  readonly modules: LoadedLayoutModules
  readonly gates: readonly unknown[]
}

/** Layouts whose loaders settled for this request: what a status or error page renders in. */
type LayoutChain = {
  readonly modules: LoadedLayoutModules
  readonly layoutData: readonly unknown[] | undefined
}

/**
 * Not called for a page that exports `inLayouts = false`, so such a page runs no layout loader.
 * `undefined` renders the page alone.
 */
type LayoutChainSource = (page: RouteModule, count: number) => Promise<LayoutChain | undefined>

/** A document's render input, filled in field by field. */
type DocumentInput = { -readonly [K in keyof RenderPageOptions]: RenderPageOptions[K] } & {
  readonly clientEntry: string
  readonly hydrate: boolean
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
  const cacheModules =
    options.cacheRouteModules ??
    (typeof process !== "undefined" && process.env?.NODE_ENV === "production")
  const loadModule = prepareModules(cacheModules)
  const preparedLayouts = new WeakMap<RouteEntry, LoadedLayoutModules>()
  // The action result is request-local; a browser cannot manufacture this handoff.
  const progressiveActionData = new WeakMap<Request, unknown>()
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
  const prerenderedHandover =
    options.prerenderedListUrl === undefined
      ? { prerenderedPaths: options.prerenderedPaths ?? [] }
      : { prerenderedListUrl: options.prerenderedListUrl }
  const copyOption = options.copyChunks === undefined ? {} : { copyChunks: options.copyChunks }
  const appDocumentOptions = { ...prerenderedHandover, ...copyOption, ...cspOption, ...titleOption }
  const { i18n } = options
  const pageLocales = new Map(i18n?.locales.locales.map((locale) => [locale.key, locale]))
  /** The request's locale for a document, with the served locales the client names locales from. */
  const localeOption = (req: Request): { locale?: PageLocale; locales?: PageLocales } => {
    if (i18n === undefined) return {}
    const locale = pageLocales.get(i18n.localeOf(pathOf(req)))
    return locale === undefined ? { locales: i18n.locales } : { locale, locales: i18n.locales }
  }
  /** Whether a route sits under a `[lang]` or `[[lang]]` directory, which the locale routing checks. */
  const localeGuarded = (route: RouteEntry): boolean => {
    if (i18n === undefined) return false
    for (const segment of route.id.split("/")) {
      if (!(segment.startsWith("(") && segment.endsWith(")"))) return LOCALE_SEGMENTS.has(segment)
    }
    return false
  }
  const matchManifestRoute = createMatcher(
    manifest.routes.map((route) => ({ routeId: route.id, pattern: route.pattern })),
  )
  const routeById = new Map(manifest.routes.map((route) => [route.id, route]))
  const liveLoadOf = options.liveLoadOf

  /** A live load holds one admission slot from before its middleware until its body is complete. */
  const admitLive =
    (run: (c: PageRouteContext<Env>, controls: PageResponseControls) => Promise<PageResponse>) =>
    async (c: PageRouteContext<Env>, controls: PageResponseControls): Promise<PageResponse> => {
      const live = liveLoadOf?.(c.req)
      if (live === undefined) return run(c, controls)
      const refused = live.admit()
      if (refused !== undefined) return refused
      let outcome: PageResponse
      try {
        outcome = await run(c, controls)
      } catch (err) {
        live.release()
        throw err
      }
      if (outcome instanceof Response) return live.settle(outcome)
      live.release()
      return outcome
    }

  /** Which owners a successful live load ran and which it kept, by their wire ids. */
  const liveOwners = (
    route: RouteEntry,
    modules: LoadedLayoutModules | undefined,
    layoutData: readonly unknown[] | undefined,
    retained: readonly number[],
    mod: RouteModule,
    skipPage: boolean,
    ctx: LoaderContext,
  ): LiveFinish => {
    const fresh: string[] = []
    const kept: string[] = []
    for (let i = 0; i < (modules?.length ?? 0); i++) {
      if (modules?.[i]?.loader === undefined) continue
      const owner = `L:${route.layoutIds[i]}`
      if (retained.includes(i)) kept.push(owner)
      // A layout that answered with a status declared keys for data nobody is shown.
      else if (!isStatusSignal(layoutData?.[i])) fresh.push(owner)
    }
    if (skipPage) kept.push(`P:${route.id}`)
    else if (mod.loader !== undefined) fresh.push(`P:${route.id}`)
    return { fresh, retained: kept, ctx }
  }

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

  // Where the browser's keep-alive view puts slot wrappers, so the document it hydrates has them:
  // nothing outside an app with a `keepAlive` route.
  const keepTable = keepAliveTable(manifest)
  const slotsFor = (
    layoutIds: readonly string[],
    routeId: string,
  ): { slots?: readonly number[] } => {
    // Every page of a keep-alive app renders through the adapter's keep-alive root, wrappers or none,
    // as the browser hydrates it.
    if (keepTable === undefined) return {}
    return { slots: slotDepths(keepTable, layoutIds, routeId) }
  }

  const preloadOf = (id: string): { preload?: readonly string[] } => {
    const chunks = options.routePreload?.[id]
    return chunks ? { preload: chunks } : {}
  }

  const resolveNonce = (
    request: Request,
    env: Env,
  ): string | undefined | Promise<string | undefined> =>
    options.nonce === undefined ? undefined : options.nonce({ request, env })

  const stylesFrom = (
    styles: readonly string[] | undefined,
  ): { styles?: readonly string[]; cssLoading?: CssLoadingMode } => {
    if (styles === undefined || styles.length === 0) return {}
    return {
      styles,
      ...(cssLoading === "deferred" ? { cssLoading } : {}),
    }
  }

  const stylesOf = (id: string): { styles?: readonly string[]; cssLoading?: CssLoadingMode } =>
    stylesFrom(options.routeStyles?.[id] ?? options.styles)

  // Load a route's layout modules once for the current execution. The render path needs each whole
  // module for its component + meta, while the data path also needs loader/gate/boundary declarations.
  const loadLayoutModules = async (route: RouteEntry): Promise<LoadedLayoutModules> => {
    const known = cacheModules ? preparedLayouts.get(route) : undefined
    if (known !== undefined) return known
    const modules = await Promise.all(
      route.layoutIds.map((id) => loadModule(manifest.layouts[id] as LayoutEntry)),
    )
    for (let i = 0; i < modules.length; i++) {
      if ((modules[i] as { action?: unknown }).action === undefined) continue
      const id = route.layoutIds[i] as string
      throw new Error(
        `[nifra/web] "${(manifest.layouts[id] as LayoutEntry).file}" exports an \`action\`, but layouts do not run one - only route files do. Move the mutation into the route that submits to it.`,
      )
    }
    if (cacheModules) preparedLayouts.set(route, modules)
    return modules
  }

  // No modules, data, or per-request state: reuse the settled result for page-only routes.
  const emptyLayoutRun: LayoutRun = {
    modules: [],
    layoutData: undefined,
    retained: [],
    pending: undefined,
  }

  /**
   * Await one gate. A returned redirect, status or Response refuses the request exactly as a thrown
   * one does: stored as layout data it would let the page loader and the action run.
   */
  const runGate = async (
    route: RouteEntry,
    index: number,
    loader: NonNullable<LoadedLayoutModules[number]["loader"]>,
    ctx: LoaderContext,
  ): Promise<unknown> => {
    let value: unknown
    try {
      value = await loader(ctx)
    } catch (err) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The loaded layout array is derived from these same manifest IDs in the same order.
      throw tagLayoutError(err, route.layoutIds[index] as string)
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The loaded layout array is derived from these same manifest IDs in the same order.
    if (isControlFlow(value)) throw tagLayoutError(value, route.layoutIds[index] as string)
    return value
  }

  // Development only. A layout loader that refuses access reads as a guard, and is not one: a client
  // navigation can skip it and an action below it runs without it.
  const warnsUngatedRefusal =
    typeof process !== "undefined" && process.env?.NODE_ENV === "development"
  const warnedUngated = new Set<string>()
  const warnUngatedRefusal = (layoutId: string, outcome: unknown): void => {
    if (warnedUngated.has(layoutId)) return
    // notFound() and gone() say the record is missing, which a layout may decide without guarding.
    const refusesAccess = isStatusSignal(outcome)
      ? outcome.status === 401 || outcome.status === 403
      : isControlFlow(outcome)
    if (!refusesAccess) return
    warnedUngated.add(layoutId)
    const file = manifest.layouts?.[layoutId]?.file ?? layoutId
    console.warn(
      `[nifra/web] the loader in "${file}" refused a request, but that layout is not a gate. A client navigation that keeps the layout on screen can skip its loader, and an action below it runs without it, so it does not protect the pages under it. Export \`gate = true\` from that file, or move the check into middleware. (Shown in development only.)`,
    )
  }

  /**
   * Run layout loaders, awaiting gates before starting the page loader and retaining only safe data.
   * `gated` carries gates that already ran for this request, so none runs twice.
   */
  const runLayoutChain = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
    retain?: RetainContext,
    gated?: GatedLayouts,
    live?: LiveLoad,
  ): Promise<LayoutRun> => {
    if (route.layoutIds.length === 0) return emptyLayoutRun
    const modules = gated?.modules ?? (await loadLayoutModules(route))
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
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The loaded layout array is derived from these same manifest IDs in the same order.
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
      const layoutId = route.layoutIds[i] as string
      if (modules[i]?.gate === true) {
        results[i] =
          gated !== undefined
            ? gated.gates[i]
            : await runGate(
                route,
                i,
                live === undefined
                  ? loader
                  : (gateCtx) => runLiveLoader(live, `L:${layoutId}`, loader, gateCtx),
                scoped,
              )
        continue
      }
      const index = i
      try {
        const value =
          live === undefined ? loader(scoped) : runLiveLoader(live, `L:${layoutId}`, loader, scoped)
        // Scalars settle synchronously. Objects keep await's intrinsic promise/thenable
        // assimilation: property-presence and prototype probes are unsafe for proxies.
        if (value !== null && (typeof value === "object" || typeof value === "function")) {
          pending.push(
            (async () => {
              let settled: unknown
              try {
                settled = await value
              } catch (err) {
                if (warnsUngatedRefusal) warnUngatedRefusal(layoutId, err)
                throw tagLayoutError(err, layoutId)
              }
              // A returned redirect or Response refuses exactly as a thrown one: kept as layout data,
              // it would ship beside the page loader's data.
              if (isControlFlow(settled)) {
                if (warnsUngatedRefusal) warnUngatedRefusal(layoutId, settled)
                throw tagLayoutError(settled, layoutId)
              }
              results[index] = settled
            })(),
          )
        } else results[index] = value
      } catch (err) {
        if (warnsUngatedRefusal) warnUngatedRefusal(layoutId, err)
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
  ): Promise<GatedLayouts> => {
    const modules = await loadLayoutModules(route)
    const gates: unknown[] = []
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i]
      if (mod?.gate !== true || mod.loader === undefined) continue
      gates[i] = await runGate(route, i, mod.loader, {
        ...ctx,
        params: scopeParams(ctx.params, route.layoutParams?.[i]),
        set: controls.scope(i),
      })
    }
    return { modules, gates }
  }

  /** Outermost first; a failure carries its directory so the nearest `_error` above it renders. */
  const runMiddleware = async (
    route: RouteEntry,
    ctx: LoaderContext,
    controls: PageResponseControls,
  ): Promise<void> => {
    if (i18n !== undefined && localeGuarded(route)) {
      // Before any app middleware, as a root `_middleware` would run: an unserved locale, or a page
      // missing from it, never reaches the app's code.
      const match = i18n.matchSegment(ctx.params.lang, pathOf(ctx.request))
      if (match.kind === "redirect") {
        throw tagLayoutError(redirect(match.location, { status: 308 }), "_layout")
      }
      if (match.kind === "not-found") {
        try {
          notFound()
        } catch (signal) {
          throw tagLayoutError(signal, "_layout")
        }
      }
    }
    const ids = route.middlewareIds ?? []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string
      const entry = manifest.middlewares?.[id] as LayoutEntry
      const dirTag = `${id.slice(0, id.length - "_middleware".length)}_layout`
      let outcome: unknown
      try {
        const middleware = (await loadModule(entry)).default
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
  const retainContextOf = (c: PageRouteContext<Env>): RetainContext | undefined => {
    if (!isDataRequest(c)) return undefined
    const req = c.req
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
    layoutData: readonly unknown[] | undefined,
    page: RouteModule,
    metaArgs: MetaArgs,
    leaf: unknown = page.default,
  ): { chain: unknown[]; head: Meta } => {
    const chain = [...layoutModules.map((m) => m.default), leaf]
    const metas = [...layoutModules.map((m) => m.meta), page.meta]
    return { chain, head: mergeHeads(resolveChainMeta(metas, layoutData, metaArgs)) }
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

  const pathOf = (req: Request): string => {
    try {
      const parts = urlPartsFor(req)
      return parts.pathname + parts.search
    } catch {
      return "/"
    }
  }

  /** What a status or error page's `meta` receives: no route params, and its own data. */
  const statusMetaArgs = (req: Request, data: unknown, nonce: string | undefined): MetaArgs =>
    nonce === undefined
      ? { data, pageData: data, params: {}, origin: originFor(req) }
      : { data, pageData: data, params: {}, origin: originFor(req), nonce }

  const renderError = async (
    req: Request,
    route: RouteEntry,
    errorId: string,
    err: unknown,
    personalized: boolean,
    nonce?: string,
    layouts?: LayoutChainSource,
  ): Promise<PageResponse> => {
    const errDir = dirOfId(errorId, "_error")
    const keptLayoutIds = route.layoutIds.filter((id) => {
      const ld = dirOfId(id, "_layout")
      return ld === "" || ld === errDir || errDir.startsWith(`${ld}/`)
    })
    const errorModule = await (manifest.errors?.[errorId] as LayoutEntry).load()
    const e = err instanceof Error ? err : new Error(String(err))
    // An error's text can carry a connection string or a query, so only a run that says it is
    // development or test shows it; an unset NODE_ENV (an unbuilt `bun app.ts`) counts as production.
    const nodeEnv = typeof process === "undefined" ? undefined : process.env.NODE_ENV
    const data =
      nodeEnv === "development" || nodeEnv === "test"
        ? { name: e.name, message: e.message }
        : { name: "Error", message: "Internal Server Error" }
    const inLayouts = errorModule.inLayouts !== false
    const chain =
      inLayouts && layouts !== undefined && keptLayoutIds.length > 0
        ? await layouts(errorModule, keptLayoutIds.length)
        : undefined
    const render = (components: unknown[], wrapped?: { head: Meta; chain: LayoutChain }) => {
      const layoutData = wrapped?.chain.layoutData
      return renderPageResult({
        adapter,
        chain: components,
        data,
        ...(wrapped === undefined ? {} : { head: wrapped.head }),
        ...localeOption(req),
        clientEntry,
        routeId: errorId,
        status: 500,
        hydrate: false,
        signal: req.signal,
        ...(layoutData === undefined ? {} : { layoutData }),
        ...(personalized || layoutData !== undefined ? { headers: PRIVATE_PAGE_HEADERS } : {}),
        ...(nonce === undefined ? {} : { nonce }),
        ...cspOption,
        ...titleOption,
      })
    }
    if (chain !== undefined) {
      const resolved = resolveChainAndHead(
        chain.modules,
        chain.layoutData,
        errorModule,
        statusMetaArgs(req, data, nonce),
      )
      try {
        return await render(resolved.chain, { head: resolved.head, chain })
      } catch {
        // A layout that fails to render leaves the error page alone, never a second error.
        return render([errorModule.default])
      }
    }
    // Layouts whose data did not settle still frame the error page, without their data.
    const layoutComponents = await Promise.all(
      keptLayoutIds.map((id) =>
        (manifest.layouts[id] as LayoutEntry).load().then((m) => m.default),
      ),
    )
    return render([...layoutComponents, errorModule.default])
  }

  /** The leading `count` layouts of `modules`, unless one of them answered with a status or redirect. */
  const settledLayouts = (
    modules: LoadedLayoutModules,
    layoutData: readonly unknown[] | undefined,
    count: number,
  ): LayoutChain | undefined => {
    if (modules.length < count) return undefined
    const data = layoutData?.slice(0, count)
    if (data?.some((value) => isControlFlow(value) || isStatusSignal(value))) return undefined
    return { modules: modules.slice(0, count), layoutData: data }
  }

  /** A run's leading layouts once all of its loaders settle - never when a layout or middleware refused. */
  const leadingLayouts =
    (run: LayoutRun | undefined, err?: unknown): LayoutChainSource =>
    async (_page, count) => {
      if (run === undefined || (err !== undefined && layoutErrorId(err) !== undefined)) {
        return undefined
      }
      try {
        await run.pending
      } catch {
        return undefined
      }
      return settledLayouts(run.modules, run.layoutData, count)
    }

  const rootLayoutIds: readonly string[] = manifest.layouts._layout === undefined ? [] : ["_layout"]
  const rootMiddlewareIds: readonly string[] =
    manifest.middlewares?._middleware === undefined ? [] : ["_middleware"]
  /**
   * Run the root middleware and layouts for a request no route ran them for (an unmatched URL), as a
   * nested `_404` runs its own. Any refusal or failure renders the page alone.
   */
  const rootLayoutsFor =
    (c: PageRouteContext<Env>, controls: PageResponseControls): LayoutChainSource =>
    async (page) => {
      const entry = manifest.statusPages?.["404"] ?? manifest.notFound
      if (rootLayoutIds.length === 0 || entry === undefined) return undefined
      const layoutsOnly: RouteEntry = {
        id: "_404",
        pattern: "/*",
        layoutIds: rootLayoutIds,
        errorIds: [],
        file: entry.file,
        load: entry.load,
      }
      const route: RouteEntry =
        rootMiddlewareIds.length === 0
          ? layoutsOnly
          : { ...layoutsOnly, middlewareIds: rootMiddlewareIds }
      try {
        const draft = await draftFlag(c.req)
        if (draft) controls.personalize()
        const ctx: LoaderContext = {
          params: {},
          request: c.req,
          req: c.req,
          api: apiFor(c),
          env: c.env,
          draft,
          search: loaderSearch(page.searchSchema, c.req),
          set: controls.scope(PAGE_SCOPE),
          live: NO_LIVE,
        }
        if (route.middlewareIds !== undefined) await runMiddleware(route, ctx, controls)
        const run = await runLayoutChain(route, ctx, controls)
        await run.pending
        return settledLayouts(run.modules, run.layoutData, rootLayoutIds.length)
      } catch {
        return undefined
      }
    }

  const renderTerminalStatus = async (
    status: number,
    req: Request,
    extraHeaders?: HeadersLike,
    nonce?: string,
    layouts?: LayoutChainSource,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.[String(status)] ?? manifest.notFound
    if (page === undefined) {
      const headers = new Headers(extraHeaders)
      headers.set("content-type", "text/plain; charset=utf-8")
      return new Response(STATUS_TEXT[status] ?? "Error", { status, headers })
    }
    const routeId = manifest.statusPages?.[String(status)] !== undefined ? `_${status}` : "_404"
    const loaded = await page.load()
    const wraps = loaded.inLayouts !== false && rootLayoutIds.length > 0
    const chain =
      wraps && layouts !== undefined ? await layouts(loaded, rootLayoutIds.length) : undefined
    const modules = chain?.modules ?? []
    const layoutIds = chain === undefined ? [] : rootLayoutIds
    const layoutData = chain?.layoutData
    const { chain: components, head } = resolveChainAndHead(
      modules,
      layoutData,
      loaded,
      statusMetaArgs(req, null, nonce),
    )
    let headers = extraHeaders
    if (layoutData !== undefined) {
      // The page now shows what a layout loaded for this visitor.
      const privateHeaders = new Headers(extraHeaders)
      privateHeaders.set("cache-control", PRIVATE_NO_STORE)
      headers = privateHeaders
    }
    const statusPage = {
      adapter,
      chain: components,
      data: null,
      head,
      clientEntry,
      routeId,
      matchChain: matchChainOf(layoutIds, modules, routeId, loaded),
      search: searchChainOf(modules, loaded, req),
      path: pathOf(req),
      status,
      signal: req.signal,
      // The browser renders this page inside the root layout, so a page that had to render alone
      // stays server-only, as a nested `_404` does.
      ...(wraps && chain === undefined ? { hydrate: false } : {}),
      ...(layoutData === undefined ? {} : { layoutData }),
      ...(headers !== undefined ? { headers } : {}),
      ...(nonce === undefined ? {} : { nonce }),
      ...cspOption,
      ...preloadOf(routeId),
      // The build keys stylesheets by route, so a page inside the root layout links the whole-app one.
      ...(chain === undefined ? stylesOf(routeId) : stylesFrom(options.styles)),
      ...prerenderedHandover,
      ...copyOption,
      ...localeOption(req),
      ...titleOption,
      ...slotsFor(layoutIds, routeId),
    }
    if (chain === undefined) return renderPageResult(statusPage)
    try {
      return await renderPageResult(statusPage)
    } catch {
      // A layout that fails to render leaves the status page alone, never a second error.
      return renderTerminalStatus(status, req, extraHeaders, nonce)
    }
  }

  const renderStatusSignal = async (
    req: Request,
    env: Env,
    signal: StatusSignal,
    personalized: boolean,
    layouts?: LayoutChainSource,
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
      return renderTerminalStatus(status, req, undefined, nonce, layouts)
    }
    const documentHeaders = new Headers(headers)
    if (headers !== undefined) {
      documentHeaders.set("vary", varyOnDataHeader(documentHeaders.get("vary")))
    }
    // A cookie queued before the signal makes the status page specific to this visitor.
    if (personalized) documentHeaders.set("cache-control", PRIVATE_NO_STORE)
    return renderTerminalStatus(status, req, documentHeaders, nonce, layouts)
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
    isData: boolean,
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
    serverComponents?: import("../server-components/types.ts").ComponentState,
    live?: LiveEnvelope,
  ): Promise<PageResponse> => {
    // Every layout loader settled before the page rendered, so a status or error page can reuse them.
    const settled: LayoutChainSource = async (_page, count) =>
      settledLayouts(layoutModules, layoutData, count)
    if (isStatusSignal(data)) return renderStatusSignal(req, env, data, personalized, settled)
    if (isControlFlow(data)) return data
    if (isData) {
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
        layoutData === undefined &&
        boundarySplit === undefined &&
        serverComponents === undefined &&
        live === undefined
          ? pageSplit.forClient
          : {
              v: 1 as const,
              data: pageSplit.forClient,
              layoutData: layoutSplits.map((split) => split.forClient),
              retained: layoutRetained,
              ...(boundarySplit === undefined ? {} : { boundaries: boundarySplit.forClient }),
              ...(serverComponents === undefined ? {} : { serverComponents }),
              ...(live === undefined ? {} : { live }),
            }
      if (allDeferred.length === 0) {
        return Response.json(payload ?? null, { headers: DATA_RESPONSE_HEADERS })
      }
      return new Response(ndjsonStream(payload, allDeferred, undefined, req.signal), {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          ...DATA_RESPONSE_HEADERS,
        },
      })
    }

    const nonce = options.nonce === undefined ? undefined : await resolveNonce(req, env)
    const { chain, head } = resolveChainAndHead(
      layoutModules,
      layoutData,
      mod,
      {
        data,
        pageData: data,
        params,
        origin: originFor(req),
        ...(nonce === undefined ? {} : { nonce }),
      },
      serverLeafOf(route, mod),
    )
    try {
      // Optional fields are assigned, not spread in: a conditional spread per field cost every
      // document request about 1us on Bun.
      const page: DocumentInput = {
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
        signal: req.signal,
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        ...appDocumentOptions,
        ...localeOption(req),
      }
      if (serverComponents !== undefined) page.serverComponents = serverComponents
      if (progressiveActionData.has(req)) page.actionData = progressiveActionData.get(req)
      const swapSlot = swapSlotOf(req)
      if (swapSlot !== undefined) page.swapSlot = swapSlot
      if (keepTable !== undefined) Object.assign(page, slotsFor(route.layoutIds, route.id))
      if (layoutData !== undefined) page.layoutData = layoutData
      if (boundaryStates !== undefined) page.boundaries = boundaryStates
      if (responseHeaders !== undefined) page.headers = responseHeaders
      // A response that sets a cookie is one visitor's: it never advertises ISR freshness.
      if (!personalized && options.cacheChannel?.enabled === true) {
        if (mod.revalidate !== undefined) page.revalidate = mod.revalidate
        if (mod.revalidateTags !== undefined) {
          page.revalidateTags = routeTags(
            mod.revalidateTags,
            { params, url: new URL(req.url) },
            route.id,
          )
        }
      }
      if (mod.islandScripts !== undefined) page.islandScripts = mod.islandScripts
      if (nonce !== undefined) page.nonce = nonce
      if (assemblyCache !== undefined) page.assemblyCache = assemblyCache
      return await renderPageResult(page)
    } catch (err) {
      if (isStatusSignal(err)) return renderStatusSignal(req, env, err, personalized, settled)
      if (isControlFlow(err)) throw err
      reportLoaderError(route, req, { ...params }, err)
      const errorId = boundaryFor(route, err)
      if (errorId === undefined) throw err
      options.logBoundaryError?.(err, req)
      return renderError(
        req,
        route,
        errorId,
        withDuplicateInstanceHint(err),
        personalized,
        nonce,
        settled,
      )
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
    layouts?: LayoutChainSource,
  ): Promise<PageResponse> => {
    if (isControlFlow(err)) throw err
    reportLoaderError(route, req, params, err)
    const errorId = boundaryFor(route, err)
    if (errorId === undefined) throw err
    options.logBoundaryError?.(err, req)
    if (req.headers.get(DATA_HEADER) !== null) {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    return renderError(
      req,
      route,
      errorId,
      withDuplicateInstanceHint(err),
      personalized,
      options.nonce === undefined ? undefined : await resolveNonce(req, env),
      layouts,
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
    const { chain, head } = resolveChainAndHead(layoutModules, layoutData, mod, {
      data: null,
      pageData: null,
      params,
      origin: originFor(req),
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
      signal: req.signal,
      ...localeOption(req),
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
    c: PageRouteContext<Env>,
    controls: PageResponseControls,
  ): Promise<PageResponse> => {
    const page = manifest.statusPages?.["404"] ?? manifest.notFound
    if (page === undefined) return renderTerminalStatus(404, c.req)
    return renderTerminalStatus(
      404,
      c.req,
      undefined,
      options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env),
      rootLayoutsFor(c, controls),
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
        const answer = dataRedirect(c.req, isDataRequest(c), outcome) ?? outcome
        return controls.personalized ? (privateOutcome(answer) as PageResponse) : answer
      } catch (err) {
        if (!isControlFlow(err)) throw err
        const answer = dataRedirect(c.req, isDataRequest(c), err)
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
      // One shell per locale: `<html lang>` is in it, and one route serves every locale.
      let assemblySlots = new Map<string, RenderAssemblyCache>()
      let assemblySlotMod: unknown
      let assemblySlotLayouts: LoadedLayoutModules | undefined
      const assemblyCacheFor = (
        mod: RouteModule,
        layouts: LoadedLayoutModules,
        req: Request,
      ): RenderAssemblyCache | undefined => {
        if (typeof mod.meta === "function") return undefined
        for (const layout of layouts) if (typeof layout.meta === "function") return undefined
        const layoutsUnchanged =
          assemblySlotLayouts !== undefined &&
          assemblySlotLayouts.length === layouts.length &&
          assemblySlotLayouts.every((layout, index) => layout === layouts[index])
        if (assemblySlotMod !== mod || !layoutsUnchanged) {
          assemblySlots = new Map()
          assemblySlotMod = mod
          assemblySlotLayouts = layouts
        }
        const key = i18n === undefined ? "" : i18n.localeOf(pathOf(req))
        let slot = assemblySlots.get(key)
        if (slot === undefined) {
          slot = {}
          assemblySlots.set(key, slot)
        }
        return slot
      }

      const page = async (
        c: PageRouteContext<Env>,
        controls: PageResponseControls,
      ): Promise<PageResponse> => {
        const live = liveLoadOf?.(c.req)
        const componentRuntime = options.serverComponents
        const componentOwner = componentRuntime?.owns(route.id) === true
        let componentRequest:
          | import("../server-components/protocol.ts").ComponentRequest
          | undefined
        try {
          componentRequest = componentRuntime?.classify(c.req, route.id)
        } catch (error) {
          return componentRuntime!.failure(error)
        }
        if (componentOwner || componentRequest !== undefined) controls.personalize()
        if (!componentOwner && is404Fallback && !prerenderedSet.has(urlPartsFor(c.req).pathname)) {
          return renderNotFound(c, controls)
        }
        const loaded = loadModule(route)
        const mod = cacheModules && !(loaded instanceof Promise) ? loaded : await loaded
        const draft = await draftFlag(c.req)
        // Unpublished content is the editor's alone: whatever cache-control a loader sets, no cache keeps it.
        if (draft) controls.personalize()
        let data: unknown
        let layoutData: readonly unknown[] | undefined
        let boundaryStates: BoundaryStates | undefined
        let layoutModules: LoadedLayoutModules | undefined
        let layoutRetained: readonly number[] = []
        let responseHeaders: Record<string, string> | undefined
        let componentState: import("../server-components/types.ts").ComponentState | undefined
        const requestApi = apiFor(c)
        let run: LayoutRun | undefined
        let skipPage = false
        let liveCtx: LoaderContext
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
            live: NO_LIVE,
          }
          if (route.middlewareIds !== undefined || localeGuarded(route)) {
            await runMiddleware(route, ctx, controls)
          }
          // After middleware, before any loader: a grant issued to another viewer keeps nothing.
          const retains = live === undefined || (await live.bind(ctx))
          skipPage =
            live !== undefined &&
            retains &&
            !componentOwner &&
            live.retainPage &&
            live.routeId === route.id
          run = await runLayoutChain(
            route,
            ctx,
            controls,
            componentOwner || !retains ? undefined : retainContextOf(c),
            undefined,
            live,
          )
          layoutModules = run.modules
          layoutRetained = run.retained
          const boundaryDefinitions =
            componentRequest === undefined
              ? [
                  ...run.modules.flatMap((layout) => layout.boundaries ?? []),
                  ...(mod.boundaries ?? []),
                ]
              : []
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
                  { phase: "build" },
                  options.staticBoundaryCache,
                )
          const pageResult =
            mod.loader === undefined || skipPage
              ? null
              : live === undefined
                ? mod.loader({ ...ctx, search: effectiveSearch })
                : runLiveLoader(live, `P:${route.id}`, mod.loader, {
                    ...ctx,
                    search: effectiveSearch,
                  })
          const [pageData, , staticBoundaries] =
            run.pending === undefined && staticBoundaryPromise === undefined
              ? ([await pageResult, undefined, undefined] as const)
              : staticBoundaryPromise === undefined
                ? await Promise.all([pageResult, run.pending])
                : await Promise.all([pageResult, run.pending, staticBoundaryPromise])
          data = pageData
          layoutData = run.layoutData
          if (componentOwner) {
            for (let i = 0; i < (layoutData?.length ?? 0); i++) {
              const outcome = layoutData?.[i]
              if (isControlFlow(outcome) || isStatusSignal(outcome))
                throw tagLayoutError(outcome, route.layoutIds[i] as string)
            }
          }
          if (componentRequest !== undefined && (isControlFlow(data) || isStatusSignal(data)))
            return componentRuntime!.failure(data)
          if (componentOwner && !isControlFlow(data) && !isStatusSignal(data)) {
            const componentContext = Object.create(
              c,
              Object.getOwnPropertyDescriptors({
                ...ctx,
                search: effectiveSearch,
                signal:
                  c.signal === undefined ? c.req.signal : AbortSignal.any([c.signal, c.req.signal]),
                data,
                layoutData: layoutData ?? [],
              }),
            )
            componentState = await componentRuntime!.execute(
              route.id,
              componentContext,
              componentRequest,
              options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env),
            )
          }
          if (boundaryBatch !== undefined) {
            // Each resolver returns a state for every boundary and marks the other's modes
            // `unresolved`, so a slot takes its state from the resolver of its own mode.
            const streamed = { ...boundaryBatch.initial }
            for (const [name, state] of Object.entries(staticBoundaries ?? {}))
              if (state.mode === "static") streamed[name] = state
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
          liveCtx = ctx
        } catch (err) {
          if (componentRequest !== undefined) return componentRuntime!.failure(err)
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
              )) ??
              renderStatusSignal(c.req, c.env, err, controls.personalized, leadingLayouts(run, err))
            )
          }
          return renderLoaderFailure(
            route,
            c.req,
            c.env,
            c.params,
            err,
            controls.personalized,
            leadingLayouts(run, err),
          )
        }
        if (componentRequest !== undefined && componentState !== undefined) {
          const answer = componentRuntime!.response(componentState, componentRequest)
          const headers = new Headers(answer.headers)
          for (const [name, value] of Object.entries(responseHeaders ?? {}))
            if (name !== "cache-control" && name !== "content-type" && name !== "vary")
              headers.set(name, value)
          return new Response(answer.body, { status: answer.status, headers })
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
        const isData = isDataRequest(c)
        const liveEnvelope =
          live === undefined || !isData || isStatusSignal(data) || isControlFlow(data)
            ? undefined
            : await live.finish(
                liveOwners(
                  route,
                  layoutModules,
                  layoutData,
                  layoutRetained,
                  mod,
                  skipPage,
                  liveCtx,
                ),
              )
        return handleDataOrDocument(
          c.req,
          isData,
          c.env,
          route,
          c.params,
          mod,
          data,
          layoutData,
          layoutModules ?? (await loadLayoutModules(route)),
          layoutRetained,
          boundaryStates,
          layoutModules === undefined ? undefined : assemblyCacheFor(mod, layoutModules, c.req),
          responseHeaders,
          controls.personalized,
          componentState,
          liveEnvelope,
        )
      }
      return withResponseControls(liveLoadOf === undefined ? page : admitLive(page))
    },

    post: (route) =>
      withResponseControls(async (c, controls) => {
        const loaded = loadModule(route)
        const mod = cacheModules && !(loaded instanceof Promise) ? loaded : await loaded
        const draft = await draftFlag(c.req)
        if (draft) controls.personalize()
        if (mod.action === undefined) {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
          })
        }
        const isDataRequest = c.req.headers.get(DATA_HEADER) !== null
        // Before anything runs: a form posts cross-site without a preflight and carries the visitor's
        // cookies, so an action is a CSRF target unless its route names the origins it accepts.
        const origin = c.req.headers.get("origin")
        const allowedOrigins = mod.allowedOrigins
        const allowed =
          allowedOrigins === undefined
            ? origin === null ||
              isSameOriginForm(origin, c.req.headers.get("sec-fetch-site"), c.req)
            : typeof allowedOrigins === "function"
              ? allowedOrigins(origin) === true
              : origin !== null && allowedOrigins.includes(origin)
        if (!allowed) {
          return isDataRequest
            ? Response.json(
                { ok: false, error: "forbidden_origin" },
                { status: 403, headers: { "cache-control": PRIVATE_NO_STORE } },
              )
            : new Response("Forbidden", {
                status: 403,
                headers: {
                  "content-type": "text/plain; charset=utf-8",
                  "cache-control": PRIVATE_NO_STORE,
                },
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
          live: NO_LIVE,
        }
        let gated: GatedLayouts
        let result: unknown
        try {
          if (route.middlewareIds !== undefined || localeGuarded(route)) {
            await runMiddleware(route, actionContext, controls)
          }
          gated = await runLayoutGates(route, actionContext, controls)
          result = await mod.action(actionContext)
        } catch (err) {
          if (isControlFlow(err)) return err
          throw err
        }
        const revalidation = isRevalidateResult(result) ? result : undefined
        const actionResult = revalidation === undefined ? result : revalidation.data
        const revalidateHeader: Record<string, string> =
          revalidation === undefined
            ? {}
            : { [REVALIDATE_HEADER]: revalidation.__nifraRevalidate.join(",") }
        // The write is done, whatever the action answers with (a redirect included): what it made
        // stale is invalidated before the answer leaves.
        const settling =
          revalidation === undefined ? undefined : options.invalidate?.(revalidation, c.req)
        if (settling !== undefined) await settling
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
          return new Response(ndjsonStream(forClient, deferred, undefined, c.req.signal), {
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8",
              ...DATA_RESPONSE_HEADERS,
              ...revalidateHeader,
            },
          })
        }
        if (options.serverComponents?.owns(route.id)) {
          if (options.rerenderOwnerGET === undefined) throw new Error("component_contract")
          const actionHeaders = controls.documentHeaders()
          if (controls.progressiveRedirect(c.req)) {
            // Relative, so a browser behind a TLS terminator stays on its own scheme. A `//` path
            // would read as another host, so that one keeps the absolute URL.
            const { pathname, search } = new URL(c.req.url)
            const location = pathname.startsWith("//") ? c.req.url : pathname + search
            return new Response(null, {
              status: 303,
              headers: { ...actionHeaders, location, "cache-control": PRIVATE_NO_STORE },
            })
          }
          const headers = new Headers(c.req.headers)
          for (const name of [
            DATA_HEADER,
            RETAIN_HEADER,
            NAV_FROM_HEADER,
            "x-nifra-component",
            "content-type",
            "content-length",
            "transfer-encoding",
          ])
            headers.delete(name)
          const cookie = controls.progressiveCookies(c.req)
          if (cookie) headers.set("cookie", cookie)
          else headers.delete("cookie")
          const request = new Request(c.req.url, {
            method: "GET",
            headers,
            signal:
              c.signal === undefined ? c.req.signal : AbortSignal.any([c.signal, c.req.signal]),
          })
          progressiveActionData.set(request, actionResult)
          try {
            const response = await options.rerenderOwnerGET(request, c)
            const merged = new Headers(response.headers)
            for (const [name, value] of Object.entries(actionHeaders ?? {}))
              if (!merged.has(name)) merged.set(name, value)
            merged.set("cache-control", PRIVATE_NO_STORE)
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers: merged,
            })
          } finally {
            progressiveActionData.delete(request)
          }
        }
        const layoutModules = gated.modules
        const search = searchChainOf(layoutModules, mod, c.req)
        let run: LayoutRun | undefined
        let data: unknown
        let responseHeaders: Record<string, string> | undefined
        // The ordinary layout loaders run now, after the mutation, as a GET of this page would.
        try {
          run = await runLayoutChain(route, actionContext, controls, undefined, gated)
          const pageResult = mod.loader
            ? mod.loader({
                params: c.params,
                request: c.req,
                req: c.req,
                api: requestApi,
                env: c.env,
                draft,
                search,
                set: controls.scope(PAGE_SCOPE),
                live: NO_LIVE,
              })
            : null
          const [pageData] =
            run.pending === undefined
              ? ([await pageResult] as const)
              : await Promise.all([pageResult, run.pending])
          data = pageData
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
              )) ??
              renderStatusSignal(c.req, c.env, err, controls.personalized, leadingLayouts(run, err))
            )
          }
          return renderLoaderFailure(
            route,
            c.req,
            c.env,
            c.params,
            err,
            controls.personalized,
            leadingLayouts(run, err),
          )
        }
        // The re-render answers a returned redirect or status the way the page's GET does.
        if (isStatusSignal(data))
          return (
            (await renderRouteNotFound(
              c.req,
              c.env,
              route,
              c.params,
              data,
              run,
              controls.personalized,
            )) ??
            renderStatusSignal(c.req, c.env, data, controls.personalized, leadingLayouts(run, data))
          )
        if (isControlFlow(data)) return data
        const layoutData = run.layoutData
        const layoutProps: { layoutData?: Exclude<typeof layoutData, undefined> } = {}
        if (layoutData !== undefined) {
          layoutProps.layoutData = layoutData
          // The page now shows what a layout loaded for this visitor.
          responseHeaders = { ...responseHeaders, ...PRIVATE_PAGE_HEADERS }
        }
        const nonce = options.nonce === undefined ? undefined : await resolveNonce(c.req, c.env)
        const { chain, head } = resolveChainAndHead(
          layoutModules,
          layoutData,
          mod,
          {
            data,
            pageData: data,
            params: c.params,
            origin: originFor(c.req),
            ...(nonce === undefined ? {} : { nonce }),
          },
          serverLeafOf(route, mod),
        )
        const page: DocumentInput = {
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
          signal: c.req.signal,
          ...layoutProps,
          ...preloadOf(route.id),
          ...stylesOf(route.id),
          ...prerenderedHandover,
          ...copyOption,
          ...localeOption(c.req),
          ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
          ...(nonce === undefined ? {} : { nonce }),
          ...cspOption,
          ...titleOption,
          ...swapOption(c.req),
          ...slotsFor(route.layoutIds, route.id),
        }
        if (mod.islandScripts !== undefined) page.islandScripts = mod.islandScripts
        return renderPageResult(page)
      }),

    matchRoute: (path) => {
      const matched = matchManifestRoute(path)
      const route = matched === null ? undefined : routeById.get(matched.routeId)
      return route === undefined ? null : { routeId: route.id, layoutIds: route.layoutIds }
    },

    fallback: withResponseControls(async (c, controls) => {
      const match = matchNotFoundScope?.(pathOf(c.req)) ?? null
      const target = match === null ? undefined : notFoundTargets[Number(match.routeId)]
      if (match === null || target === undefined) {
        return renderNotFound(c, controls)
      }
      const params: Record<string, string> = {}
      for (let i = 0; i < target.names.length; i++) {
        params[target.names[i] as string] = match.params[`p${i}`] as string
      }
      const mod = await target.page.load()
      const draft = await draftFlag(c.req)
      if (draft) controls.personalize()
      let run: LayoutRun | undefined
      try {
        const ctx: LoaderContext = {
          params,
          request: c.req,
          req: c.req,
          api: apiFor(c),
          env: c.env,
          draft,
          search: loaderSearch(mod.searchSchema, c.req),
          set: controls.scope(PAGE_SCOPE),
          live: NO_LIVE,
        }
        if (target.route.middlewareIds !== undefined) {
          await runMiddleware(target.route, ctx, controls)
        }
        run = await runLayoutChain(target.route, ctx, controls)
        await run.pending
      } catch (err) {
        if (isStatusSignal(err)) {
          return renderStatusSignal(
            c.req,
            c.env,
            err,
            controls.personalized,
            leadingLayouts(run, err),
          )
        }
        return renderLoaderFailure(
          target.route,
          c.req,
          c.env,
          params,
          err,
          controls.personalized,
          leadingLayouts(run, err),
        )
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
