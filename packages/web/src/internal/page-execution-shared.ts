import {
  type BackendPlatformBinder,
  NIFRA_BACKEND_BIND_PLATFORM,
  NIFRA_PLATFORM_CLIENT_IP_DERIVED,
} from "@nifrajs/core/mount"
import { type ResponseResult, status as statusResult } from "@nifrajs/core/server"
import type { StaticBoundaryCache } from "../boundary.ts"
import type { CspPolicy } from "../csp.ts"
import type { CssLoadingMode } from "../css-contract.ts"
import { type Deferred, defer } from "../deferred.ts"
import type {
  LoaderContext,
  LoaderResponseControls,
  Manifest,
  NotFoundEntry,
  RouteEntry,
  RouteModule,
} from "../manifest.ts"
import type { NonceResolver } from "../nonce.ts"
import type { PageLocales, RenderAdapter } from "../render-seam.ts"
import { SWAP_HEADER } from "../render-seam.ts"
import { DATA_HEADER, HOLE_FILL_HEADER, KEEP_HOLES_HEADER, REDIRECT_HEADER } from "../router.ts"
import {
  holeOwner,
  type LiveEnvelope,
  type LiveFinish,
  type LiveLoad,
  type LiveRouteMatch,
} from "./live-contract.ts"
import { forkLoaderContext } from "./loader-context.ts"
import type { HoleLive, PprIntegration, PprRequest } from "./ppr/contract.ts"
import {
  isResponseResult,
  type LoadedLayoutModules,
  type RenderedPage,
  type RenderPageOptions,
  type RevalidateResult,
} from "./render-document.ts"
import { type CoreResponseControls, DATA_RESPONSE_HEADERS } from "./response-controls.ts"

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
export const SLOT_NAME = /^[A-Za-z][\w-]{0,63}$/

/** The slot an `x-nifra-swap` request names, when it is a valid slot name. */
export function swapSlotOf(req: Request): string | undefined {
  const name = req.headers.get(SWAP_HEADER)
  return name !== null && SLOT_NAME.test(name) ? name : undefined
}

/** The `swapSlot` render option for `req`, empty when it is not a swap request. */
export function swapOption(req: Request): { readonly swapSlot?: string } {
  const swapSlot = swapSlotOf(req)
  return swapSlot === undefined ? {} : { swapSlot }
}

export const headerOf = (c: PageRouteContext<unknown>, name: string): string | null =>
  c.header !== undefined ? c.header(name) : c.req.headers.get(name)

export function isDataRequest(c: PageRouteContext<unknown>): boolean {
  return headerOf(c, DATA_HEADER) !== null
}

/** The live owners of one response's holes, settled once the last hole that ran does. */
export interface HoleOwners {
  readonly kept: readonly string[]
  readonly loaded: Promise<readonly string[]>
}

/**
 * A data request's hole refresh: the hosts the client holds, which reload as fills, the holes it
 * keeps, and in a live load each hole's owner. A name the route does not declare is a 400.
 */
export function holeRefresh(
  c: PageRouteContext<unknown>,
  request: PprRequest,
  live: LiveLoad | undefined,
): { readonly request: PprRequest; readonly owners?: HoleOwners } | Response {
  if (!isDataRequest(c)) return { request }
  const declared = new Set(request.holes.map((hole) => hole.name))
  const namesOf = (header: string): Set<string> | undefined => {
    const value = headerOf(c, header)
    const names = new Set<string>()
    if (value === null) return names
    for (const name of value.split(",")) {
      const trimmed = name.trim()
      if (declared.has(trimmed)) names.add(trimmed)
      // A live load's names come from a grant this server sealed and the page's own client: one
      // naming a hole an older build declared is skipped.
      else if (live === undefined) return undefined
    }
    return names
  }
  const kept = namesOf(KEEP_HOLES_HEADER)
  const fill = namesOf(HOLE_FILL_HEADER)
  if (kept === undefined || fill === undefined) {
    return new Response("Bad Request: the route has no such hole", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    })
  }
  const refreshed: PprRequest = {
    ...request,
    ...(fill.size === 0 ? {} : { fill }),
    ...(kept.size === 0 ? {} : { kept }),
  }
  if (live === undefined) return { request: refreshed }
  const routeId = request.routeId
  let finish: (loaded: readonly string[]) => void = () => {}
  const loaded = new Promise<readonly string[]>((resolve) => {
    finish = resolve
  })
  const holeLive: HoleLive = {
    collector: (hole) => live.collector(holeOwner(hole, routeId)),
    seal: (hole) => live.seal(holeOwner(hole, routeId)),
    done: (names) => finish(names.map((hole) => holeOwner(hole, routeId))),
  }
  return {
    request: { ...refreshed, live: holeLive },
    owners: { kept: [...kept].map((hole) => holeOwner(hole, routeId)), loaded },
  }
}

/** The page slot of an `ssr = false` route with no `HydrateFallback`: a component that renders nothing. */
export const EMPTY_LEAF = (): null => null

/** `ctx.live` outside a live load: keys are declared for nobody. */
export const NO_LIVE = (): void => {}

export const headersSent = (): never => {
  throw new TypeError(
    "[nifra/web] ppr: a hole's server component cannot set a cookie: the shell already sent the headers",
  )
}

/** A hole's response headers went out with the shell, so its server component sets none. */
export const SENT_CONTROLS: LoaderResponseControls = Object.freeze({
  headers: Object.freeze({}),
  cookie: headersSent,
  deleteCookie: headersSent,
})

/**
 * The envelope's `live` member. With holes running it trails them: one grant, issued once the last hole
 * settled, holding each hole that loaded and each the client kept.
 */
export const liveEnvelopeOf = (
  live: LiveLoad,
  owners: LiveFinish,
  holes: HoleOwners | undefined,
): Promise<LiveEnvelope> | Deferred<LiveEnvelope> =>
  holes === undefined
    ? live.finish(owners)
    : defer(
        holes.loaded.then((loaded) =>
          live.finish({
            ...owners,
            fresh: [...owners.fresh, ...loaded],
            retained: [...owners.retained, ...holes.kept],
          }),
        ),
      )

/** Run one owner's loader with its `ctx.live`, closing the collector once the loader settles. */
export const runLiveLoader = (
  live: LiveLoad,
  owner: string,
  loader: (ctx: LoaderContext) => unknown,
  ctx: LoaderContext,
): Promise<unknown> => {
  let value: unknown
  try {
    value = loader(forkLoaderContext(ctx, { live: live.collector(owner) }))
  } catch (err) {
    live.seal(owner)
    return Promise.reject(err)
  }
  return Promise.resolve(value).finally(() => live.seal(owner))
}

/** The request-scoping seam of an in-process `api` (see `inProcessClient`), if it carries one. */
export function platformBinderOf(api: unknown): BackendPlatformBinder | undefined {
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
export class LoaderPlatform {
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
export function dataRedirect(
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
export function appTarget(location: string, requestUrl: string): string {
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
export const LOCALE_SEGMENTS: ReadonlySet<string> = new Set(["[lang]", "[[lang]]"])

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
  /** The seed a rendered document collects its keys into; only set when the app configures `live`. */
  readonly liveSeedOf?: ((request: Request, routeId: string) => LiveLoad | undefined) | undefined
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
  /** Partial prerendering: routes with a `shellLoader` stream a shared shell, then holes. */
  readonly ppr?: PprIntegration
}

export type PageResponse = Response | ResponseResult | RenderedPage

export interface PageRequestExecutor<Env = unknown> {
  get(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  post(route: RouteEntry): (ctx: PageRouteContext<Env>) => Promise<PageResponse>
  /** Answer a URL no route matched: the nearest nested `_404` for it, else the root one. */
  fallback(ctx: PageRouteContext<Env>): Promise<PageResponse>
  /** The route a `pathname + search` renders, with its layout chain. */
  matchRoute(path: string): LiveRouteMatch | null
}

/** One URL pattern a nested `_404` answers, as the executor indexes it. */
export interface NotFoundTarget {
  readonly id: string
  readonly page: NotFoundEntry
  /** The pattern's param names in order; the index holds them by position. */
  readonly names: readonly string[]
  /** The page's layout chain as a route, so layouts, gates and boundaries run as they do for one. */
  readonly route: RouteEntry
}

/** The browser's side of a client navigation: the page it is leaving and the layout slots it holds. */
export type RetainContext = {
  readonly requested: ReadonlySet<number>
  readonly from: RouteEntry
  readonly fromParams: Readonly<Record<string, string>>
  readonly fromUrl: URL
  readonly toUrl: URL
}

export type LayoutRun = {
  readonly modules: LoadedLayoutModules
  readonly layoutData: readonly unknown[] | undefined
  readonly retained: readonly number[]
  readonly pending: Promise<unknown> | undefined
}

/** A route's layouts after only their gates ran: `gates[i]` is gate `i`'s value. */
export type GatedLayouts = {
  readonly modules: LoadedLayoutModules
  readonly gates: readonly unknown[]
}

/** Layouts whose loaders settled for this request: what a status or error page renders in. */
export type LayoutChain = {
  readonly modules: LoadedLayoutModules
  readonly layoutData: readonly unknown[] | undefined
}

/**
 * Not called for a page that exports `inLayouts = false`, so such a page runs no layout loader.
 * `undefined` renders the page alone.
 */
export type LayoutChainSource = (
  page: RouteModule,
  count: number,
) => Promise<LayoutChain | undefined>

/** A document's render input, filled in field by field. */
export type DocumentInput = { -readonly [K in keyof RenderPageOptions]: RenderPageOptions[K] } & {
  readonly clientEntry: string
  readonly hydrate: boolean
}
