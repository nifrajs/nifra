import {
  admitDeadline,
  createRequestBudget,
  createUnboundedRequestBudget,
  type DeadlineAdmissionOptions,
  NIFRA_DEADLINE_HEADER,
  type RequestBudget,
} from "../budget.ts"
import type { EffectLifecycleObserver } from "../effect-lifecycle.ts"
import { FrameworkError, RouteConfigError } from "../errors.ts"
import {
  type AroundCapabilityOptions,
  CAPABILITY_GUARD,
  type CapabilityInterceptor,
  type CapabilityUseEvent,
  createCapabilityGuard,
  DEFAULT_CAPABILITY_INTERCEPTOR_TIMEOUT_MS,
  normalizeRouteCapabilities,
  type RegisteredCapabilityInterceptor,
} from "../internal/capability-runtime.ts"
import {
  type AssuranceDeclaration,
  assuranceDeclarationsOf,
  assuranceEvidenceFor,
  NIFRA_ASSURANCE_IDS,
  validEvidenceId,
} from "../internal/route-assurance.ts"
import { type CatalogRoute, RouteCatalog } from "../internal/route-catalog.ts"
import type {
  ContextRouteRunner,
  FusedBodyRunner,
  FusedWebRunner,
  InternalHandler,
  RawAfterHandle,
  RawAround,
  RawBeforeHandle,
  RawDerive,
  RawErrorHandler,
  RouteEntry,
  RouteExecutionPlan,
  RouteExecutionRunner,
} from "../internal/route-execution.ts"
import { isSameOriginRequest } from "../internal/same-origin.ts"
import type { RequestLedger } from "../ledger.ts"
import { compileRoutePattern, decodeRouteParams } from "../router/pattern.ts"
import { EMPTY_PARAMS, type Method, Router } from "../router/router.ts"
import type {
  InferOutput,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
} from "../schema/standard.ts"
import { assertByteLimit, parseContentLength } from "./body.ts"
import { type ClientIpTrust, resolveClientIp } from "./client-ip.ts"
import type { Context, Platform, ResponseControls, RouteSchema } from "./context.ts"
import { jsonError, pathnameOf, type UrlParts, urlPartsOf } from "./http.ts"
import { type NodeServeOutcome, withStaticNodeHeaders } from "./node-outcome.ts"
import {
  type NodeOutcomeRuntime,
  type NodeRequestContext,
  type NodeRequestHook,
  type NodeResponseContext,
  type NodeResponseHook,
  type ResponseBodyHook,
  type ResponseBodyReplacement,
  type ResponseHeadersHook,
  type ResponseHeadersView,
  recordHeadersView,
} from "./node-outcome-hook.ts"
import {
  isUrlEncodedForm,
  type QueryValue,
  queryObjectOf,
  readBoundedForm,
  searchOf,
} from "./query.ts"
import { RequestContext, readBoundedJsonSource } from "./request-context.ts"
import {
  applyStaticResponseHeaders,
  buildStaticResponseHeaders,
  fusedRespond,
  fusedRespondNoSet,
  knownMutableHeaders,
  markTaggedResponse,
  rememberMutableHeaders,
  taggedResponseBody,
  taggedResponseOwner,
  toResponse,
} from "./respond.ts"
// Type-only: erased, so the kernel never pulls the lane's implementation into a bundle that does not
// install the plugin. The value side arrives through the symbol-keyed install seam.
import type { ResponseContractRuntime } from "./response-contract-lane.ts"
import {
  CONTEXT_SEARCH,
  CONTEXT_SET,
  EMPTY_RESPONSE_CONTROLS,
  getNeverAbortSignal,
  getUnboundedRequestBudget,
  type HandlerResult,
  headerOf,
  requestOf,
} from "./runtime-core.ts"
import { normalizeStaticResponseHeaders, type StaticResponseHeaders } from "./static-headers.ts"

// NodeServeOutcome (the nifra<->node bridge render form) now lives in `./node-outcome.ts`; re-exported
// so existing importers keep resolving it from the server module.
export type {
  NodeRequestContext,
  NodeRequestHook,
  NodeResponseContext,
  NodeResponseHook,
  NodeServeOutcome,
  ResponseBodyHook,
  ResponseBodyReplacement,
  ResponseHeadersHook,
  ResponseHeadersView,
}

function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

/** Apply a body hook's return to the native response context (bytes, or a structured replacement). */
function applyBodyReplacement(
  response: NodeResponseContext,
  replaced: string | Uint8Array | ResponseBodyReplacement | undefined,
): void {
  if (replaced === undefined) return
  if (typeof replaced === "string" || replaced instanceof Uint8Array) {
    response.body = isBodylessStatus(response.status) ? null : replaced
    return
  }
  if (replaced.body !== undefined) response.body = replaced.body
  if (replaced.status !== undefined) response.status = replaced.status
  if (isBodylessStatus(response.status)) response.body = null
}

/** Swap a tagged Response's body for a hook's replacement, re-tagging so later body hooks (and the
 * Node fallback's direct writer) see the new bytes; explicit lengths are dropped so framing is
 * re-derived from what actually ships. */
function withReplacedBody(
  response: Response,
  replaced: string | Uint8Array | ResponseBodyReplacement | undefined,
): Response {
  if (replaced === undefined) return response
  const originalBody = taggedResponseBody(response)
  let body: string | Uint8Array | null
  let status = response.status
  if (typeof replaced === "string" || replaced instanceof Uint8Array) {
    body = replaced
  } else {
    body = replaced.body !== undefined ? replaced.body : (originalBody ?? null)
    if (replaced.status !== undefined) status = replaced.status
    if (body === (originalBody ?? null) && status === response.status) {
      return response
    }
  }
  if (isBodylessStatus(status)) body = null
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const next = new Response(body as ConstructorParameters<typeof Response>[0], {
    status,
    headers,
  })
  if (body !== null) markTaggedResponse(next, body, taggedResponseOwner(response))
  return next
}

const HEADER_MUTABILITY_PROBE = "x-nifra-header-probe"
const GUARDED_RESPONSE_HEADERS = new WeakSet<Headers>()

/**
 * Detect a guarded Web Headers object before invoking user code. Retrying after catching any
 * TypeError is observably wrong: user hooks are allowed to throw TypeError themselves, and a retry
 * runs those hooks twice. The hot path never reaches the probe: every framework-constructed
 * Response stamps its headers as known-mutable at construction (see respond.ts), so only a
 * handler-returned foreign `Response` - the case that can actually be guarded - pays it, once per
 * headers object. The probe uses a valid private header name and restores a pre-existing value, so
 * the fallback is limited to the actual immutable/guarded-header case.
 */
function hasMutableResponseHeaders(headers: Headers): boolean {
  if (knownMutableHeaders(headers)) return true
  if (GUARDED_RESPONSE_HEADERS.has(headers)) return false
  let previous: string | null = null
  try {
    previous = headers.get(HEADER_MUTABILITY_PROBE)
    headers.set(HEADER_MUTABILITY_PROBE, "1")
    if (previous === null) headers.delete(HEADER_MUTABILITY_PROBE)
    else headers.set(HEADER_MUTABILITY_PROBE, previous)
    rememberMutableHeaders(headers)
    return true
  } catch {
    try {
      if (previous === null) headers.delete(HEADER_MUTABILITY_PROBE)
      else headers.set(HEADER_MUTABILITY_PROBE, previous)
    } catch {
      // The guarded object rejected the cleanup too; the clone below is authoritative.
    }
    GUARDED_RESPONSE_HEADERS.add(headers)
    return false
  }
}

/** Adapt a portable {@link ResponseBodyHook} into the Web `onResponse` walk. Only a Response
 * carrying the framework-buffered body tag participates - a raw or streamed Response is skipped by
 * contract, never drained. */
function webResponseBodyHook(
  fn: ResponseBodyHook,
  owners: ReadonlySet<object>,
): (response: Response, req: Request) => MaybePromise<Response> {
  return (response, req) => {
    const body = taggedResponseBody(response, owners)
    if (body === undefined) return response
    const out = fn(body, response.headers, webRequestView(req), response.status)
    if (out instanceof Promise) return out.then((replaced) => withReplacedBody(response, replaced))
    return withReplacedBody(response, out)
  }
}

/** Minimal request view over a Web `Request` for portable header hooks on the Web serving paths. */
function webRequestView(req: Request): NodeRequestContext {
  return { method: req.method, url: req.url, header: (name) => req.headers.get(name) }
}

/**
 * Adapt a portable {@link ResponseHeadersHook} into the Web `onResponse` walk: run it against the
 * response's own `Headers` in place (no clone). A response whose headers are GUARDED (a raw
 * `fetch()`ed Response returned by a handler) throws on the FIRST mutation, so nothing was applied
 * yet - rerun once against a mutable copy. Async hooks should perform their mutations before their
 * first await for the guard fallback to cover them.
 */
function webResponseHeadersHook(
  fn: ResponseHeadersHook,
): (response: Response, req: Request) => MaybePromise<Response> {
  return (response, req) => {
    const view = webRequestView(req)
    if (!hasMutableResponseHeaders(response.headers)) {
      const clone = new Response(response.body, response)
      const out = fn(clone.headers, view, clone.status)
      return out instanceof Promise ? out.then(() => clone) : clone
    }
    const out = fn(response.headers, view, response.status)
    return out instanceof Promise ? out.then(() => response) : response
  }
}

/** Adapt a raw-response fallback hook. Tagged framework payloads already ran through the body tier,
 * while untagged Responses include streams, proxied fetches, and framework-generated error responses. */
function webResponseRawHook(
  fn: (response: Response, req: Request) => MaybePromise<Response>,
  owners: ReadonlySet<object>,
): (response: Response, req: Request) => MaybePromise<Response> {
  return (response, req) => {
    if (taggedResponseBody(response, owners) !== undefined) return response
    return fn(response, req)
  }
}

import type { IdempotencyRuntime } from "./idempotency-lane.ts"
import {
  INSTALL_EFFECT_LEDGER,
  INSTALL_IDEMPOTENCY,
  INSTALL_MCP,
  INSTALL_NODE_DIRECT,
  INSTALL_RESPONSE_CONTRACT,
  INSTALL_SSE,
  INSTALL_WS,
} from "./install.ts"
import type { EffectLedgerRuntime, ResolvedEffectLedger } from "./ledger-lane.ts"
import { jsonLogger, type Logger } from "./logger.ts"
import type { McpRuntime } from "./mcp-hook.ts"
import type { IdentityPlugin } from "./plugin.ts"
import type {
  AddRoute,
  EmptyRegistry,
  OutputOf,
  Registry,
  RouteInfoFor,
  WsRouteInfoFor,
} from "./registry.ts"
import type {
  AdmissionController,
  AdmissionDecision,
  McpPromptDescriptor,
  McpResourceDescriptor,
  Middleware,
  PromptArgument,
  PromptMessage,
  ResponseFinalization,
  RouteDescriptor,
  RunningServer,
  ServerOptions,
  ToolAnnotations,
} from "./server-types.ts"
import type { SSEInit, TypedSSEStream } from "./sse.ts"
import type { SseRuntime } from "./sse-hook.ts"
import type {
  TopicRegistry,
  WebSocketContext,
  WebSocketHandler,
  WebSocketUpgradeOutcome,
} from "./websocket.ts"
import type { BunWsData } from "./ws-bun.ts"
import type { WsRuntime } from "./ws-hook.ts"

export type MaybePromise<T> = T | Promise<T>

/**
 * Internal request view. A real Web `Request` already satisfies this shape, so Web/edge runtimes pass
 * their `Request` **directly** (zero wrapper allocation on the hot path - `request` is simply absent and
 * {@link requestOf} returns the source itself). Node's adapter passes a *lazy* source whose `request`
 * getter builds an undici `Request` only when user code reads `c.req`, an onRequest/onResponse hook
 * needs it, or a body helper consumes it - so the common Node request never pays for a `Request` build.
 */
export interface RequestSource {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  header?(name: string): string | null
  /** Pre-split pathname/search, when the source already had the origin-form target (the Node lazy
   * sources do) - saves synthesizing an absolute URL only to scan it apart again. */
  readonly urlParts?: UrlParts
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
  /** Present only when materializing a `Request` is non-trivial (the Node lazy source); for a real
   * `Request` passed as the source it's absent and {@link requestOf} returns the source itself. */
  readonly request?: Request
}

/** The empty context extension. `NonNullable<unknown>` is `{}` without tripping noBannedTypes. */
type EmptyContext = NonNullable<unknown>

/**
 * Extracts the app's platform `Env` from its context `Ctx`. `server<Env>()` seeds `Ctx` with
 * `{ env: Env }`, so this pulls that back out to type `fetch`/`toFetchHandler`'s `env` argument
 * against the app's declared bindings. Defaults to `unknown` when no env was declared.
 */
type EnvOf<Ctx> = Ctx extends { readonly env: infer E } ? E : unknown

type ContextlessHandler = () => MaybePromise<HandlerResult>

const functionToString = Function.prototype.toString
const CONTEXTLESS_ARROW = /^(?:async\s*)?\(\s*\)\s*(?::[\s\S]*?)?=>/

/** Internal, path-erased runtime context. The typed `Context<Path, S>` is a structural view of this. */
export interface RawContext {
  readonly req: Request
  readonly request: Request
  readonly json: (body: unknown, init?: ResponseInit | number) => Response
  readonly text: (body: string, init?: ResponseInit | number) => Response
  // Writable: the lifecycle replaces it with the validated/coerced value when a `params` schema is
  // declared (handlers still see it `readonly` via the public `Context` interface).
  params: Record<string, string>
  query: unknown
  readonly cookies: Readonly<Record<string, string>>
  body: unknown
  readonly set: ResponseControls
  readonly [CONTEXT_SET]: () => CtxSet | undefined
  readonly [CONTEXT_SEARCH]: string
  readonly signal: AbortSignal
  readonly budget: RequestBudget
  readonly env: unknown
  readonly clientIp: string | undefined
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly boundedBody: (maxBytes?: number) => Promise<Uint8Array>
  readonly boundedJson: <T = unknown>(maxBytes?: number) => Promise<T>
}

/** Broad shape so the implementation signature is compatible with both typed overloads. */
type ErasedHandler = (ctx: never) => MaybePromise<HandlerResult>

export type OnRequestResult = Response | Request | undefined
type RawOnRequest = (req: Request, platform?: Platform) => MaybePromise<OnRequestResult>
type RawOnResponse = (response: Response, req: Request) => MaybePromise<Response>
type RawOnResponseFinalized = (outcome: ResponseFinalization, req: Request) => MaybePromise<void>

/** A registered WebSocket route - just its handler; matching reuses {@link Router} under the GET verb. */
interface WsEntry {
  readonly handler: WebSocketHandler
}

/** Structural view of the Bun `Server` the `fetch` 2nd arg exposes (`upgrade` + the socket peer). */
interface BunUpgradeServer {
  upgrade(request: Request, options?: { data?: BunWsData }): boolean
  requestIP(request: Request): { readonly address: string } | null
}

/** The socket peer Bun observed, as a `Platform` for the request lifecycle (`undefined` if unknown).
 * Typed structurally on `requestIP` alone so any Bun `Server` (WS or not) satisfies it. */
function bunPeerPlatform(
  server: { requestIP(request: Request): { readonly address: string } | null },
  req: Request,
): Platform {
  // Bun's requestIP() is surprisingly expensive (~20 us on the SSR benchmark machine). Keep the
  // documented raw-peer c.clientIp behavior, but resolve it lazily: most routes never read c.clientIp,
  // and paying for the socket lookup on every request erased Bun's native HTTP advantage. A getter also
  // preserves middleware that inspects the platform argument directly and trust-mode routes, which
  // resolve the value in deriveClientIp before the handler runs.
  let resolved = false
  let address: string | undefined
  return {
    get clientIp(): string | undefined {
      if (!resolved) {
        resolved = true
        address = server.requestIP(req)?.address
      }
      return address
    },
  }
}

type BunNativeHandler = (request: Request) => MaybePromise<Response>
type BunNativeMethodTable = Partial<Record<Method, BunNativeHandler>>
type BunNativeRoutes = Record<string, BunNativeMethodTable>
type BunRequestWithParams = Request & { readonly params?: Record<string, string> }

const WS_PASS: WebSocketUpgradeOutcome = { kind: "pass" }

/** `app.ws()` (and everything downstream of it) needs the runtime `@nifrajs/core/ws` registers. */
function requireWsRuntime(runtime: WsRuntime | undefined): WsRuntime {
  if (runtime === undefined) {
    throw new FrameworkError(
      "WS_RUNTIME_MISSING",
      "app.ws() needs the WebSocket runtime, which ships as an opt-in plugin so no-WebSocket apps stay lean. Add `.use(websocket())` from `@nifrajs/core/ws` before declaring WS routes.",
    )
  }
  return runtime
}

function requireSseRuntime(runtime: SseRuntime | undefined): SseRuntime {
  if (runtime === undefined) {
    throw new FrameworkError(
      "SSE_RUNTIME_MISSING",
      "app.sse() needs the streaming runtime, which ships as a subpath so non-SSE apps stay lean. Add `.use(streaming())` (from `@nifrajs/core/sse`) at your server setup.",
    )
  }
  return runtime
}

function requireMcpRuntime(runtime: McpRuntime | undefined): McpRuntime {
  if (runtime === undefined) {
    throw new FrameworkError(
      "MCP_RUNTIME_MISSING",
      "MCP declarations ship as an opt-in runtime so ordinary HTTP apps stay lean. Add `.use(mcp())` (from `@nifrajs/core/mcp`) at your server setup.",
    )
  }
  return runtime
}

/** The handler's permitted return type. When the route declares a `response` schema, the return is
 * constrained to the contract's type (or a raw `Response`) - so the implementation can't drift from the
 * declared contract. Without a `response` schema it's unconstrained (`HandlerResult`), exactly as before. */
type ResponseOf<S extends RouteSchema> = S extends { response: infer R extends StandardSchemaV1 }
  ? InferOutput<R> | Response
  : HandlerResult

/**
 * Public handler shape: context typed from the path, the (optional) schema, and
 * any accumulated middleware context `Ctx` (from `derive`/`decorate`).
 */
export type Handler<
  Path extends string,
  S extends RouteSchema = RouteSchema,
  Ctx = EmptyContext,
> = (ctx: Context<Path, S> & Ctx) => MaybePromise<ResponseOf<S>>

// Route/option/descriptor + middleware-bundle types now live in `./server-types.ts`; re-exported so
// existing importers keep resolving them from the server module.
export type {
  AdmissionController,
  AdmissionDecision,
  McpPromptDescriptor,
  McpResourceDescriptor,
  Middleware,
  PromptArgument,
  PromptMessage,
  ResponseFinalization,
  RouteDescriptor,
  RunningServer,
  ServerOptions,
  ToolAnnotations,
}

// A plugin operates over arbitrary Server shapes; `any` here is the standard framework escape hatch
// (the precise threading happens at the `use` call site, which is generic over the *concrete* `this`).
// biome-ignore lint/suspicious/noExplicitAny: plugins are generic over any Server's Registry/Context
export type AnyServer = Server<any, any>

// Plugin definers + their types now live in `./plugin.ts`; re-exported here so `.use()` callers and
// existing importers keep resolving them from the server module.
export {
  defineIdentityPlugin,
  definePlugin,
  defineRouterPlugin,
  type NifraPlugin,
} from "./plugin.ts"
export type { IdentityPlugin }

const DEFAULT_MAX_BODY_BYTES = 1_000_000
const DEFAULT_DRAIN_MS = 10_000
const DRAIN_POLL_MS = 10

/** Same-origin check for a WebSocket handshake (CSWSH default). {@link isSameOriginRequest} is the one
 * owner, shared with the server-function mount in `@nifrajs/web` - the two used to answer differently
 * for the same request, so a browser that could open a socket was told its POST was cross-origin. */
const wsSameOrigin = isSameOriginRequest

function validationError(issues: ReadonlyArray<StandardIssue>): Response {
  const serialized = issues.map((issue) => {
    const path = issue.path?.map((seg) => String(typeof seg === "object" ? seg.key : seg))
    return path !== undefined ? { message: issue.message, path } : { message: issue.message }
  })
  return Response.json({ ok: false, error: "validation", issues: serialized }, { status: 422 })
}

// `jsonError`, `urlPartsOf`, `pathnameOf` moved to `./http.ts` (a dependency-free leaf shared with the
// opt-in request lanes); re-exported so existing importers keep resolving from here.
export { pathnameOf, urlPartsOf } from "./http.ts"
// Query-string + urlencoded-form parsing now lives in `./query.ts`; re-exported so existing
// importers keep resolving `searchOf`/`queryObjectOf`/`QueryValue` from here.
export { type QueryValue, queryObjectOf, searchOf }

function hasReplacementParam(params: Record<string, string>): boolean {
  for (const key in params) {
    if (params[key]!.includes("\uFFFD")) return true
  }
  return false
}

/** `ctx.set` carrying the lazy backings (`_headers`, `_cookies`) so `toResponse` can skip allocating
 * anything when no handler touched `c.set.*`. Server-internal. */
export type CtxSet = ResponseControls & {
  _headers?: Record<string, string>
  /** Accumulated `Set-Cookie` values - a list, since a `Record` would collapse multiple cookies. */
  _cookies?: string[]
}

function responseSet(ctx: RawContext): CtxSet {
  return ctx[CONTEXT_SET]() ?? EMPTY_RESPONSE_CONTROLS
}

function isContextlessNoArgArrow(handler: (context: never) => unknown): boolean {
  if (handler.length !== 0) return false
  try {
    return CONTEXTLESS_ARROW.test(functionToString.call(handler))
  } catch {
    return false
  }
}

// Stable module-level finalizers so `fetch`/`resolveNode` allocate no per-request closures.
const IDENTITY_RESPONSE = (response: Response): Response => response
const RESPONSE_TIMEOUT = (): Response => jsonError(503, "request_timeout")

/**
 * The inline server. Routes are chainable and fully type-inferred. `derive`/
 * `decorate` extend the handler context (`Ctx`) for routes defined *after* them,
 * with full types; `Ctx` is server-only and never touches the client registry.
 *
 *   app.decorate("db", db).derive((c) => ({ user: auth(c) }))
 *      .get("/me", (c) => c.user)            // c.user + c.db are typed
 */
export class Server<R extends Registry = EmptyRegistry, Ctx = EmptyContext> {
  private readonly catalog: RouteCatalog
  /** WebSocket routes, matched separately at upgrade time (a GET + `Upgrade: websocket`). */
  private readonly wsRouter: Router<WsEntry>
  private wsRouteCount: number
  /** In-process pub/sub backing `ws.subscribe(topic)` + `app.publish(topic, data)` (single-instance).
   * Created by the first `app.ws()` via the `@nifrajs/core/ws` runtime - `undefined` until then, so a
   * no-WebSocket app never constructs (or bundles) it. */
  private topics: TopicRegistry | undefined
  private readonly maxBodyBytes: number
  private readonly wsMaxPayloadBytes: number
  private readonly requestTimeoutMs: number
  /** Installed by the `responseContract()` plugin; `undefined` = not installed, which is the default
   * and the state in which a declared `response` schema stays a compile-time contract only. */
  private responseContractRuntime: ResponseContractRuntime | undefined
  /** Opt-in caller-IP trust declaration; `undefined` = socket peer only, no forwarded header believed. */
  private readonly clientIpTrust: ClientIpTrust | undefined
  private readonly acceptInboundDeadlines: boolean
  private readonly maxInboundDeadlineMs: number
  private readonly deadlineAdmissionOptions: DeadlineAdmissionOptions
  private readonly gracefulSignals: boolean
  /** Capacity-admission gate; `undefined` = off (the request path pays nothing). */
  private readonly capacityGate: AdmissionController | undefined
  private readonly onCapabilityUse: ((event: CapabilityUseEvent) => void) | undefined
  private readonly capabilityInterceptors: RegisteredCapabilityInterceptor[]
  private readonly capabilityObservers: EffectLifecycleObserver[]
  /** The installed effect-ledger runtime (owns the sink + per-route resolution + settle), or
   * `undefined` when the effect-ledger plugin is not installed. */
  private effectLedgerRuntime: EffectLedgerRuntime | undefined
  /** The installed idempotency runtime (owns the app-wide default store + the dedupe lane), or
   * `undefined` when the idempotency plugin is not installed. */
  private idempotencyRuntime: IdempotencyRuntime | undefined
  /** Installed opt-in runtime for `.tool()`/`.resource()`/`.prompt()`; `undefined` until `.use(mcp())`. */
  private mcpRuntime: McpRuntime | undefined
  /** Installed Node-direct renderer for direct `resolveNode()` callers; `undefined` until `.use(nodeDirect())`. */
  private nodeOutcomeRuntime: NodeOutcomeRuntime | undefined
  /** Installed streaming runtime for `.sse()` routes; `undefined` until `.use(streaming())`. */
  private sseRuntime: SseRuntime | undefined
  /** Installed WebSocket runtime for `.ws()` routes; `undefined` until `.use(websocket())`. */
  private wsRuntime: WsRuntime | undefined
  private readonly logger: Logger
  /** App-wide validation-error fallback; a route's own `schema.onValidationError` takes precedence. */
  private readonly defaultOnValidationError?: RouteSchema["onValidationError"]
  private bunServer: RunningServer | undefined
  private sealed: boolean
  private readonly derives: RawDerive[]
  private readonly decorations: Record<string, unknown>
  private readonly beforeHandleHooks: RawBeforeHandle[]
  private readonly afterHandleHooks: RawAfterHandle[]
  private readonly onErrorHooks: RawErrorHandler[]
  private readonly aroundHooks: RawAround[]
  private readonly onRequestHooks: RawOnRequest[]
  private readonly onNodeRequestHooks: Array<NodeRequestHook | undefined>
  /** Registration-time eligibility for the Node request twin lane. */
  private nodeRequestHooksComplete: boolean
  private readonly onResponseHooks: RawOnResponse[]
  private readonly onNodeResponseHooks: Array<NodeResponseHook | undefined>
  /** Registration-time eligibility for the Node response twin lane. */
  private nodeResponseHooksComplete: boolean
  private readonly onResponseFinalizedHooks: RawOnResponseFinalized[]
  /**
   * Statically declared response headers, merged and prebuilt at registration; `undefined` (the
   * default) leaves every render path in its original shape. These are NOT response hooks - they are
   * folded into response construction - so declaring them keeps the fused native lanes an
   * `onResponse` hook would have disabled.
   */
  private staticResponseHeaders: StaticResponseHeaders | undefined
  /** `wrapResponse` for the Web lanes: identity until static headers exist to fold into the
   * framework's own error/404/timeout renders, which are built outside the header init. */
  private wrapWebResponse: (response: Response) => Response
  private webResponseTimeout: () => Response
  /** Body/raw response hooks need a framework-payload marker; keep that decision per app. */
  private responseBodyTag: object | undefined
  private readonly responseBodyOwners: Set<object>
  private readonly finalizeResponse = (result: unknown, set: CtxSet): Response =>
    toResponse(result as HandlerResult, set, this.responseBodyTag, this.staticResponseHeaders)
  private readonly responseRequests: WeakMap<Request, Request>
  /** Original source → request observed by generic request hooks, including in-place mutations. */
  private readonly responseSources: WeakMap<object, Request>
  /** Memoized NodeRequestContext per plain-`Request` source - see {@link nodeRequestContextOf}. */
  private readonly nodeContexts: WeakMap<object, NodeRequestContext>
  /** Names of plugins/middleware already applied via `use` - for idempotent dedupe. */
  private readonly appliedPlugins: Set<string>
  /** Order-scoped evidence captured by routes registered after an assured plugin. */
  private readonly activeAssurance: AssuranceDeclaration[]
  /** App-wide evidence from global hooks; applies retroactively to every route. */
  private readonly globalAssurance: AssuranceDeclaration[]
  /** App-declared MCP resources / prompts (via {@link resource} / {@link prompt}), read by `nifra mcp`. */
  private readonly mcpResourceList: McpResourceDescriptor[]
  private readonly mcpPromptList: McpPromptDescriptor[]
  constructor(options: ServerOptions = {}) {
    this.catalog = new RouteCatalog()
    this.wsRouter = new Router<WsEntry>()
    this.wsRouteCount = 0
    this.topics = undefined
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    assertByteLimit(maxBodyBytes, "maxBodyBytes")
    const wsMaxPayloadBytes = options.wsMaxPayloadBytes ?? maxBodyBytes
    assertByteLimit(wsMaxPayloadBytes, "wsMaxPayloadBytes")
    this.maxBodyBytes = maxBodyBytes
    this.wsMaxPayloadBytes = wsMaxPayloadBytes
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0
    this.clientIpTrust = options.clientIp
    this.acceptInboundDeadlines = options.acceptInboundDeadlines ?? false
    this.maxInboundDeadlineMs = options.maxInboundDeadlineMs ?? 30_000
    this.deadlineAdmissionOptions = Object.freeze({
      localTimeoutMs: this.requestTimeoutMs,
      maxInboundDeadlineMs: this.maxInboundDeadlineMs,
    })
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs < 0) {
      throw new RangeError("requestTimeoutMs must be a finite non-negative number")
    }
    if (!Number.isFinite(this.maxInboundDeadlineMs) || this.maxInboundDeadlineMs <= 0) {
      throw new RangeError("maxInboundDeadlineMs must be a finite positive number")
    }
    this.gracefulSignals = options.gracefulSignals ?? false
    this.capacityGate = options.admission
    this.onCapabilityUse = options.onCapabilityUse
    this.capabilityInterceptors = []
    this.capabilityObservers = []
    // The effect-ledger runtime is installed by `.use(effectLedger())`; a bare app never imports it, so
    // the ledger machinery tree-shakes out. Capability-declaring routes simply carry no ledger without it.
    this.effectLedgerRuntime = undefined
    // The idempotency runtime is installed by `.use(idempotency())`; a bare app never imports it, so the
    // dedupe machinery tree-shakes out. A route that declares idempotency without it is a build error.
    this.responseContractRuntime = undefined
    this.idempotencyRuntime = undefined
    this.logger = options.logger ?? jsonLogger()
    this.defaultOnValidationError = options.onValidationError
    this.bunServer = undefined
    this.sealed = false
    this.derives = []
    this.decorations = {}
    this.beforeHandleHooks = []
    this.afterHandleHooks = []
    this.onErrorHooks = []
    this.aroundHooks = []
    this.onRequestHooks = []
    this.onNodeRequestHooks = []
    this.nodeRequestHooksComplete = true
    this.onResponseHooks = []
    this.onNodeResponseHooks = []
    this.nodeResponseHooksComplete = true
    this.onResponseFinalizedHooks = []
    this.staticResponseHeaders = undefined
    this.wrapWebResponse = IDENTITY_RESPONSE
    this.webResponseTimeout = RESPONSE_TIMEOUT
    this.responseBodyTag = undefined
    this.responseBodyOwners = new Set()
    this.responseRequests = new WeakMap()
    this.responseSources = new WeakMap()
    this.nodeContexts = new WeakMap()
    this.appliedPlugins = new Set()
    this.activeAssurance = []
    this.globalAssurance = []
    this.mcpResourceList = []
    this.mcpPromptList = []
  }

  private assertConfigurable(operation: string): void {
    if (this.sealed) {
      throw new FrameworkError(
        "SERVER_SEALED",
        `server configuration is sealed after listen(); call ${operation} before listen()`,
      )
    }
  }

  /** Add a per-request, computed context extension for subsequent routes. */
  derive<D extends object>(fn: (context: Context & Ctx) => MaybePromise<D>): Server<R, Ctx & D> {
    this.assertConfigurable("derive()")
    this.derives.push(fn as unknown as RawDerive)
    return this as unknown as Server<R, Ctx & D>
  }

  /** Add a static context value for subsequent routes. */
  decorate<const K extends string, V>(key: K, value: V): Server<R, Ctx & Record<K, V>> {
    this.assertConfigurable("decorate()")
    this.decorations[key] = value
    return this as unknown as Server<R, Ctx & Record<K, V>>
  }

  /**
   * Run before routing on the raw request. Return a `Response` to short-circuit, or a replacement
   * `Request` to continue routing with a rewritten method/URL/headers. Global.
   */
  onRequest(
    fn: (req: Request, platform?: Platform<EnvOf<Ctx>>) => MaybePromise<OnRequestResult>,
  ): this {
    this.assertConfigurable("onRequest()")
    this.onRequestHooks.push(fn as RawOnRequest)
    this.onNodeRequestHooks.push(undefined)
    this.nodeRequestHooksComplete = false
    return this
  }

  /** Run after validation, before the handler; a non-`undefined` return short-circuits. Order-scoped. */
  beforeHandle(fn: (context: Context & Ctx) => MaybePromise<unknown>): this {
    this.assertConfigurable("beforeHandle()")
    this.beforeHandleHooks.push(fn as unknown as RawBeforeHandle)
    return this
  }

  /**
   * Wrap the matched route lifecycle for subsequent routes. This is intentionally generic over the
   * route output, so wrappers like async context storage do not force Node's direct JSON path through
   * a Web `Response`. The first registered wrapper is outermost.
   */
  around(fn: <T>(context: Context & Ctx, next: () => MaybePromise<T>) => MaybePromise<T>): this {
    this.assertConfigurable("around()")
    this.aroundHooks.push(fn as unknown as RawAround)
    return this
  }

  /**
   * Asynchronously admit each subsequent `executeCapability()` call before its owned effect runs.
   * Interceptors receive token-only metadata plus an abort signal and must call `next()` exactly once
   * to admit. Returning without `next()`, timing out, aborting, or throwing fails the effect closed.
   */
  aroundCapability(
    interceptor: CapabilityInterceptor,
    options: AroundCapabilityOptions = {},
  ): this {
    this.assertConfigurable("aroundCapability()")
    if (typeof interceptor !== "function") {
      throw new TypeError("aroundCapability interceptor must be a function")
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_CAPABILITY_INTERCEPTOR_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("aroundCapability timeoutMs must be a positive safe integer")
    }
    // JS timers wrap larger delays to ~1ms, which would unexpectedly deny every effect.
    this.capabilityInterceptors.push(
      Object.freeze({ interceptor, timeoutMs: Math.min(timeoutMs, 2_147_483_647) }),
    )
    return this
  }

  /** Observe token-only admission/execution lifecycle events for subsequent capability routes. */
  observeCapability(observer: EffectLifecycleObserver): this {
    this.assertConfigurable("observeCapability()")
    if (typeof observer !== "function") {
      throw new TypeError("observeCapability observer must be a function")
    }
    this.capabilityObservers.push(observer)
    return this
  }

  /** Transform the handler's result before it is serialized. Order-scoped. */
  afterHandle(fn: (result: unknown, context: Context & Ctx) => MaybePromise<unknown>): this {
    this.assertConfigurable("afterHandle()")
    this.afterHandleHooks.push(fn as unknown as RawAfterHandle)
    return this
  }

  /** Handle a thrown error; a non-`undefined` return becomes the response (else the default 500). Order-scoped. */
  onError(fn: (error: unknown, context: Context & Ctx) => MaybePromise<unknown>): this {
    this.assertConfigurable("onError()")
    this.onErrorHooks.push(fn as unknown as RawErrorHandler)
    return this
  }

  /** Transform every outgoing response - success, error, 404, 405, short-circuit. Global. */
  onResponse(fn: (response: Response, req: Request) => MaybePromise<Response>): this {
    this.assertConfigurable("onResponse()")
    this.onResponseHooks.push(fn)
    this.onNodeResponseHooks.push(undefined)
    this.nodeResponseHooksComplete = false
    return this
  }

  /**
   * Declare response headers with NO per-request decision behind them - and pay nothing for them on
   * the request path.
   *
   * These are not a hook. Because the values are known at wire-up, they are folded into response
   * construction (one prebuilt init for JSON renders, one record merge where the request set its own
   * headers), so an app whose only response middleware is static keeps every fused and native lane -
   * `onResponse`/`onResponseHeaders` disable Bun's fused native routes and, for a full `onResponse`,
   * the Node direct writer. They apply to EVERY response, exactly as a response hook would: success,
   * error, 404/405, timeout, and short-circuit alike.
   *
   *   app.responseHeaders({ "x-frame-options": "DENY", "referrer-policy": "no-referrer" })
   *
   * They are DEFAULTS: a value the request itself produced (`c.set.headers`, or a response hook)
   * wins, whatever casing it used. Names are lowercased once here; a non-string value, an invalid
   * name, `__proto__`, or a name the render owns (`content-type`, `content-length`,
   * `transfer-encoding`, `set-cookie`) throws a `TypeError` at wire-up.
   *
   * ORDERING: declarations made before any response hook fold into one static record. One made AFTER
   * a response hook cannot - the hook may already have written that name and must keep winning - so
   * it registers as an ordinary `onResponseHeaders` hook instead, preserving registration order at
   * the cost of the static tier's speed. Declare static headers first.
   */
  responseHeaders(record: Readonly<Record<string, string>>): this {
    this.assertConfigurable("responseHeaders()")
    return this.addStaticResponseHeaders(normalizeStaticResponseHeaders(record))
  }

  /** Wire an already-validated lowercase record into the static tier, or - once a dynamic response
   * hook owns part of the header state - into a hook that runs in the right order. */
  private addStaticResponseHeaders(record: Record<string, string>): this {
    if (this.onResponseHooks.length > 0) {
      return this.onResponseHeaders((headers) => {
        for (const name of Object.keys(record)) {
          if (!headers.has(name)) headers.set(name, record[name] as string)
        }
      })
    }
    const merged =
      this.staticResponseHeaders === undefined
        ? record
        : { ...this.staticResponseHeaders.record, ...record }
    this.staticResponseHeaders = buildStaticResponseHeaders(merged)
    const statics = this.staticResponseHeaders
    this.wrapWebResponse = (response) => applyStaticResponseHeaders(response, statics)
    this.webResponseTimeout = () => applyStaticResponseHeaders(RESPONSE_TIMEOUT(), statics)
    return this
  }

  private enableResponseBodyTagging(): object {
    if (this.responseBodyTag === undefined) {
      this.responseBodyTag = Object.freeze({})
      this.responseBodyOwners.add(this.responseBodyTag)
    }
    return this.responseBodyTag
  }

  /**
   * Register a response transform for raw/streamed Responses. Framework-serialized payloads stay on
   * the body tier; this hook is only entered for untagged Responses (streams, proxied fetches, and
   * framework-generated error responses). A no-op native twin keeps buffered JSON on the direct lane.
   */
  onResponseRaw(fn: (response: Response, req: Request) => MaybePromise<Response>): this {
    this.assertConfigurable("onResponseRaw()")
    this.enableResponseBodyTagging()
    this.onResponseHooks.push(webResponseRawHook(fn, this.responseBodyOwners))
    this.onNodeResponseHooks.push(() => undefined)
    return this
  }

  /**
   * Register a PORTABLE header-only response hook - one implementation, fast on every runtime.
   *
   * The hook receives a mutable case-insensitive header view, a minimal request view, and the
   * status. On the Web serving paths it runs inside the normal `onResponse` walk against the
   * response's own `Headers` (mutating in place - no clone). On Node it self-pairs as a native
   * response hook against the outcome's plain header record, so registering one NEVER forces the
   * Node adapter off its direct socket writer the way a full `onResponse(res: Response)` hook does.
   * Prefer this over `onResponse` whenever the middleware only reads/writes headers.
   */
  onResponseHeaders(fn: ResponseHeadersHook): this {
    this.assertConfigurable("onResponseHeaders()")
    this.onResponseHooks.push(webResponseHeadersHook(fn))
    this.onNodeResponseHooks.push((response, req) =>
      fn(recordHeadersView(response), req, response.status),
    )
    return this
  }

  /**
   * Register a PORTABLE post-serialization body hook - the payload tier. The hook receives the
   * FINAL framework-serialized bytes (plus the mutable header view and status) and may return
   * replacement bytes; `undefined` keeps the body. On the Node direct writer the bytes come
   * straight off the outcome record; on the Web serving paths they ride the framework-built
   * Response as a tag, so no body stream is ever drained on any runtime. A handler-returned raw
   * `Response` (proxied fetch, SSE, streamed SSR) is skipped by contract - transforming those is
   * what the full `onResponse` hook is for.
   */
  onResponseBody(fn: ResponseBodyHook): this {
    this.assertConfigurable("onResponseBody()")
    this.enableResponseBodyTagging()
    this.onResponseHooks.push(webResponseBodyHook(fn, this.responseBodyOwners))
    this.onNodeResponseHooks.push((response, req) => {
      const body = response.body
      if (body === null) return undefined
      const out = fn(body, recordHeadersView(response), req, response.status)
      if (out instanceof Promise)
        return out.then((replaced) => applyBodyReplacement(response, replaced))
      applyBodyReplacement(response, out)
      return undefined
    })
    return this
  }

  /** Observe the terminal response after all transformations. Observers are ordered and fail-open. */
  onResponseFinalized(
    fn: (outcome: ResponseFinalization, req: Request) => MaybePromise<void>,
  ): this {
    this.assertConfigurable("onResponseFinalized()")
    this.onResponseFinalizedHooks.push(fn)
    return this
  }

  /**
   * Apply a type-**identity** plugin ({@link IdentityPlugin}, from {@link defineIdentityPlugin}) - it
   * registers routes/hooks but doesn't change the types, so this returns `this` with the route registry
   * and context fully intact. This overload exists specifically so a *named* identity plugin (e.g.
   * `@nifrajs/better-auth`) threads the registry: its `& { pluginName }` intersection would otherwise
   * defeat the generic inference of the transforming overload below and collapse the result to `any`.
   */
  use(plugin: IdentityPlugin): this
  /**
   * Apply a **plugin function** - `(app) => app`, typically built with {@link definePlugin}. It's
   * called with `this` and its result is returned, so an inline plugin's `derive`/`decorate` thread
   * the added context to handlers defined after `use` (the overload is generic over the concrete
   * `this`). A named plugin already applied is skipped (idempotent dedupe).
   */
  use<Out extends AnyServer>(plugin: (app: this) => Out): Out
  /**
   * Apply a {@link Middleware} bundle - wire each hook it provides to its lifecycle point. Returns
   * `this` (no context-type merging); call it before the routes its `beforeHandle`/`afterHandle`
   * should cover (those are order-scoped; `onRequest`/`onResponse` are global). A named bundle already
   * applied is skipped (idempotent).
   */
  use(mw: Middleware): this
  use(arg: Middleware | ((app: this) => AnyServer)): AnyServer {
    this.assertConfigurable("use()")
    if (typeof arg === "function") {
      const name = (arg as { pluginName?: string }).pluginName
      if (name !== undefined) {
        if (this.appliedPlugins.has(name)) return this // idempotent: already applied
        this.appliedPlugins.add(name)
      }
      const evidence = assuranceDeclarationsOf(arg)
      const pluginOnly = evidence.filter((item) => item.scope === "plugin")
      this.globalAssurance.push(...evidence.filter((item) => item.scope === "global"))
      this.activeAssurance.push(...evidence.filter((item) => item.scope === "subsequent"))
      this.activeAssurance.push(...pluginOnly)
      try {
        return arg(this)
      } finally {
        // Remove only this plugin's temporary evidence. Nested assured plugins may deliberately leave
        // subsequent evidence active, so truncating the whole array would lose real ordering semantics.
        for (const item of pluginOnly) {
          const index = this.activeAssurance.indexOf(item)
          if (index !== -1) this.activeAssurance.splice(index, 1)
        }
      }
    }
    if (arg.name !== undefined) {
      if (this.appliedPlugins.has(arg.name)) return this
      this.appliedPlugins.add(arg.name)
    }
    const evidence = assuranceDeclarationsOf(arg)
    if (evidence.some((item) => item.scope === "plugin")) {
      throw new Error('route assurance: scope "plugin" may only annotate a plugin function')
    }
    this.globalAssurance.push(...evidence.filter((item) => item.scope === "global"))
    this.activeAssurance.push(...evidence.filter((item) => item.scope === "subsequent"))
    if (arg.onRequest !== undefined) {
      this.assertConfigurable("onRequest()")
      this.onRequestHooks.push(arg.onRequest as RawOnRequest)
      this.onNodeRequestHooks.push(arg.onNodeRequest)
      if (arg.onNodeRequest === undefined) this.nodeRequestHooksComplete = false
    } else if (arg.onNodeRequest !== undefined) {
      throw new TypeError("onNodeRequest() requires a paired onRequest() hook")
    }
    if (arg.around !== undefined) this.around(arg.around)
    if (arg.beforeHandle !== undefined) this.beforeHandle(arg.beforeHandle)
    if (arg.afterHandle !== undefined) this.afterHandle(arg.afterHandle)
    if (arg.onResponse !== undefined) {
      this.assertConfigurable("onResponse()")
      this.onResponseHooks.push(arg.onResponse)
      this.onNodeResponseHooks.push(arg.onNodeResponse)
      if (arg.onNodeResponse === undefined) this.nodeResponseHooksComplete = false
    } else if (arg.onNodeResponse !== undefined) {
      throw new TypeError("onNodeResponse() requires a paired onResponse() hook")
    }
    // Before the bundle's own hooks: a bundle declaring both means its static values are the
    // defaults its hook may then override, which is the order a single bundle reads in.
    if (arg.responseHeaders !== undefined) this.responseHeaders(arg.responseHeaders)
    if (arg.onResponseHeaders !== undefined) this.onResponseHeaders(arg.onResponseHeaders)
    if (arg.onResponseBody !== undefined) this.onResponseBody(arg.onResponseBody)
    if (arg.onResponseRaw !== undefined) this.onResponseRaw(arg.onResponseRaw)
    if (arg.onResponseFinalized !== undefined) this.onResponseFinalized(arg.onResponseFinalized)
    if (arg.onError !== undefined) this.onError(arg.onError)
    return this
  }

  get<Path extends string, S extends RouteSchema, H extends Handler<Path, S, Ctx>>(
    path: Path,
    schema: S,
    handler: H,
  ): Server<AddRoute<R, "GET", Path, RouteInfoFor<Path, S, OutputOf<H>>>, Ctx>
  get<Path extends string, H extends Handler<Path, RouteSchema, Ctx>>(
    path: Path,
    handler: H,
  ): Server<AddRoute<R, "GET", Path, RouteInfoFor<Path, Record<never, never>, OutputOf<H>>>, Ctx>
  get(
    path: string,
    schemaOrHandler: RouteSchema | ErasedHandler,
    handler?: ErasedHandler,
  ): Server<Registry, Ctx> {
    return this.route("GET", path, schemaOrHandler, handler)
  }

  /**
   * Register a **typed SSE route** - a GET endpoint streaming `text/event-stream` whose event
   * payloads are contracted by `schema.sse`. The handler receives the validated context plus a
   * {@link TypedSSEStream}: `stream.send(event)` is compile-time-checked against the schema and
   * JSON-serialized into the SSE `data:` field. The typed client sees the marker and grows a
   * `.subscribe(onEvent)` for the route with the same payload type - end-to-end typed streaming.
   *
   *   import { streaming } from "@nifrajs/core/sse"   // .use(streaming()) enables .sse()
   *   const app = server().use(streaming()).sse("/feed", { sse: t.object({ id: t.integer(), title: t.string() }) },
   *     async (c, stream) => {
   *       stream.send({ id: 1, title: "hello" })          // typed
   *       await waitForDisconnect(stream.signal)
   *     },
   *     { keepAlive: 15_000 })
   *
   *   // client: const off = api.feed.subscribe((post) => console.log(post.title))
   *
   * `init` passes through to the underlying {@link sse} helper (`keepAlive`, extra headers). The
   * connection closes when the handler resolves, `stream.close()` runs, or the client disconnects
   * (`stream.signal`). Query/body schemas validate exactly as on any other route.
   */
  sse<Path extends string, S extends RouteSchema & { sse: StandardSchemaV1 }>(
    path: Path,
    schema: S,
    run: (
      context: Context<Path, S> & Ctx,
      stream: TypedSSEStream<InferOutput<S["sse"]>>,
    ) => void | Promise<void>,
    init?: SSEInit,
  ): Server<AddRoute<R, "GET", Path, RouteInfoFor<Path, S, Response>>, Ctx> {
    const handler = (context: Context<Path, S> & Ctx): Response =>
      requireSseRuntime(this.sseRuntime).response(context, (stream) => run(context, stream), init)
    return this.route("GET", path, schema, handler as unknown as ErasedHandler) as Server<
      AddRoute<R, "GET", Path, RouteInfoFor<Path, S, Response>>,
      Ctx
    >
  }

  post<Path extends string, S extends RouteSchema, H extends Handler<Path, S, Ctx>>(
    path: Path,
    schema: S,
    handler: H,
  ): Server<AddRoute<R, "POST", Path, RouteInfoFor<Path, S, OutputOf<H>>>, Ctx>
  post<Path extends string, H extends Handler<Path, RouteSchema, Ctx>>(
    path: Path,
    handler: H,
  ): Server<AddRoute<R, "POST", Path, RouteInfoFor<Path, Record<never, never>, OutputOf<H>>>, Ctx>
  post(
    path: string,
    schemaOrHandler: RouteSchema | ErasedHandler,
    handler?: ErasedHandler,
  ): Server<Registry, Ctx> {
    return this.route("POST", path, schemaOrHandler, handler)
  }

  put<Path extends string, S extends RouteSchema, H extends Handler<Path, S, Ctx>>(
    path: Path,
    schema: S,
    handler: H,
  ): Server<AddRoute<R, "PUT", Path, RouteInfoFor<Path, S, OutputOf<H>>>, Ctx>
  put<Path extends string, H extends Handler<Path, RouteSchema, Ctx>>(
    path: Path,
    handler: H,
  ): Server<AddRoute<R, "PUT", Path, RouteInfoFor<Path, Record<never, never>, OutputOf<H>>>, Ctx>
  put(
    path: string,
    schemaOrHandler: RouteSchema | ErasedHandler,
    handler?: ErasedHandler,
  ): Server<Registry, Ctx> {
    return this.route("PUT", path, schemaOrHandler, handler)
  }

  patch<Path extends string, S extends RouteSchema, H extends Handler<Path, S, Ctx>>(
    path: Path,
    schema: S,
    handler: H,
  ): Server<AddRoute<R, "PATCH", Path, RouteInfoFor<Path, S, OutputOf<H>>>, Ctx>
  patch<Path extends string, H extends Handler<Path, RouteSchema, Ctx>>(
    path: Path,
    handler: H,
  ): Server<AddRoute<R, "PATCH", Path, RouteInfoFor<Path, Record<never, never>, OutputOf<H>>>, Ctx>
  patch(
    path: string,
    schemaOrHandler: RouteSchema | ErasedHandler,
    handler?: ErasedHandler,
  ): Server<Registry, Ctx> {
    return this.route("PATCH", path, schemaOrHandler, handler)
  }

  delete<Path extends string, S extends RouteSchema, H extends Handler<Path, S, Ctx>>(
    path: Path,
    schema: S,
    handler: H,
  ): Server<AddRoute<R, "DELETE", Path, RouteInfoFor<Path, S, OutputOf<H>>>, Ctx>
  delete<Path extends string, H extends Handler<Path, RouteSchema, Ctx>>(
    path: Path,
    handler: H,
  ): Server<AddRoute<R, "DELETE", Path, RouteInfoFor<Path, Record<never, never>, OutputOf<H>>>, Ctx>
  delete(
    path: string,
    schemaOrHandler: RouteSchema | ErasedHandler,
    handler?: ErasedHandler,
  ): Server<Registry, Ctx> {
    return this.route("DELETE", path, schemaOrHandler, handler)
  }

  /**
   * Declare an **MCP tool** an agent can call (via `nifra mcp`, or a mounted MCP endpoint): a typed
   * `POST /_nifra/tool/<name>` route whose `input`/`output` schemas contract the call and surface in
   * `tools/list`. Requires `.use(mcp())` - without it, `.tool()` is a registration error, so an
   * ordinary HTTP app never bundles the MCP wiring. Siblings: {@link resource}, {@link prompt}.
   *
   *   import { mcp } from "@nifrajs/core/mcp"
   *   const app = server().use(mcp()).tool(
   *     "search",
   *     { description: "Search posts", input: t.object({ q: t.string() }) },
   *     ({ q }) => findPosts(q),
   *   )
   */
  tool<
    Name extends string,
    S extends {
      description: string
      input: StandardSchemaV1
      output?: StandardSchemaV1
      annotations?: ToolAnnotations
    },
    H extends (
      input: InferOutput<S["input"]>,
      ctx: Context & Ctx,
    ) => MaybePromise<S["output"] extends StandardSchemaV1 ? InferOutput<S["output"]> : unknown>,
  >(
    name: Name,
    config: S,
    handler: H,
  ): Server<
    AddRoute<
      R,
      "POST",
      `/_nifra/tool/${Name}`,
      RouteInfoFor<
        `/_nifra/tool/${Name}`,
        S["output"] extends StandardSchemaV1
          ? { body: S["input"]; response: S["output"] }
          : { body: S["input"] },
        OutputOf<H>
      >
    >,
    Ctx
  >
  tool(
    name: string,
    config: {
      description: string
      input: StandardSchemaV1
      output?: StandardSchemaV1
      annotations?: ToolAnnotations
    },
    handler: (input: unknown, ctx: Context & Ctx) => unknown,
  ): Server<Registry, Ctx> {
    const plan = requireMcpRuntime(this.mcpRuntime).tool(
      name,
      config,
      handler as (input: unknown, context: Context) => unknown,
    )
    this.register("POST", plan.path, plan.schema, plan.run as (context: never) => unknown)
    // Tag the just-registered descriptor as an MCP tool. `tool` is readonly on RouteDescriptor (an
    // introspection field), so write it through a narrow mutable view - not `any`.
    const lastRoute = this.catalog.lastDescriptor()
    if (lastRoute) {
      ;(lastRoute as { tool?: RouteDescriptor["tool"] }).tool = plan.descriptor
    }
    return this as unknown as Server<Registry, Ctx>
  }

  /**
   * Declare an MCP **resource** - read-only data an agent can fetch through `nifra mcp` (app config, a
   * generated document, …). `read` runs in the app process, so capture whatever app state it needs in the
   * closure. `uri` is the MCP resource identifier (e.g. `"myapp://config"`). The sibling of {@link tool}
   * for the resource half of MCP.
   */
  resource(
    uri: string,
    config: { readonly name: string; readonly description?: string; readonly mimeType?: string },
    read: McpResourceDescriptor["read"],
  ): Server<R, Ctx> {
    this.assertConfigurable("resource()")
    this.mcpResourceList.push(requireMcpRuntime(this.mcpRuntime).resource(uri, config, read))
    return this
  }

  /**
   * Declare an MCP **prompt** - a reusable prompt template an agent can fetch through `nifra mcp`.
   * `handler` receives the caller's arguments and returns the rendered messages.
   */
  prompt(
    name: string,
    config: { readonly description: string; readonly arguments?: readonly PromptArgument[] },
    handler: McpPromptDescriptor["handler"],
  ): Server<R, Ctx> {
    this.assertConfigurable("prompt()")
    this.mcpPromptList.push(requireMcpRuntime(this.mcpRuntime).prompt(name, config, handler))
    return this
  }

  /** The MCP resources declared via {@link resource} - enumerated by `nifra mcp`. */
  mcpResources(): readonly McpResourceDescriptor[] {
    return this.mcpResourceList
  }

  /** The MCP prompts declared via {@link prompt} - enumerated by `nifra mcp`. */
  mcpPrompts(): readonly McpPromptDescriptor[] {
    return this.mcpPromptList
  }

  /**
   * Register a **WebSocket** route. The connection upgrades on a `GET` to `path` carrying
   * `Upgrade: websocket`; the optional `handler.upgrade(c)` runs in the request context first and may
   * reject (return a `Response`) or seed per-connection `ws.data`. WebSockets are served by the
   * adapter (`listen()`, `@nifrajs/node`, `@nifrajs/deno`, `toFetchHandler`) - not by bare `app.fetch`, which
   * has no socket (a WS path through `app.fetch` is a normal HTTP response).
   *
   * The route also enters the type-level registry (under the pseudo-method `"WS"`), so the typed
   * client grows a `.ws()` handle for it: `messageSchema` types what the client may `send`,
   * `sendSchema` types the frames it receives. Passing explicit type arguments (`ws<MyData>(…)`)
   * defeats path-literal inference and skips the registry entry - the route still serves, it is just
   * invisible to `client<App>`; prefer typing `data` via `upgrade()`'s return.
   *
   *   app.ws("/chat", { open: (ws) => ws.send("hi"), message: (ws, data) => ws.send(data) })
   */
  ws<
    Data = unknown,
    Schema extends StandardSchemaV1 | undefined = undefined,
    Send extends StandardSchemaV1 | undefined = undefined,
    Path extends string = string,
  >(
    path: Path,
    handler: WebSocketHandler<Data, EnvOf<Ctx>, Schema, Send>,
  ): string extends Path
    ? Server<R, Ctx>
    : Server<AddRoute<R, "WS", Path, WsRouteInfoFor<Path, Schema, Send>>, Ctx> {
    this.assertConfigurable("ws()")
    // Boot-time guard: the WS runtime is a subpath (`@nifrajs/core/ws`) so no-WebSocket apps don't
    // bundle it. Registration is the loud, early failure point - never the first connection.
    const runtime = requireWsRuntime(this.wsRuntime)
    this.topics ??= runtime.createTopics()
    // A `messageSchema` wraps `message` with validation once, here - every adapter then dispatches
    // already-validated, typed messages (Bun/Deno/Node/Workers) with no per-adapter code.
    this.wsRouter.add("GET", path, {
      handler: runtime.wrapHandler(handler as WebSocketHandler),
    })
    this.wsRouteCount += 1
    return this as never
  }

  /**
   * Broadcast `data` to every WebSocket connection subscribed to `topic` (via `ws.subscribe(topic)`).
   * In-process and **single-instance** (see {@link TopicRegistry}) - a multi-instance deploy must bridge
   * an external fan-out (Redis, a Durable Object) to this. A no-op when nobody is subscribed.
   */
  publish(topic: string, data: string | ArrayBufferView | ArrayBuffer): void {
    // No `app.ws()` yet ⇒ no registry and necessarily no subscribers - a publish is a no-op anyway.
    this.topics?.publish(topic, data)
  }

  private route(
    method: Method,
    path: string,
    schemaOrHandler: RouteSchema | ErasedHandler,
    handler?: ErasedHandler,
  ): Server<Registry, Ctx> {
    let rawHandler: ErasedHandler
    let schema: RouteSchema | undefined
    if (handler !== undefined) {
      schema = schemaOrHandler as RouteSchema
      rawHandler = handler
    } else {
      schema = undefined
      rawHandler = schemaOrHandler as ErasedHandler
    }
    this.register(method, path, schema, rawHandler)
    // The accumulated registry type is compile-time only; the same instance
    // carries every route, so the public methods re-type `this` per call.
    return this as unknown as Server<Registry, Ctx>
  }

  /**
   * Low-level route registration shared by the inline builder and `implement()`.
   * Captures the server's current `derive`/`decorate` chain into the route - this
   * is the "compiled", order-scoped per-route chain.
   */
  register(
    method: Method,
    path: string,
    schema: RouteSchema | undefined,
    handler: (context: never) => unknown,
  ): void {
    this.assertConfigurable("route registration")
    this.catalog.add(this.prepareRoute(method, path, schema, handler))
  }

  /** Register a contract/group route batch atomically. Every route captures the same current chain it
   * would capture through {@link register}; no route becomes visible unless the full batch validates. */
  registerBatch(
    routes: readonly {
      readonly method: Method
      readonly path: string
      readonly schema: RouteSchema | undefined
      readonly handler: (context: never) => unknown
    }[],
  ): void {
    this.assertConfigurable("route registration")
    const staged = routes.map(({ method, path, schema, handler }) =>
      this.prepareRoute(method, path, schema, handler),
    )
    this.catalog.addBatch(staged)
  }

  private prepareRoute(
    method: Method,
    path: string,
    schema: RouteSchema | undefined,
    handler: (context: never) => unknown,
  ): CatalogRoute {
    const pattern = compileRoutePattern(path)
    const capabilities = normalizeRouteCapabilities(schema?.capabilities)
    const handlerAssurance = assuranceDeclarationsOf(handler as unknown as object)
    const invalidHandlerScope = handlerAssurance.find(
      (declaration) => declaration.scope !== "plugin",
    )
    if (invalidHandlerScope !== undefined) {
      throw new RouteConfigError(
        "INVALID_ASSURANCE",
        `route handler assurance must use plugin scope (received ${invalidHandlerScope.scope})`,
      )
    }
    const authenticated = assuranceEvidenceFor(
      [...this.activeAssurance, ...handlerAssurance, ...this.globalAssurance],
      method,
      path,
    ).some((evidence) => evidence.id === NIFRA_ASSURANCE_IDS.AUTHENTICATED)
    const routeDecorations: Record<PropertyKey, unknown> = { ...this.decorations }
    if (capabilities.length > 0) {
      routeDecorations[CAPABILITY_GUARD] = createCapabilityGuard(
        capabilities,
        method,
        path,
        this.onCapabilityUse,
        this.idempotencyRuntime?.trackEffect,
        Object.freeze([...this.capabilityInterceptors]),
        Object.freeze([...this.capabilityObservers]),
      )
    }
    const hasDecorations = Reflect.ownKeys(routeDecorations).length > 0
    // An idempotency route runs a dedupe lane that must buffer the body and capture the response, so it
    // never takes the fused/native fast path - force it onto the portable matched lane (which routes
    // through `fetchMatched`, where the dedupe wrapper lives). Fail closed: a route may not declare
    // idempotency unless the idempotency runtime is installed, so the safety gate can never be silently
    // dropped by a missing plugin.
    if (schema?.idempotency !== undefined && this.idempotencyRuntime === undefined) {
      throw new RouteConfigError(
        "INVALID_IDEMPOTENCY",
        "route declares idempotency but the idempotency plugin is not installed; add .use(idempotency())",
      )
    }
    const idempotent = this.idempotencyRuntime?.resolve(schema, authenticated, this.maxBodyBytes)
    // A ledgered route (capabilities declared + `.use(effectLedger())`) needs a per-request
    // context to carry the ledger and a settle step to seal + sink it, so it too leaves the
    // fused/contextless fast path. Resolved per route, at registration - like the capability guard.
    const ledgered: ResolvedEffectLedger | undefined = this.effectLedgerRuntime?.resolve(
      capabilities,
      method,
      path,
    )
    // A checked response schema needs the handler's VALUE before it becomes bytes, and the fused and
    // native lanes exist precisely to skip that step. So a contracted route leaves them - the same
    // structural trade an idempotent route makes above. The check itself is not the cost: a compiled
    // validator measures ~100ns/response, within benchmark noise on any route these lanes already
    // exclude (middleware, derives, lifecycle hooks).
    const runtime = this.responseContractRuntime
    const contracted =
      runtime !== undefined && schema?.response !== undefined
        ? { runtime, schema: schema.response }
        : undefined
    const bare =
      schema?.params === undefined &&
      schema?.body === undefined &&
      schema?.query === undefined &&
      idempotent === undefined &&
      ledgered === undefined &&
      contracted === undefined &&
      this.derives.length === 0 &&
      this.beforeHandleHooks.length === 0 &&
      this.afterHandleHooks.length === 0 &&
      this.onErrorHooks.length === 0
    // A route whose ONLY lifecycle step is a query schema can fuse too: the parse + validate +
    // handler + respond collapse into one closure with no lifecycle promise on the sync path. The
    // guards mirror the `query` lane below PLUS everything the fused dispatch skips: around hooks,
    // the idempotency/ledger wrappers, and validation-error recovery (schema or server default) -
    // the fused invalid path is exactly `validationError(issues)`, so any recovery semantics keep
    // the generic lane.
    const fusedQuery =
      !bare &&
      contracted === undefined &&
      schema?.query !== undefined &&
      schema.body === undefined &&
      schema.params === undefined &&
      schema.onValidationError === undefined &&
      this.defaultOnValidationError === undefined &&
      idempotent === undefined &&
      ledgered === undefined &&
      this.derives.length === 0 &&
      this.beforeHandleHooks.length === 0 &&
      this.afterHandleHooks.length === 0 &&
      this.onErrorHooks.length === 0 &&
      this.aroundHooks.length === 0
    const bodyOnly =
      contracted === undefined &&
      schema?.body !== undefined &&
      schema.query === undefined &&
      schema.params === undefined &&
      this.derives.length === 0 &&
      this.beforeHandleHooks.length === 0 &&
      this.afterHandleHooks.length === 0 &&
      this.onErrorHooks.length === 0
    const fusedBody =
      !bare &&
      bodyOnly &&
      schema.onValidationError === undefined &&
      this.defaultOnValidationError === undefined &&
      idempotent === undefined &&
      ledgered === undefined &&
      this.aroundHooks.length === 0
    // Body-only routes still need an async body read, but eligible routes can compile the validation +
    // handler continuation once. The runner keeps the bounded parser and all error semantics while
    // avoiding the generic entry/schema/lifecycle dispatch on Bun, Deno, and Node-direct.
    const fusedBodyRunner = fusedBody
      ? this.buildFusedBodyRunner(
          handler as unknown as InternalHandler,
          schema.body as StandardSchemaV1,
          hasDecorations ? routeDecorations : undefined,
        )
      : undefined
    const fusedWeb =
      bare && this.aroundHooks.length === 0
        ? this.buildFusedWeb(
            handler as unknown as InternalHandler,
            hasDecorations ? routeDecorations : undefined,
            isContextlessNoArgArrow(handler),
          )
        : fusedQuery
          ? this.buildFusedQueryWeb(
              handler as unknown as InternalHandler,
              hasDecorations ? routeDecorations : undefined,
              schema.query as StandardSchemaV1,
            )
          : fusedBody
            ? this.buildFusedBodyWeb(fusedBodyRunner as FusedBodyRunner)
            : undefined
    const contextless = bare && this.aroundHooks.length === 0 && isContextlessNoArgArrow(handler)
    // The body and query lanes finalize the handler's result themselves, so a contracted route takes
    // the general lifecycle lane instead - one place owns the check rather than three.
    const lane = bare
      ? "bare"
      : bodyOnly
        ? "body"
        : contracted === undefined &&
            schema?.body === undefined &&
            schema?.query !== undefined &&
            schema.params === undefined &&
            this.derives.length === 0 &&
            this.beforeHandleHooks.length === 0 &&
            this.afterHandleHooks.length === 0 &&
            this.onErrorHooks.length === 0
          ? "query"
          : "lifecycle"
    // Lifecycle routes with no params schema are the common middleware shape: a derive/before hook
    // plus an optional query or body schema. Select their complete validation stage at registration
    // so the request path never re-checks params/body presence. Parameter-schema routes retain the
    // generic lifecycle runner until their more involved recovery matrix is selected explicitly.
    const lifecycleLane =
      lane !== "lifecycle" || schema?.params !== undefined
        ? undefined
        : schema?.body !== undefined
          ? schema.query !== undefined
            ? "body-query"
            : "body"
          : schema?.query !== undefined
            ? "query"
            : "hooks"
    // The realistic middleware shape is commonly exactly one synchronous-or-async derive followed
    // by one before hook. Keep the generic runner for every route that can observe decorations,
    // after hooks, error hooks, or response contracts; this lane only removes the two per-request
    // hook-loop dispatches and preserves the same async continuations and error handling.
    const lifecycleHookLane =
      lane === "lifecycle" &&
      contracted === undefined &&
      !hasDecorations &&
      this.derives.length === 1 &&
      this.beforeHandleHooks.length === 1 &&
      this.afterHandleHooks.length === 0 &&
      this.onErrorHooks.length === 0
        ? "derive-before"
        : undefined
    const execution = this.compileExecutionPlan(
      lane,
      contextless,
      this.aroundHooks.length > 0,
      ledgered !== undefined,
      lifecycleLane,
      fusedWeb,
      fusedBodyRunner,
      fusedWeb === undefined ? undefined : fusedQuery ? "query" : fusedBody ? "body" : "bare",
    )
    const registeredEntry: RouteEntry = {
      // (context: never) => unknown -> InternalHandler: the framework invokes it
      // with the concrete RawContext the typed handler expects, so this is sound.
      handler: handler as unknown as InternalHandler,
      schema,
      idempotent,
      ledgered,
      responseContract: contracted,
      derives: [...this.derives],
      decorations: routeDecorations,
      hasDecorations,
      beforeHandle: [...this.beforeHandleHooks],
      afterHandle: [...this.afterHandleHooks],
      onError: [...this.onErrorHooks],
      lifecycleHookLane,
      around: [...this.aroundHooks],
      execution,
    }
    const descriptor: RouteDescriptor = {
      method,
      path,
      schema,
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(schema?.family === true ? { family: true } : {}),
    }
    const routeAssurance: AssuranceDeclaration[] = [...this.activeAssurance, ...handlerAssurance]
    // Inline `schema.assurance`: the route DECLARES its enforcement evidence adjacent to the handler, so an
    // in-handler-guarded route satisfies a policy `require:` clause without a `withRouteAssurance` middleware
    // rewrite. Each id becomes route-scoped `declared` evidence (invalid ids fail closed at registration).
    for (const id of schema?.assurance ?? []) {
      if (!validEvidenceId(id)) {
        throw new Error(
          `route assurance: invalid evidence id ${JSON.stringify(id)} on ${method} ${path} (use lowercase dot/dash segments)`,
        )
      }
      routeAssurance.push(Object.freeze({ id, source: "declared", scope: "plugin" }))
    }
    if (schema?.body !== undefined) {
      routeAssurance.push(
        Object.freeze({
          id: NIFRA_ASSURANCE_IDS.BODY_BOUNDED,
          source: "route-schema",
          scope: "plugin",
        }),
      )
    }
    // Declaring `schema.idempotency` is evidence for request replay only. It deliberately never proves
    // durable command execution; that stronger evidence belongs to a command/outbox adapter.
    if (schema?.idempotency !== undefined) {
      routeAssurance.push(
        Object.freeze({
          id: NIFRA_ASSURANCE_IDS.IDEMPOTENCY_KEY,
          source: "route-schema",
          scope: "plugin",
        }),
      )
    }
    return {
      method,
      path,
      pattern,
      entry: registeredEntry,
      descriptor,
      assurance: Object.freeze(routeAssurance),
    }
  }

  /** Collapse route-invariant lifecycle decisions into one runner at registration. The request path
   * performs no eligibility ladder: it supplies request state to this already-selected plan. */
  private compileExecutionPlan(
    lane: "bare" | "body" | "query" | "lifecycle",
    contextless: boolean,
    hasAround: boolean,
    hasLedger: boolean,
    lifecycleLane: "hooks" | "query" | "body" | "body-query" | undefined,
    fusedWeb: FusedWebRunner | undefined,
    fusedBody: FusedBodyRunner | undefined,
    fusedLane: "bare" | "body" | "query" | undefined,
  ): RouteExecutionPlan {
    if (contextless) {
      const run: RouteExecutionRunner = (
        runtime,
        entry,
        source,
        params,
        search,
        signal,
        budget,
        platform,
        _nativeContext,
        finalize,
        wrapResponse,
      ) =>
        runtime.runContextlessBare(
          entry,
          source,
          params,
          search,
          signal,
          budget,
          platform,
          finalize,
          wrapResponse,
        )
      return Object.freeze({ run, fusedWeb, fusedBody, fusedLane })
    }

    let inner: ContextRouteRunner
    switch (lane) {
      case "bare":
        inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
          runtime.runBare(entry, ctx, finalize, wrapResponse)
        break
      case "body":
        inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
          runtime.runBodyOnly(entry, source, ctx, finalize, wrapResponse)
        break
      case "query":
        inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
          runtime.runQueryOnly(entry, ctx, finalize, wrapResponse)
        break
      default:
        switch (lifecycleLane) {
          case "hooks":
            inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
              runtime.runLifecycleHooks(entry, ctx, finalize, wrapResponse)
            break
          case "query":
            inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
              runtime.runLifecycleQuery(entry, ctx, finalize, wrapResponse)
            break
          case "body":
            inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
              runtime.runLifecycleBody(entry, source, ctx, finalize, wrapResponse)
            break
          case "body-query":
            inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
              runtime.runLifecycleBodyQuery(entry, source, ctx, finalize, wrapResponse)
            break
          default:
            inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
              runtime.runLifecycle(entry, source, ctx, finalize, wrapResponse)
        }
    }
    const execute: ContextRouteRunner = hasAround
      ? (runtime, entry, source, ctx, finalize, wrapResponse) =>
          runtime.runWithAround(
            entry,
            ctx,
            () => inner(runtime, entry, source, ctx, finalize, wrapResponse),
            finalize,
            wrapResponse,
          )
      : inner
    const run: RouteExecutionRunner = (
      runtime,
      entry,
      source,
      params,
      search,
      signal,
      budget,
      platform,
      nativeContext,
      finalize,
      wrapResponse,
    ) => {
      const ctx = nativeContext
        ? RequestContext.native(source, params, search, runtime.maxBodyBytes, platform)
        : new RequestContext(source, params, search, signal, budget, platform, runtime.maxBodyBytes)
      let ledger: RequestLedger | undefined
      // The runtime is always present when a route resolved a ledger (enforced at registration).
      const ledgerRuntime = runtime.effectLedgerRuntime
      if (hasLedger && ledgerRuntime !== undefined) {
        const resolved = entry.ledgered as ResolvedEffectLedger
        ledger = ledgerRuntime.create(resolved)
        ledgerRuntime.attach(ctx, ledger)
      }
      let outcome = execute(runtime, entry, source, ctx, finalize, wrapResponse)
      if (ledger !== undefined && ledgerRuntime !== undefined) {
        const active = ledger
        const resolved = entry.ledgered as ResolvedEffectLedger
        outcome = (outcome instanceof Promise ? outcome : Promise.resolve(outcome)).then((value) =>
          ledgerRuntime.settle(active, resolved, value, (fields) =>
            runtime.logger.error("effect ledger sink failed", fields),
          ),
        )
      }
      return outcome
    }
    return Object.freeze({ run, fusedWeb, fusedBody, fusedLane })
  }

  /** The idempotency lane's bridge back into the normal matched lanes, resolved to a concrete Response
   * (the lane buffers the body, then replays it through the route's real validation + handler). */
  private idempotencyRunLanes(
    buffered: RequestSource,
    platform: Platform | undefined,
    entry: RouteEntry,
    params: Record<string, string>,
    search: string | undefined,
  ): Promise<Response> {
    return Promise.resolve(
      this.runMatchedLanes(
        buffered,
        platform,
        entry,
        params,
        search,
        this.finalizeResponse,
        this.wrapWebResponse,
        this.webResponseTimeout,
        false,
      ),
    )
  }

  /** @internal Symbol-keyed install seam for the `responseContract()` plugin. Off the public typed surface. */
  [INSTALL_RESPONSE_CONTRACT](runtime: ResponseContractRuntime): void {
    this.assertConfigurable("responseContract()")
    this.responseContractRuntime = runtime
  }

  /** @internal Symbol-keyed install seam for the `idempotency()` plugin. Off the public typed surface. */
  [INSTALL_IDEMPOTENCY](runtime: IdempotencyRuntime): void {
    this.assertConfigurable("idempotency()")
    this.idempotencyRuntime = runtime
  }

  /** @internal Symbol-keyed install seam for the `mcp()` plugin. Off the public typed surface. */
  [INSTALL_MCP](runtime: McpRuntime): void {
    this.assertConfigurable("mcp()")
    this.mcpRuntime = runtime
  }

  /** @internal Symbol-keyed install seam for the `nodeDirect()` plugin. Off the public typed surface. */
  [INSTALL_NODE_DIRECT](runtime: NodeOutcomeRuntime): void {
    this.assertConfigurable("nodeDirect()")
    this.nodeOutcomeRuntime = runtime
  }

  /** @internal Symbol-keyed install seam for the `streaming()` plugin. Off the public typed surface. */
  [INSTALL_SSE](runtime: SseRuntime): void {
    this.assertConfigurable("streaming()")
    this.sseRuntime = runtime
  }

  /** @internal Symbol-keyed install seam for the `websocket()` plugin. Off the public typed surface. */
  [INSTALL_WS](runtime: WsRuntime): void {
    this.assertConfigurable("websocket()")
    this.wsRuntime = runtime
  }

  /**
   * Merge another server's routes into this one - the composition escape hatch for large apps.
   *
   * WHY: the fluent chain accumulates one type-alias level per route, and TypeScript resolves
   * that stack in one recursion - a single chain hits TS2589 at ~95 routes. Groups keep every
   * chain short: build each domain (`listings`, `agents`, …) as its own `server()` (its registry
   * resolves independently), then `app.merge(listings).merge(agents)` - each merge adds ONE level
   * regardless of group size. 300+ routes stay fully typed (see many-routes.test-d.ts). The
   * other escape hatch is contract-first `implement()`, whose registry is a single object type.
   *
   * Semantics: merged routes keep the chains captured where they were DEFINED - the group's
   * `derive`/`decorate`/`beforeHandle`/`afterHandle`/`onError`/`around` apply to its routes
   * exactly as they did standalone, so a group wires its own plugins. The group's request-level
   * hooks (`onRequest`/`onResponse`/`onResponseFinalized`) are appended to this server's. This
   * server's route-scoped chains do NOT retroactively wrap merged routes (order-scoped, like
   * routes registered before a `derive`). Fail closed: a path+method collision throws
   * `RouteConfigError` at merge time, and a group with WebSocket routes is refused (register
   * those on the parent).
   */
  merge<R2 extends Registry, Ctx2>(other: Server<R2, Ctx2>): Server<R & R2, Ctx> {
    this.assertConfigurable("merge()")
    const source = other as unknown as Server<Registry, EmptyContext>
    if (source.wsRouteCount > 0) {
      throw new RouteConfigError(
        "INVALID_PATH",
        "merge() does not carry WebSocket routes - register .ws() routes on the parent server",
      )
    }
    this.catalog.addBatch(source.catalog.entries().map((route) => this.bindFusedRuntime(route)))
    // Resolved idempotency/ledger route entries carry their own store/sink configuration, while the
    // runtime object supplies the generic execution machinery. Preserve a group's installed runtime
    // when the parent has none so merging cannot silently disable a safety lane. If the parent already
    // has a runtime, either implementation can execute every resolved entry because route-specific
    // options were pinned during registration.
    this.responseContractRuntime ??= source.responseContractRuntime
    this.idempotencyRuntime ??= source.idempotencyRuntime
    this.effectLedgerRuntime ??= source.effectLedgerRuntime
    this.mcpRuntime ??= source.mcpRuntime
    this.nodeOutcomeRuntime ??= source.nodeOutcomeRuntime
    this.sseRuntime ??= source.sseRuntime
    this.wsRuntime ??= source.wsRuntime
    this.onRequestHooks.push(...source.onRequestHooks)
    this.onNodeRequestHooks.push(...source.onNodeRequestHooks)
    this.nodeRequestHooksComplete &&= source.nodeRequestHooksComplete
    // The group's static declarations came before its own response hooks, so they are folded in
    // first - and fold themselves into a hook here if this server already has one (same ordering
    // rule as a direct `responseHeaders()` call).
    if (source.staticResponseHeaders !== undefined) {
      this.addStaticResponseHeaders({ ...source.staticResponseHeaders.record })
    }
    this.onResponseHooks.push(...source.onResponseHooks)
    this.onNodeResponseHooks.push(...source.onNodeResponseHooks)
    this.nodeResponseHooksComplete &&= source.nodeResponseHooksComplete
    this.onResponseFinalizedHooks.push(...source.onResponseFinalizedHooks)
    if (source.responseBodyTag !== undefined) {
      const owner = this.enableResponseBodyTagging()
      this.responseBodyOwners.add(source.responseBodyTag)
      source.responseBodyOwners.add(owner)
    }
    this.globalAssurance.push(...source.globalAssurance)
    this.mcpResourceList.push(...source.mcpResourceList)
    this.mcpPromptList.push(...source.mcpPromptList)
    return this as unknown as Server<R & R2, Ctx>
  }

  /** A fused renderer closes over runtime services to keep its seven-argument JSC fast path. Merging
   * rebinds that closure once to the executing server; generic plans already receive the runtime. */
  private bindFusedRuntime(route: CatalogRoute): CatalogRoute {
    const { entry } = route
    if (entry.execution.fusedWeb === undefined) return route
    // Rebuild with the SAME builder that produced the closure - rebinding a query-fused route as
    // bare would silently drop its validation.
    const fusedBody =
      entry.execution.fusedLane === "body"
        ? this.buildFusedBodyRunner(
            entry.handler,
            entry.schema?.body as StandardSchemaV1,
            entry.hasDecorations ? entry.decorations : undefined,
          )
        : undefined
    const fusedWeb =
      entry.execution.fusedLane === "body"
        ? this.buildFusedBodyWeb(fusedBody as FusedBodyRunner)
        : entry.execution.fusedLane === "query"
          ? this.buildFusedQueryWeb(
              entry.handler,
              entry.hasDecorations ? entry.decorations : undefined,
              entry.schema?.query as StandardSchemaV1,
            )
          : this.buildFusedWeb(
              entry.handler,
              entry.hasDecorations ? entry.decorations : undefined,
              isContextlessNoArgArrow(entry.handler),
            )
    return {
      ...route,
      entry: {
        ...entry,
        execution: Object.freeze({ ...entry.execution, fusedWeb, fusedBody }),
      },
    }
  }

  /**
   * Enumerate the registered routes (method, path, input schemas), in registration
   * order. Powers `toOpenAPI` and other introspection; the router trie itself no
   * longer holds the original patterns.
   */
  routes(): ReadonlyArray<RouteDescriptor> {
    if (this.activeAssurance.length === 0 && this.globalAssurance.length === 0) {
      if (!this.catalog.hasAssurance()) {
        return this.catalog.routeDescriptors()
      }
    }
    return this.catalog.entries().map(({ method, path, descriptor, assurance }) => {
      const effective = assuranceEvidenceFor([...assurance, ...this.globalAssurance], method, path)
      return effective.length > 0 ? { ...descriptor, assurance: effective } : descriptor
    })
  }

  /**
   * Resolve a `Request` to a `Response` - the whole lifecycle, testable without a port. The
   * optional `platform` carries edge inputs (`env`, `waitUntil`); edge adapters pass it, and
   * Bun/Node/Deno omit it (then `c.env` is `undefined` and `c.waitUntil` runs fire-and-forget).
   */
  fetch(req: Request, platform?: Platform<EnvOf<Ctx>>): MaybePromise<Response> {
    // A real `Request` satisfies `RequestSource`, so it's passed straight through - no per-request
    // wrapper allocation on the Web/Bun hot path.
    return this.fetchSource(req, platform)
  }

  private fetchSource(
    source: RequestSource,
    platform?: Platform<EnvOf<Ctx>>,
  ): MaybePromise<Response> {
    // Off path (default): straight through - one property check, no closure, no promise.
    if (this.capacityGate === undefined) return this.fetchSourceInner(source, platform)
    return this.admitGated(requestOf(source), () => this.fetchSourceInner(source, platform))
  }

  private fetchSourceInner(
    source: RequestSource,
    platform?: Platform<EnvOf<Ctx>>,
  ): MaybePromise<Response> {
    // Non-`async` on purpose: `dispatch` may return a `Response` *synchronously* (the bare-route fast
    // path, selected by the compiled execution plan), and an `async fetch` would wrap every such result in a redundant
    // promise + microtask. Returning `Response | Promise<Response>` matches Web/edge handlers, while
    // `await app.fetch(...)` continues to work exactly as before.
    const outcome = this.dispatch<Response>(
      source,
      platform,
      this.finalizeResponse,
      this.wrapWebResponse,
      this.webResponseTimeout,
      true,
    )
    if (this.onResponseHooks.length === 0 && this.onResponseFinalizedHooks.length === 0) {
      return outcome
    }
    // onResponse sees every response - success, validation error, 404/405, timeout, onRequest
    // short-circuit; normalize to a promise, then thread through the hooks.
    return outcome instanceof Promise
      ? outcome.then((response) =>
          this.applyOnResponseAndFinalize(response, this.takeResponseRequest(source)),
        )
      : this.applyOnResponseAndFinalize(outcome, this.takeResponseRequest(source))
  }

  /** Web response path when Bun already matched the route. The lifecycle and response hooks remain
   * exactly the same as {@link fetchSource}; only portable URL scanning + trie lookup are skipped. */
  private fetchMatched(
    source: RequestSource,
    entry: RouteEntry,
    params: Record<string, string>,
  ): MaybePromise<Response> {
    if (this.capacityGate === undefined) return this.fetchMatchedInner(source, entry, params)
    return this.admitGated(requestOf(source), () => this.fetchMatchedInner(source, entry, params))
  }

  private fetchMatchedInner(
    source: RequestSource,
    entry: RouteEntry,
    params: Record<string, string>,
  ): MaybePromise<Response> {
    const outcome = this.runMatched(
      source,
      undefined,
      entry,
      params,
      undefined,
      this.finalizeResponse,
      this.wrapWebResponse,
      this.webResponseTimeout,
      true,
    )
    if (this.onResponseHooks.length === 0 && this.onResponseFinalizedHooks.length === 0) {
      return outcome
    }
    return outcome instanceof Promise
      ? outcome.then((response) => this.applyOnResponseAndFinalize(response, requestOf(source)))
      : this.applyOnResponseAndFinalize(outcome, requestOf(source))
  }

  /**
   * Run `produce` under the capacity gate: admit → run → release exactly once when the response is
   * produced (or the run throws). Only reached when {@link capacityGate} is set, so the off path pays
   * nothing. The slot is held for the duration of handler execution, not the streaming of the body -
   * capacity here bounds concurrent *work*, matching how in-flight is counted.
   */
  private admitGated(req: Request, produce: () => MaybePromise<Response>): MaybePromise<Response> {
    const decision = (this.capacityGate as AdmissionController).admit(req)
    return decision instanceof Promise
      ? decision.then((settled) => this.runAdmitted(settled, produce))
      : this.runAdmitted(decision, produce)
  }

  private runAdmitted(
    decision: AdmissionDecision,
    produce: () => MaybePromise<Response>,
  ): MaybePromise<Response> {
    if (!decision.admitted) return decision.response // shed: ready 429, no slot held
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      decision.release()
    }
    let outcome: MaybePromise<Response>
    try {
      outcome = produce()
    } catch (error) {
      release()
      throw error
    }
    // Release the slot once the response settles - on resolve OR reject - via `finally`, which passes
    // the value/rejection through unchanged. (A single settle hook, rather than separate then-arms: the
    // request pipeline resolves handler errors to a Response, so a rejection arm would be unreachable.)
    if (outcome instanceof Promise) return outcome.finally(release)
    release()
    return outcome
  }

  /**
   * Like {@link fetch}, but renders a plain-data result **without** building a Web `Response` - the
   * `@nifrajs/node` adapter serializes the returned primitives straight to the socket, skipping the undici
   * `Response` build + body drain (the bulk of the Node bridge cost, measured ≈4µs/req). A handler that
   * returns a `Response`, an error/short-circuit, or a response hook that replaces/consumes the buffered
   * body stays on the full Web path; an in-place response hook can still use the direct writer. Same
   * lifecycle as {@link fetch} (body cap, validation, hooks all run); only the final render differs.
   */
  resolveNode(req: Request, platform?: Platform<EnvOf<Ctx>>): MaybePromise<NodeServeOutcome> {
    return this.resolveNodeSource(req, platform)
  }

  resolveNodeSource(
    source: RequestSource,
    platform?: Platform<EnvOf<Ctx>>,
    suppliedRuntime?: NodeOutcomeRuntime,
  ): MaybePromise<NodeServeOutcome> {
    // A paired header-only native hook can preserve the Node-direct JSON/body outcome for successful
    // responses. Arbitrary onResponse transforms need a real Web Response, but a buffered outcome can
    // be materialized with a direct-write marker and return to the socket path when the hook mutates
    // it in place. Finalization observers and the capacity gate still wrap the complete Web path.
    // The native response lane engages only when the REQUEST side is native too (or there are no
    // request hooks at all). This is what makes the NodeRequestContext identity contract hold: a
    // web request-hook walk can rewrite the request, so its response-side view is a synthetic
    // wrapper - a different object - and any middleware carrying per-request state from its request
    // twin to its response twin through a WeakMap would silently miss. Coupling the gates means a
    // response twin always sees the exact object its request twin saw.
    const nativeResponseHooks =
      this.canUseNodeResponseHooks() &&
      (this.onRequestHooks.length === 0 || this.canUseNodeRequestHooks())
    const webResponseHooks = this.onResponseHooks.length > 0 && !nativeResponseHooks
    if (this.onResponseFinalizedHooks.length > 0 || this.capacityGate !== undefined) {
      const response = this.fetchSource(source, platform)
      return response instanceof Promise
        ? response.then((settled) => ({ kind: "response", response: settled }))
        : { kind: "response", response }
    }
    // May resolve **synchronously** for a compiled bare route + sync handler - the `@nifrajs/node`
    // adapter `await`s the result, so it transparently handles either; the sync case allocates no promise
    // at all on the Node hot path.
    const runtime = suppliedRuntime ?? this.nodeOutcomeRuntime
    if (runtime === undefined) {
      throw new FrameworkError(
        "NODE_DIRECT_RUNTIME_MISSING",
        "resolveNode() needs the Node-direct renderer. Normal @nifrajs/node serving installs it automatically; direct callers should add `.use(nodeDirect())` (from `@nifrajs/core/node-direct`).",
      )
    }
    const resolved = this.dispatch<NodeServeOutcome>(
      source,
      platform,
      runtime.toOutcome,
      runtime.fromResponse,
      runtime.timeout,
      false,
    )
    // Fold declared static headers into the record ONCE, here: before any native twin runs (so a
    // header or body hook reads them through its view), and on the no-hook path too (which returns
    // the outcome straight to the writer without the finish step below).
    const statics = this.staticResponseHeaders
    const outcome =
      statics === undefined
        ? resolved
        : resolved instanceof Promise
          ? resolved.then((settled) => withStaticNodeHeaders(settled, statics))
          : withStaticNodeHeaders(resolved, statics)
    if (webResponseHooks) {
      return outcome instanceof Promise
        ? outcome.then((settled) => this.finishNodeWebResponse(settled, source, runtime))
        : this.finishNodeWebResponse(outcome, source, runtime)
    }
    if (!nativeResponseHooks) return outcome
    try {
      return outcome instanceof Promise
        ? outcome.then((settled) => this.finishNodeResponse(settled, source, runtime))
        : this.finishNodeResponse(outcome, source, runtime)
    } catch (error) {
      // Keep resolveNode's failure shape promise-based, matching app.fetch and the adapter bridge.
      return Promise.reject(error)
    }
  }

  /** Run generic Web response middleware while retaining direct writes for untouched buffered bodies. */
  private finishNodeWebResponse(
    outcome: NodeServeOutcome,
    source: RequestSource,
    runtime: NodeOutcomeRuntime,
  ): MaybePromise<NodeServeOutcome> {
    const req = this.takeResponseRequest(source)
    const response = runtime.toResponse(outcome)
    const transformed = this.applyOnResponseAndFinalize(response, req)
    return transformed instanceof Promise
      ? transformed.then(runtime.fromResponse)
      : runtime.fromResponse(transformed)
  }

  /** True only when every transforming Web response hook has a header-only Node equivalent. */
  private canUseNodeResponseHooks(): boolean {
    return this.onResponseHooks.length > 0 && this.nodeResponseHooksComplete
  }

  /** Apply paired native hooks to data outcomes; preserve the complete Web hook pipeline for Response outcomes. */
  private finishNodeResponse(
    outcome: NodeServeOutcome,
    source: RequestSource,
    runtime: NodeOutcomeRuntime,
  ): MaybePromise<NodeServeOutcome> {
    if (outcome.kind === "response") {
      const req = this.takeResponseRequest(source)
      const transformed = this.applyOnResponseAndFinalize(outcome.response, req)
      return transformed instanceof Promise
        ? transformed.then(runtime.fromResponse)
        : runtime.fromResponse(transformed)
    }

    let headers = outcome.headers as Record<string, string | readonly string[]> | undefined
    if (outcome.kind === "json" && outcome.body !== null) {
      // The json render adds its Content-Type at WRITE time, so a body hook checking content types
      // would see nothing. Materialize the writer's own value into the hook-visible record - same
      // string the writer would emit, so the wire is unchanged.
      const hasType =
        headers !== undefined &&
        Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
      if (!hasType) {
        const defaultContentType = runtime.jsonContentType ?? "application/json;charset=utf-8"
        if (headers === undefined) {
          headers = { "content-type": defaultContentType }
        } else {
          // The record belongs to this outcome. Add the implicit JSON type in place so the native
          // header walk does not clone every c.set.headers record before it can run. A hook that
          // replaces or deletes the type still takes the existing withNodeResponseHeaders path;
          // the writer's final defaulting behavior remains unchanged.
          headers["content-type"] = defaultContentType
        }
      }
    }
    const context: NodeResponseContext = {
      status: outcome.status,
      headers,
      cookies: outcome.kind === "json" ? outcome.cookies : undefined,
      body: outcome.body,
    }
    const applied = this.applyNodeResponseHooks(context, this.takeNodeResponseRequest(source))
    if (applied instanceof Promise) {
      return applied.then(() => this.withNodeResponseHeaders(outcome, context))
    }
    return this.withNodeResponseHeaders(outcome, context)
  }

  private withNodeResponseHeaders(
    outcome: Exclude<NodeServeOutcome, { kind: "response" }>,
    context: NodeResponseContext,
  ): NodeServeOutcome {
    const outcomeCookies = outcome.kind === "json" ? outcome.cookies : undefined
    const bodyChanged = context.body !== outcome.body
    const statusChanged = context.status !== outcome.status
    if (
      context.headers === outcome.headers &&
      context.cookies === outcomeCookies &&
      !bodyChanged &&
      !statusChanged
    ) {
      return outcome
    }
    let headers = context.headers
    if (bodyChanged && headers !== undefined) {
      // A replaced body invalidates any explicitly carried length; the writers re-derive framing
      // from the final bytes.
      const stale = Object.keys(headers).find((key) => key.toLowerCase() === "content-length")
      if (stale !== undefined) {
        headers = { ...headers }
        delete headers[stale]
      }
    }
    if (outcome.kind === "json") {
      if (bodyChanged && context.body !== null && typeof context.body !== "string") {
        // A binary replacement can't ride the json render - switch to the buffered-body render,
        // folding queued cookies into explicit set-cookie lines so nothing is dropped.
        const record = Object.create(null) as Record<string, string | readonly string[]>
        if (headers !== undefined) Object.assign(record, headers)
        if (context.cookies !== undefined && context.cookies.length > 0) {
          record["set-cookie"] = [...context.cookies]
        }
        return { kind: "body", status: context.status, headers: record, body: context.body }
      }
      return {
        ...outcome,
        status: context.status,
        headers,
        cookies: context.cookies,
        body: bodyChanged ? (context.body as string | null) : outcome.body,
      }
    }
    return {
      ...outcome,
      status: context.status,
      headers,
      body: bodyChanged
        ? ((context.body ?? new Uint8Array(0)) as string | Uint8Array)
        : outcome.body,
    }
  }

  /** Synchronous until a native response hook actually returns a Promise. */
  private applyNodeResponseHooks(
    response: NodeResponseContext,
    req: NodeRequestContext,
  ): MaybePromise<void> {
    for (let i = 0; i < this.onNodeResponseHooks.length; i++) {
      const hook = this.onNodeResponseHooks[i] as NodeResponseHook
      const result = hook(response, req)
      if (result instanceof Promise)
        return result.then(() => this.continueNodeResponseHooks(i + 1, response, req))
    }
  }

  private async continueNodeResponseHooks(
    start: number,
    response: NodeResponseContext,
    req: NodeRequestContext,
  ): Promise<void> {
    for (let i = start; i < this.onNodeResponseHooks.length; i++) {
      const hook = this.onNodeResponseHooks[i] as NodeResponseHook
      await hook(response, req)
    }
  }

  /**
   * Resolve a WebSocket upgrade - the seam every serving adapter uses. Returns `pass` (not a WS
   * upgrade for a registered route → handle as normal HTTP), `reject` (a WS route matched but
   * `upgrade()` rejected, or the path was malformed → return `response`), or `upgrade` (perform the
   * runtime upgrade, then dispatch the native socket's events to `handler`, seeding `ws.data` with
   * `data`). Runs the route's `upgrade(c)` guard in a real request context. Synchronous unless
   * `upgrade()` is async; a throw rejects with a flat 500 (no detail leaked).
   */
  resolveWebSocketUpgrade(
    req: Request,
    platform?: Platform<EnvOf<Ctx>>,
  ): MaybePromise<WebSocketUpgradeOutcome> {
    if (this.wsRouteCount === 0) return WS_PASS
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return WS_PASS
    const url = urlPartsOf(req.url)
    const match = this.wsRouter.find("GET", url.pathname)
    if (!match.found) return WS_PASS // upgrade header, no WS route here → normal routing decides
    // Inspect only captured values for escapes. Scanning the full pathname repeated work the router
    // already did and made every plain dynamic route pay for unrelated static path bytes.
    const params = match.params === EMPTY_PARAMS ? match.params : decodeRouteParams(match.params)
    if (params === null) return { kind: "reject", response: jsonError(400, "malformed_path") }
    const handler = match.payload.handler
    // Non-null: wsRouteCount > 0 ⇒ ws() ran ⇒ `.use(websocket())` installed the runtime + registry.
    const pubsub = this.topics as TopicRegistry
    const attach = (this.wsRuntime as WsRuntime).attach
    // CSWSH guard, before any per-connection work or the user's upgrade(): reject a disallowed
    // Origin with 403. Browsers don't CORS-protect WS handshakes but do send cookies, so this
    // blocks cross-site authenticated sockets when the route opts in via `allowedOrigins`.
    const origin = req.headers.get("origin")
    if (handler.allowedOrigins !== undefined) {
      const allowed =
        typeof handler.allowedOrigins === "function"
          ? handler.allowedOrigins(origin)
          : origin !== null && handler.allowedOrigins.includes(origin)
      if (!allowed) return { kind: "reject", response: jsonError(403, "forbidden_origin") }
    } else if (origin !== null && !wsSameOrigin(origin, req)) {
      // Secure default (no explicit `allowedOrigins`): reject a CROSS-ORIGIN browser handshake - the
      // CSWSH case, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser
      // clients send no `Origin` and pass; same-origin browsers pass. Set `allowedOrigins` to permit
      // specific cross-origin clients (or `() => true` for a genuinely public socket).
      return { kind: "reject", response: jsonError(403, "forbidden_origin") }
    }
    if (handler.upgrade === undefined) {
      return { kind: "upgrade", handler, data: undefined, pubsub, attach }
    }
    const upgradeSignal = getNeverAbortSignal()
    const ctx = new RequestContext(
      req,
      params,
      url.search,
      upgradeSignal,
      createUnboundedRequestBudget(upgradeSignal),
      platform,
      this.maxBodyBytes,
    )
    const settle = (value: unknown): WebSocketUpgradeOutcome =>
      value instanceof Response
        ? { kind: "reject", response: value }
        : { kind: "upgrade", handler, data: value, pubsub, attach }
    try {
      const result = handler.upgrade(ctx as unknown as WebSocketContext<EnvOf<Ctx>>)
      return result instanceof Promise
        ? result.then(settle, () => ({
            kind: "reject" as const,
            response: jsonError(500, "internal_error"),
          }))
        : settle(result)
    } catch {
      return { kind: "reject", response: jsonError(500, "internal_error") }
    }
  }

  /** Bun `fetch` when WS routes exist: try a WS upgrade first, else run the normal HTTP lifecycle.
   * `undefined` ⇒ Bun owns the upgraded socket; a `Response` ⇒ a normal reply or a rejected upgrade.
   * (The socket dispatch itself lives in `ws-bun.ts`, loaded via `@nifrajs/core/ws`.) */
  private bunFetchWithWebSocket(
    req: Request,
    server: BunUpgradeServer,
  ): MaybePromise<Response | undefined> {
    const handle = (o: WebSocketUpgradeOutcome): MaybePromise<Response | undefined> => {
      if (o.kind === "pass")
        return this.fetch(req, bunPeerPlatform(server, req) as Platform<EnvOf<Ctx>>)
      if (o.kind === "reject") return o.response
      return server.upgrade(req, { data: { handler: o.handler, data: o.data } })
        ? undefined
        : jsonError(426, "upgrade_required")
    }
    const outcome = this.resolveWebSocketUpgrade(req)
    return outcome instanceof Promise ? outcome.then(handle) : handle(outcome)
  }

  /**
   * The shared lifecycle, generic over how the final value is rendered: `finalize` turns a handler's
   * result + `set` into the output `T` (`toResponse` → a Web `Response`; `toNodeOutcome` → node-direct
   * primitives), `wrapResponse` lifts an early/error `Response` into that same `T`, and `onTimeout`
   * produces the 503. The Web `fetch` and `resolveNode` are thin callers over this one routing +
   * context + lifecycle implementation - no duplication across the trust boundary.
   */
  /** Apply the `clientIp` trust declaration to the adapter's raw socket peer, returning a platform
   * whose `clientIp` is the derived caller. Only called when a trust declaration is configured. */
  private deriveClientIp(
    source: RequestSource,
    platform: Platform | undefined,
  ): Platform | undefined {
    const derived = resolveClientIp(platform?.clientIp, requestOf(source), this.clientIpTrust)
    return { ...platform, clientIp: derived }
  }

  private dispatch<T>(
    source: RequestSource,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
    // True only from the Web `fetch` path - unlocks each route's fused lane, whose output type IS
    // `Response` (`T = Response` there by construction; the node path always passes false).
    webFast: boolean,
  ): MaybePromise<T> {
    // Resolve the trust declaration into the platform's `clientIp` ONCE, here at the shared funnel, so
    // `c.clientIp` (and every hook/derive downstream) sees the derived caller. No config ⇒ the raw
    // socket peer the adapter supplied passes through untouched (a one-property no-op on the hot path).
    const resolved =
      this.clientIpTrust === undefined ? platform : this.deriveClientIp(source, platform)
    // onRequest hooks may be async, so a hooked app takes the async path; with no hooks (the common
    // case) routing stays synchronous, letting a bare route resolve with no lifecycle promise at all.
    if (this.onRequestHooks.length === 0) {
      return this.routeAndRun(source, resolved, finalize, wrapResponse, onTimeout, webFast)
    }
    if (!webFast && this.canUseNodeRequestHooks()) {
      return this.runWithNodeRequest(source, resolved, finalize, wrapResponse, onTimeout)
    }
    return this.runWithOnRequest(source, resolved, finalize, wrapResponse, onTimeout, webFast)
  }

  /** Node-native request hook walk. A header-only hook can inspect the lazy source without forcing a
   * Web `Request`; arbitrary request rewrites and full Web hooks use {@link runWithOnRequest}. */
  private runWithNodeRequest<T>(
    source: RequestSource,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
  ): MaybePromise<T> {
    const hooks = this.onNodeRequestHooks
    const request = this.nodeRequestContextOf(source)
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i] as NodeRequestHook
      const outcome = hook(request, platform)
      if (outcome instanceof Promise) {
        return outcome.then((early) =>
          this.continueNodeRequest(
            early,
            i + 1,
            request,
            source,
            platform,
            finalize,
            wrapResponse,
            onTimeout,
          ),
        )
      }
      if (outcome !== undefined) return wrapResponse(outcome)
    }
    return this.routeAndRun(source, platform, finalize, wrapResponse, onTimeout, false)
  }

  private async continueNodeRequest<T>(
    first: Response | undefined,
    nextIndex: number,
    request: NodeRequestContext,
    source: RequestSource,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
  ): Promise<T> {
    if (first !== undefined) return wrapResponse(first)
    for (let i = nextIndex; i < this.onNodeRequestHooks.length; i++) {
      const hook = this.onNodeRequestHooks[i] as NodeRequestHook
      const outcome = hook(request, platform)
      const early = outcome instanceof Promise ? await outcome : outcome
      if (early !== undefined) return wrapResponse(early)
    }
    return this.routeAndRun(source, platform, finalize, wrapResponse, onTimeout, false)
  }

  private canUseNodeRequestHooks(): boolean {
    return this.onRequestHooks.length > 0 && this.nodeRequestHooksComplete
  }

  /**
   * onRequest short-circuit path. Synchronous as long as every hook returns synchronously (the
   * common case - e.g. CORS returning `undefined` for a non-preflight request): an `async` version
   * here put EVERY request of any app with one onRequest hook onto the promise machinery, profiled
   * at ~13% of a realistic request. The first hook that returns a Promise hands the REMAINING
   * hooks to the async continuation; behavior is identical.
   */
  private runWithOnRequest<T>(
    source: RequestSource,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
    webFast: boolean,
  ): MaybePromise<T> {
    const hooks = this.onRequestHooks
    const originalRequest = requestOf(source)
    this.responseSources.set(source as object, originalRequest)
    let current: RequestSource = source
    for (let i = 0; i < hooks.length; i++) {
      const outcome = (hooks[i] as RawOnRequest)(requestOf(current), platform)
      if (outcome instanceof Promise) {
        return outcome.then((early) =>
          this.continueOnRequest(
            early,
            i + 1,
            originalRequest,
            current,
            platform,
            finalize,
            wrapResponse,
            onTimeout,
            webFast,
          ),
        )
      }
      if (outcome instanceof Request) {
        current = outcome
        if (outcome !== originalRequest) this.responseRequests.set(originalRequest, outcome)
        continue
      }
      if (outcome !== undefined) return wrapResponse(outcome)
    }
    return this.routeAndRun(current, platform, finalize, wrapResponse, onTimeout, webFast)
  }

  /** Async tail of {@link runWithOnRequest}: applies the first awaited hook's outcome, then runs
   * the remaining hooks (awaiting freely - we're already async here). */
  private async continueOnRequest<T>(
    first: OnRequestResult,
    nextIndex: number,
    originalRequest: Request,
    sourceAtAwait: RequestSource,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
    webFast: boolean,
  ): Promise<T> {
    let current = sourceAtAwait
    let early = first
    let index = nextIndex
    for (;;) {
      if (early instanceof Request) {
        current = early
        if (early !== originalRequest) this.responseRequests.set(originalRequest, early)
      } else if (early !== undefined) {
        return wrapResponse(early)
      }
      if (index >= this.onRequestHooks.length) break
      const outcome = (this.onRequestHooks[index] as RawOnRequest)(requestOf(current), platform)
      early = outcome instanceof Promise ? await outcome : outcome
      index++
    }
    return this.routeAndRun(current, platform, finalize, wrapResponse, onTimeout, webFast)
  }

  private takeResponseRequest(source: RequestSource): Request {
    const tracked = this.responseSources.get(source as object)
    if (tracked !== undefined) {
      this.responseSources.delete(source as object)
      const rewritten = this.responseRequests.get(tracked)
      if (rewritten !== undefined) {
        this.responseRequests.delete(tracked)
        return rewritten
      }
      return tracked
    }
    const request = requestOf(source)
    const rewritten = this.responseRequests.get(request)
    if (rewritten === undefined) return request
    this.responseRequests.delete(request)
    return rewritten
  }

  /**
   * The NodeRequestContext for a source, MEMOIZED per source so the request twins and the response
   * twins receive the exact same object within one request - that identity is the documented
   * contract stateful twins key their WeakMaps on. An adapter source (which already speaks the
   * interface) is returned as-is; a plain `Request` source (a direct `resolveNode` caller) gets one
   * cached wrapper.
   */
  private nodeRequestContextOf(source: RequestSource): NodeRequestContext {
    if (source.header !== undefined) return source as unknown as NodeRequestContext
    let context = this.nodeContexts.get(source as object)
    if (context === undefined) {
      const request = requestOf(source)
      context = {
        method: request.method,
        url: request.url,
        header: (name) => request.headers.get(name),
      }
      this.nodeContexts.set(source as object, context)
    }
    return context
  }

  /** Preserve the request visible to generic onRequest hooks for paired native response hooks. */
  private takeNodeResponseRequest(source: RequestSource): NodeRequestContext {
    const tracked = this.responseSources.get(source as object)
    if (tracked !== undefined) {
      this.responseSources.delete(source as object)
      const rewritten = this.responseRequests.get(tracked)
      if (rewritten !== undefined) {
        this.responseRequests.delete(tracked)
        return {
          method: rewritten.method,
          url: rewritten.url,
          header: (name) => rewritten.headers.get(name),
        }
      }
      return {
        method: tracked.method,
        url: tracked.url,
        header: (name) => tracked.headers.get(name),
      }
    }
    return this.nodeRequestContextOf(source)
  }

  /**
   * Route → build context → run. Synchronous through to the handler for a **bare** route
   * (selected by its compiled plan), so a sync handler produces its result with zero promise allocations;
   * routes with validation/hooks keep the full async {@link runLifecycle}, unchanged.
   */
  private routeAndRun<T>(
    source: RequestSource,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
    webFast: boolean,
  ): MaybePromise<T> {
    // Routing only needs the pathname. Scan the URL once but keep the two slices in locals instead
    // of allocating the `{ pathname, search }` pair returned by the public helper on every request.
    let pathname: string
    let search: string
    // Read the source's split ONCE. `urlParts` is an accessor on the Node request sources that
    // rescans the target and allocates a fresh pair every time it is touched, so testing it and then
    // reading each half through the accessor scanned the URL three times per request and threw two
    // of the three pairs away immediately.
    const parts = source.urlParts
    if (parts !== undefined) {
      pathname = parts.pathname
      search = parts.search
    } else {
      const rawUrl = source.url
      const schemeEnd = rawUrl.indexOf("://")
      const start = schemeEnd === -1 ? rawUrl.indexOf("/") : rawUrl.indexOf("/", schemeEnd + 3)
      if (start === -1) {
        pathname = "/"
        search = ""
      } else {
        let pathEnd = rawUrl.length
        let searchStart = -1
        let searchEnd = rawUrl.length
        for (let i = start; i < rawUrl.length; i++) {
          const c = rawUrl.charCodeAt(i)
          if (c === 63 /* ? */ && searchStart === -1) {
            pathEnd = i
            searchStart = i
          } else if (c === 35 /* # */) {
            if (searchStart === -1) pathEnd = i
            searchEnd = i
            break
          }
        }
        pathname = rawUrl.slice(start, pathEnd)
        search = searchStart === -1 ? "" : rawUrl.slice(searchStart, searchEnd)
      }
    }
    const match = this.catalog.find(source.method, pathname)
    if (!match.found) {
      if (match.reason === "method-not-allowed") {
        return wrapResponse(
          jsonError(405, "method_not_allowed", { Allow: match.allowed.join(", ") }),
        )
      }
      return wrapResponse(jsonError(404, "not_found"))
    }

    // Inspect only captured values for escapes. Scanning the full pathname repeated work the router
    // already did and made every plain dynamic route pay for unrelated static path bytes.
    const params = match.params === EMPTY_PARAMS ? match.params : decodeRouteParams(match.params)
    if (params === null) {
      return wrapResponse(jsonError(400, "malformed_path"))
    }

    return this.runMatched(
      source,
      platform,
      match.payload,
      params,
      search,
      finalize,
      wrapResponse,
      onTimeout,
      webFast,
    )
  }

  /** Run a route that has already been matched by the runtime or Nifra's portable router. */
  private runMatched<T>(
    source: RequestSource,
    platform: Platform | undefined,
    entry: RouteEntry,
    params: Record<string, string>,
    search: string | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
    webFast: boolean,
  ): MaybePromise<T> {
    // An idempotency route runs its dedupe lane first; on a fresh key it delegates to the normal lanes
    // (with the body buffered). All non-idempotent routes skip straight to the lanes - no added cost.
    // The runtime is always present when a route resolved idempotency (enforced at registration).
    if (entry.idempotent !== undefined && this.idempotencyRuntime !== undefined) {
      return this.idempotencyRuntime.run(
        entry.idempotent,
        requestOf(source),
        platform,
        entry,
        params,
        search,
        wrapResponse,
        {
          maxBodyBytes: this.maxBodyBytes,
          runLanes: (buffered, plat, ent, prm, srch) =>
            this.idempotencyRunLanes(buffered, plat, ent as RouteEntry, prm, srch),
        },
      )
    }
    return this.runMatchedLanes(
      source,
      platform,
      entry,
      params,
      search,
      finalize,
      wrapResponse,
      onTimeout,
      webFast,
    )
  }

  /** Supply request-specific deadline state to the route's precompiled execution plan. */
  private runMatchedLanes<T>(
    source: RequestSource,
    platform: Platform | undefined,
    entry: RouteEntry,
    params: Record<string, string>,
    search: string | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    onTimeout: () => T,
    webFast: boolean,
  ): MaybePromise<T> {
    // Translate the absolute wire deadline once, clamp it to local policy, then use the resulting
    // duration for both c.signal and c.budget. A client can only shorten work, never extend it.
    // Most requests have neither a local timeout nor a propagated deadline. Detect that case with
    // one header lookup and skip policy validation, wall-clock sampling, and admission objects. A
    // present wire deadline still goes through the full fail-closed parser/clamp below.
    const admission = !this.acceptInboundDeadlines
      ? this.requestTimeoutMs === 0
        ? undefined
        : {
            ok: true as const,
            inherited: false,
            timeoutMs: this.requestTimeoutMs,
            deadline: Math.floor(Date.now() + this.requestTimeoutMs),
          }
      : this.requestTimeoutMs === 0 && headerOf(source, NIFRA_DEADLINE_HEADER) === null
        ? undefined
        : admitDeadline(source.headers, this.deadlineAdmissionOptions)
    if (admission !== undefined && !admission.ok) {
      return wrapResponse(jsonError(admission.status, admission.reason))
    }
    const effectiveTimeoutMs = admission?.timeoutMs ?? 0

    // Only allocate a controller for a finite budget; the historical no-timeout path remains
    // allocation-light and exposes an unbounded budget that is never propagated on the wire.
    let controller: AbortController | undefined
    let signal = getNeverAbortSignal()
    if (effectiveTimeoutMs > 0) {
      controller = new AbortController()
      signal = controller.signal
    }
    const budget =
      controller === undefined
        ? getUnboundedRequestBudget()
        : createRequestBudget({ deadline: admission!.deadline as number, signal })
    const plan = entry.execution
    const nativeContext = controller === undefined
    const outcome: MaybePromise<T> =
      webFast && plan.fusedWeb !== undefined
        ? (plan.fusedWeb(
            source,
            params,
            search,
            signal,
            budget,
            platform,
            nativeContext,
          ) as MaybePromise<T>)
        : !webFast && plan.fusedBody !== undefined
          ? plan.fusedBody(
              source,
              params,
              search,
              signal,
              budget,
              platform,
              false,
              finalize,
              wrapResponse,
            )
          : plan.run(
              this,
              entry,
              source,
              params,
              search,
              signal,
              budget,
              platform,
              nativeContext,
              finalize,
              wrapResponse,
            )
    // The request timeout only bounds work that is actually pending - a synchronous (bare) result is
    // already complete and can't time out, so it's returned as-is (no 503 race, no promise).
    if (controller !== undefined && outcome instanceof Promise) {
      const timedOut =
        admission?.inherited === true
          ? () => wrapResponse(jsonError(504, "deadline_exceeded"))
          : onTimeout
      return this.withTimeout(
        outcome,
        controller,
        timedOut,
        Math.max(0, Math.ceil(budget.remaining())),
      )
    }
    return outcome
  }

  /** @internal Symbol-keyed install seam for the `effectLedger()` plugin. Off the public typed surface. */
  [INSTALL_EFFECT_LEDGER](runtime: EffectLedgerRuntime): void {
    this.assertConfigurable("effectLedger()")
    this.effectLedgerRuntime = runtime
  }

  /** The narrowest bare route: a syntactic `() => ...` handler cannot observe the context argument, so
   * successful requests can skip allocating `RequestContext`. Errors still allocate one for logging. */
  private runContextlessBare<T>(
    entry: RouteEntry,
    source: RequestSource,
    params: Record<string, string>,
    search: string | undefined,
    signal: AbortSignal,
    budget: RequestBudget,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    let result: unknown
    try {
      result = (entry.handler as unknown as ContextlessHandler)()
    } catch (err) {
      return this.contextlessBareError(
        err,
        source,
        params,
        search,
        signal,
        budget,
        platform,
        wrapResponse,
      )
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => finalize(value, EMPTY_RESPONSE_CONTROLS),
        (err) =>
          this.contextlessBareError(
            err,
            source,
            params,
            search,
            signal,
            budget,
            platform,
            wrapResponse,
          ),
      )
    }
    return finalize(result, EMPTY_RESPONSE_CONTROLS)
  }

  private contextlessBareError<T>(
    err: unknown,
    source: RequestSource,
    params: Record<string, string>,
    search: string | undefined,
    signal: AbortSignal,
    budget: RequestBudget,
    platform: Platform | undefined,
    wrapResponse: (response: Response) => T,
  ): T {
    if (err instanceof Response) return wrapResponse(err)
    const ctx = new RequestContext(
      source,
      params,
      search,
      signal,
      budget,
      platform,
      this.maxBodyBytes,
    )
    this.logRequestError(err, ctx)
    return wrapResponse(jsonError(500, "internal_error"))
  }

  /**
   * The synchronous fast path selected by a route's execution plan: apply static decorations, call the
   * handler, render the result - **no `await`** unless the handler itself returns a promise. It mirrors
   * the bare slice of {@link runLifecycle} (which a bare route would otherwise no-op through) and shares
   * {@link logRequestError}; a bare route has no `onError` hooks, so error handling is fully synchronous
   * (a thrown `Response` is control flow; anything else is a logged flat 500). This is where nifra skips
   * the per-request async-frame tax - the same win codegen routers get, but without `eval`.
   */
  private runBare<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    let result: unknown
    try {
      if (entry.hasDecorations) Object.assign(ctx, entry.decorations)
      result = entry.handler(ctx)
    } catch (err) {
      return this.bareError(err, ctx, wrapResponse)
    }
    if (result instanceof Promise) {
      // Async handler on an otherwise-bare route: finish on a microtask, with the same error handling.
      return result.then(
        (value) => finalize(value, responseSet(ctx)),
        (err) => this.bareError(err, ctx, wrapResponse),
      )
    }
    return finalize(result, responseSet(ctx))
  }

  /** Bare-route error rendering - identical to {@link runLifecycle}'s catch minus the (absent) onError
   * loop: a thrown `Response` is returned as deliberate control flow; anything else is logged + 500. */
  /**
   * Build a route's fused Web renderer. Composition happens once at
   * registration; the returned closure is what every request to the route runs. Behavior is
   * byte-identical to the generic `runBare`/`runContextlessBare` + `toResponse` pair - same
   * decoration order, same error routing (thrown `Response` = control flow; anything else logs and
   * 500s), same respond semantics (the lifecycle parity suite pins it).
   */
  private buildFusedWeb(
    handler: InternalHandler,
    decorations: Record<PropertyKey, unknown> | undefined,
    contextless: boolean,
  ): FusedWebRunner {
    // The fused lanes return to the runtime directly, so the framework's own error renders fold in
    // static headers here rather than through the shared `wrapResponse` seam.
    const logError = (err: unknown, ctx: RawContext): Response => {
      if (err instanceof Response) return this.wrapWebResponse(err)
      this.logRequestError(err, ctx)
      return this.wrapWebResponse(jsonError(500, "internal_error"))
    }
    if (contextless && decorations === undefined) {
      // `() => ...` can't observe the context - skip allocating one entirely (errors still build
      // one for the structured log, exactly like runContextlessBare).
      const contextlessHandler = handler as unknown as ContextlessHandler
      return (source, params, search, signal, budget, platform, nativeContext) => {
        let result: unknown
        try {
          result = contextlessHandler()
        } catch (err) {
          return logError(
            err,
            nativeContext
              ? RequestContext.native(source, params, search, this.maxBodyBytes, platform)
              : new RequestContext(
                  source,
                  params,
                  search,
                  signal,
                  budget,
                  platform,
                  this.maxBodyBytes,
                ),
          )
        }
        if (result instanceof Promise) {
          return result.then(
            (value) => fusedRespondNoSet(value, this.responseBodyTag, this.staticResponseHeaders),
            (err) =>
              logError(
                err,
                nativeContext
                  ? RequestContext.native(source, params, search, this.maxBodyBytes, platform)
                  : new RequestContext(
                      source,
                      params,
                      search,
                      signal,
                      budget,
                      platform,
                      this.maxBodyBytes,
                    ),
              ),
          )
        }
        return fusedRespondNoSet(result, this.responseBodyTag, this.staticResponseHeaders)
      }
    }
    return (source, params, search, signal, budget, platform, nativeContext) => {
      const ctx = nativeContext
        ? RequestContext.native(source, params, search, this.maxBodyBytes, platform)
        : new RequestContext(source, params, search, signal, budget, platform, this.maxBodyBytes)
      if (decorations !== undefined) Object.assign(ctx, decorations)
      let result: unknown
      try {
        result = handler(ctx)
      } catch (err) {
        return logError(err, ctx)
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => fusedRespond(value, ctx, this.responseBodyTag, this.staticResponseHeaders),
          (err) => logError(err, ctx),
        )
      }
      return fusedRespond(result, ctx, this.responseBodyTag, this.staticResponseHeaders)
    }
  }

  /** Compile the eligible body-only route's parser → validator → handler continuation once. The
   * bounded parser remains shared with the generic lane; only the route-invariant entry lookups and
   * lifecycle dispatch disappear from the common synchronous-validator/synchronous-handler case. */
  private buildFusedBodyRunner(
    handler: InternalHandler,
    bodySchema: StandardSchemaV1,
    decorations: Record<PropertyKey, unknown> | undefined,
  ): FusedBodyRunner {
    const logError = <T>(
      err: unknown,
      ctx: RawContext,
      wrapResponse: (response: Response) => T,
    ): T => this.bareError(err, ctx, wrapResponse)

    const runHandler = <T>(
      ctx: RawContext,
      finalize: (result: unknown, set: CtxSet, ctx: RawContext) => T,
      wrapResponse: (response: Response) => T,
    ): MaybePromise<T> => {
      if (decorations !== undefined) Object.assign(ctx, decorations)
      let output: MaybePromise<HandlerResult>
      try {
        output = handler(ctx)
      } catch (err) {
        return logError(err, ctx, wrapResponse)
      }
      if (output instanceof Promise) {
        return output.then(
          (result) => {
            try {
              return finalize(result, responseSet(ctx), ctx)
            } catch (err) {
              return logError(err, ctx, wrapResponse)
            }
          },
          (err) => logError(err, ctx, wrapResponse),
        )
      }
      try {
        return finalize(output, responseSet(ctx), ctx)
      } catch (err) {
        return logError(err, ctx, wrapResponse)
      }
    }

    const runValidated = <T>(
      result: StandardResult<unknown>,
      ctx: RawContext,
      finalize: (result: unknown, set: CtxSet, ctx: RawContext) => T,
      wrapResponse: (response: Response) => T,
    ): MaybePromise<T> => {
      if (result.issues !== undefined) return wrapResponse(validationError(result.issues))
      ctx.body = result.value
      return runHandler(ctx, finalize, wrapResponse)
    }

    const runParsed = <T>(
      parsed: unknown,
      ctx: RawContext,
      finalize: (result: unknown, set: CtxSet, ctx: RawContext) => T,
      wrapResponse: (response: Response) => T,
    ): MaybePromise<T> => {
      let validation: StandardResult<unknown> | Promise<StandardResult<unknown>>
      try {
        validation = bodySchema["~standard"].validate(parsed)
      } catch (err) {
        return logError(err, ctx, wrapResponse)
      }
      if (validation instanceof Promise) {
        return validation.then(
          (settled) => {
            try {
              return runValidated(settled, ctx, finalize, wrapResponse)
            } catch (err) {
              return logError(err, ctx, wrapResponse)
            }
          },
          (err) => logError(err, ctx, wrapResponse),
        )
      }
      try {
        return runValidated(validation, ctx, finalize, wrapResponse)
      } catch (err) {
        return logError(err, ctx, wrapResponse)
      }
    }

    return <T>(
      source: RequestSource,
      params: Record<string, string>,
      search: string | undefined,
      signal: AbortSignal,
      budget: RequestBudget,
      platform: Platform | undefined,
      nativeContext: boolean,
      finalize: (result: unknown, set: CtxSet, ctx: RawContext) => T,
      wrapResponse: (response: Response) => T,
    ): MaybePromise<T> => {
      const ctx = nativeContext
        ? RequestContext.native(source, params, search, this.maxBodyBytes, platform)
        : new RequestContext(source, params, search, signal, budget, platform, this.maxBodyBytes)
      const finish = (value: unknown): MaybePromise<T> =>
        runParsed(value, ctx, finalize, wrapResponse)
      return this.readBodyInput(source, finish, wrapResponse, (err) =>
        logError(err, ctx, wrapResponse),
      )
    }
  }

  /** Web adapter wrapper for the shared body runner. Node passes its native finalizer directly through
   * the execution plan, while Web needs the live context to preserve lazy `c.set` controls. */
  private buildFusedBodyWeb(body: FusedBodyRunner): FusedWebRunner {
    return (source, params, search, signal, budget, platform, nativeContext) =>
      body(
        source,
        params,
        search,
        signal,
        budget,
        platform,
        nativeContext,
        (result, _set, ctx) =>
          fusedRespond(result, ctx, this.responseBodyTag, this.staticResponseHeaders),
        this.wrapWebResponse,
      ) as MaybePromise<Response>
  }

  /** The fused Web lane for a route whose only lifecycle step is a query schema: parse + validate +
   * handler + respond in one closure, no lifecycle promise when the validator and handler are sync.
   * Eligibility is decided at registration (see `fusedQuery` in {@link register}); the semantics here
   * are exactly `runQueryOnly`'s for that eligible shape - invalid input returns
   * `validationError(issues)` (recovery hooks disqualify the route from this lane), a thrown
   * `Response` passes through, anything else logs and returns a flat 500, and an async validator
   * falls to a then-chain with the same steps. */
  private buildFusedQueryWeb(
    handler: InternalHandler,
    decorations: Record<PropertyKey, unknown> | undefined,
    querySchema: StandardSchemaV1,
  ): FusedWebRunner {
    // The fused lanes return to the runtime directly, so the framework's own error renders fold in
    // static headers here rather than through the shared `wrapResponse` seam.
    const logError = (err: unknown, ctx: RawContext): Response => {
      if (err instanceof Response) return this.wrapWebResponse(err)
      this.logRequestError(err, ctx)
      return this.wrapWebResponse(jsonError(500, "internal_error"))
    }
    const runHandler = (ctx: RawContext, value: unknown): MaybePromise<Response> => {
      ctx.query = value
      let result: unknown
      try {
        result = handler(ctx)
      } catch (err) {
        return logError(err, ctx)
      }
      if (result instanceof Promise) {
        return result.then(
          (settled) => fusedRespond(settled, ctx, this.responseBodyTag, this.staticResponseHeaders),
          (err) => logError(err, ctx),
        )
      }
      return fusedRespond(result, ctx, this.responseBodyTag, this.staticResponseHeaders)
    }
    return (source, params, search, signal, budget, platform, nativeContext) => {
      const ctx = nativeContext
        ? RequestContext.native(source, params, search, this.maxBodyBytes, platform)
        : new RequestContext(source, params, search, signal, budget, platform, this.maxBodyBytes)
      if (decorations !== undefined) Object.assign(ctx, decorations)
      let validation: MaybePromise<StandardResult<unknown>>
      try {
        validation = querySchema["~standard"].validate(queryObjectOf(ctx[CONTEXT_SEARCH]))
      } catch (err) {
        return logError(err, ctx)
      }
      if (validation instanceof Promise) {
        return validation.then(
          (settled) =>
            settled.issues !== undefined
              ? this.wrapWebResponse(validationError(settled.issues))
              : runHandler(ctx, settled.value),
          (err) => logError(err, ctx),
        )
      }
      if (validation.issues !== undefined)
        return this.wrapWebResponse(validationError(validation.issues))
      return runHandler(ctx, validation.value)
    }
  }

  private bareError<T>(err: unknown, ctx: RawContext, wrapResponse: (response: Response) => T): T {
    if (err instanceof Response) return wrapResponse(err)
    this.logRequestError(err, ctx)
    return wrapResponse(jsonError(500, "internal_error"))
  }

  private runWithAround<T>(
    entry: RouteEntry,
    ctx: RawContext,
    run: () => MaybePromise<T>,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    let outcome: MaybePromise<T>
    try {
      outcome = this.runAround(entry.around, ctx, run)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
    return outcome instanceof Promise
      ? outcome.catch((err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse))
      : outcome
  }

  private runAround<T>(
    hooks: ReadonlyArray<RawAround>,
    ctx: RawContext,
    run: () => MaybePromise<T>,
  ): MaybePromise<T> {
    const dispatch = (index: number): MaybePromise<T> => {
      if (index >= hooks.length) return run()
      const hook = hooks[index]!
      let called = false
      return hook(ctx, () => {
        if (called) throw new Error("around next() called multiple times")
        called = true
        return dispatch(index + 1)
      })
    }
    return dispatch(0)
  }

  private runBodyOnly<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): Promise<T> {
    return this.readBodyInput(
      source,
      (parsed) => this.finishBodyOnly(entry, parsed, ctx, finalize, wrapResponse),
      wrapResponse,
      (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
    )
  }

  /** Shared bounded body framing/parser. Both body lanes use the same trust-boundary checks; only
   * the validation + handler continuation differs. */
  private readBodyInput<T>(
    source: RequestSource,
    onParsed: (parsed: unknown) => MaybePromise<T>,
    wrapResponse: (response: Response) => T,
    onError: (err: unknown) => MaybePromise<T>,
  ): Promise<T> {
    const contentType = headerOf(source, "content-type") ?? ""
    if (contentType !== "application/json" && !contentType.includes("application/json")) {
      if (isUrlEncodedForm(contentType)) {
        return readBoundedForm(source, this.maxBodyBytes).then(
          (form) => (form instanceof Response ? wrapResponse(form) : onParsed(form)),
          onError,
        ) as Promise<T>
      }
      return Promise.resolve(wrapResponse(jsonError(415, "unsupported_media_type")))
    }

    // A framed, in-cap, non-chunked body can use native json() directly. Chunked or length-less
    // bodies use readBoundedJson, which enforces the streaming cap before parsing.
    const declared = headerOf(source, "content-length")
    if (declared !== null) {
      const length = parseContentLength(declared)
      if (length === undefined) {
        return Promise.resolve(wrapResponse(jsonError(400, "invalid_content_length")))
      }
      if (length > this.maxBodyBytes) {
        return Promise.resolve(wrapResponse(jsonError(413, "payload_too_large")))
      }
      if (headerOf(source, "transfer-encoding") === null) {
        return source.json().then(onParsed, () => wrapResponse(jsonError(400, "invalid_json")))
      }
    }

    try {
      return this.readBoundedJson(source).then(
        (parsed) => (parsed instanceof Response ? wrapResponse(parsed) : onParsed(parsed)),
        onError,
      )
    } catch (err) {
      return Promise.resolve(onError(err))
    }
  }

  /** Validate + run the handler for the bodyOnly path - shared by the inline fast path and the
   * streaming fallback. A method (not per-request closures) so the hot path allocates nothing
   * beyond the one `.then` continuation. */
  private finishBodyOnly<T>(
    entry: RouteEntry,
    parsed: unknown,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    try {
      const bodySchema = entry.schema!.body!
      const validation = bodySchema["~standard"].validate(parsed)
      if (validation instanceof Promise) {
        return validation.then(
          (result) => {
            try {
              const outcome = this.applyBodyValidation(entry, result, ctx, finalize, wrapResponse)
              return outcome instanceof Promise
                ? outcome.catch((err) =>
                    this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
                  )
                : outcome
            } catch (err) {
              return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
            }
          },
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      }
      const outcome = this.applyBodyValidation(entry, validation, ctx, finalize, wrapResponse)
      return outcome instanceof Promise
        ? outcome.catch((err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse))
        : outcome
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private executeHandler<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse?: (response: Response) => T,
  ): MaybePromise<T> {
    if (entry.hasDecorations) Object.assign(ctx, entry.decorations)
    const handlerOutput = entry.handler(ctx)
    if (handlerOutput instanceof Promise) {
      return handlerOutput.then(
        (value) => finalize(value, responseSet(ctx)),
        (err) => {
          if (wrapResponse) {
            return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
          }
          throw err
        },
      )
    }
    return finalize(handlerOutput, responseSet(ctx))
  }

  private handleValidationErrorRecovery<T>(
    entry: RouteEntry,
    recovery: unknown,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    originalIssues: ReadonlyArray<StandardIssue>,
    kind: "body" | "query",
  ): MaybePromise<T> {
    if (recovery !== undefined) {
      if (recovery instanceof Response) {
        return wrapResponse(recovery)
      }
      if (kind === "body" && entry.schema?.body) {
        const validation = entry.schema.body["~standard"].validate(recovery)
        if (validation instanceof Promise) {
          return validation.then((settled) => {
            if (settled.issues !== undefined) return wrapResponse(validationError(settled.issues))
            ctx.body = settled.value
            return this.executeHandler(entry, ctx, finalize)
          })
        }
        if (validation.issues !== undefined) return wrapResponse(validationError(validation.issues))
        ctx.body = validation.value
        return this.executeHandler(entry, ctx, finalize)
      }
      if (kind === "query" && entry.schema?.query) {
        const validation = entry.schema.query["~standard"].validate(recovery)
        if (validation instanceof Promise) {
          return validation.then(
            (settled) => {
              if (settled.issues !== undefined) return wrapResponse(validationError(settled.issues))
              ctx.query = settled.value
              return this.executeHandler(entry, ctx, finalize, wrapResponse)
            },
            (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
          )
        }
        if (validation.issues !== undefined) return wrapResponse(validationError(validation.issues))
        ctx.query = validation.value
        return this.executeHandler(entry, ctx, finalize, wrapResponse)
      }
    }
    return wrapResponse(validationError(originalIssues))
  }

  private applyBodyValidation<T>(
    entry: RouteEntry,
    result: StandardResult<unknown>,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    if (result.issues !== undefined) {
      const hook = entry.schema?.onValidationError ?? this.defaultOnValidationError
      if (hook) {
        const recovery = hook(result.issues, ctx as unknown as Context, "body")
        if (recovery instanceof Promise) {
          return recovery.then((rec) =>
            this.handleValidationErrorRecovery(
              entry,
              rec,
              ctx,
              finalize,
              wrapResponse,
              result.issues!,
              "body",
            ),
          )
        }
        return this.handleValidationErrorRecovery(
          entry,
          recovery,
          ctx,
          finalize,
          wrapResponse,
          result.issues,
          "body",
        )
      }
      return wrapResponse(validationError(result.issues))
    }
    ctx.body = result.value
    return this.executeHandler(entry, ctx, finalize)
  }

  private runQueryOnly<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    try {
      // Call the validator directly for the raw StandardResult (read `.issues`/`.value`) - skip
      // `validateStandard`'s per-request wrapper-object allocation, mirroring the bodyOnly path.
      const validation = entry.schema!.query!["~standard"].validate(
        queryObjectOf(ctx[CONTEXT_SEARCH]),
      )
      if (validation instanceof Promise) {
        return validation.then(
          (settled) => {
            try {
              const outcome = this.applyQueryValidation(entry, settled, ctx, finalize, wrapResponse)
              return outcome instanceof Promise
                ? outcome.catch((err) =>
                    this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
                  )
                : outcome
            } catch (err) {
              return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
            }
          },
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      }
      return this.applyQueryValidation(entry, validation, ctx, finalize, wrapResponse)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  /** Validate-result → set `ctx.query` → run handler. A method (not a per-request closure), the
   * query analogue of {@link applyBodyValidation}. */
  private applyQueryValidation<T>(
    entry: RouteEntry,
    result: StandardResult<unknown>,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    if (result.issues !== undefined) {
      const hook = entry.schema?.onValidationError ?? this.defaultOnValidationError
      if (hook) {
        const recovery = hook(result.issues, ctx as unknown as Context, "query")
        if (recovery instanceof Promise) {
          return recovery.then((rec) =>
            this.handleValidationErrorRecovery(
              entry,
              rec,
              ctx,
              finalize,
              wrapResponse,
              result.issues!,
              "query",
            ),
          )
        }
        return this.handleValidationErrorRecovery(
          entry,
          recovery,
          ctx,
          finalize,
          wrapResponse,
          result.issues,
          "query",
        )
      }
      return wrapResponse(validationError(result.issues))
    }
    ctx.query = result.value
    return this.executeHandler(entry, ctx, finalize, wrapResponse)
  }

  /**
   * Thread the response through each global `onResponse` hook. Stays SYNCHRONOUS until a hook
   * actually returns a Promise - an `async` version forced a promise + microtask on EVERY response
   * of any app with an onResponse hook (cors/securityHeaders/etag/timing all use onResponse), the
   * same ~13%/req tax the onRequest walk was de-async'd to avoid. The first async hook hands the
   * rest to {@link continueOnResponse}.
   */
  private applyOnResponse(response: Response, req: Request): MaybePromise<Response> {
    const hooks = this.onResponseHooks
    let current = response
    for (let i = 0; i < hooks.length; i++) {
      const next = (hooks[i] as RawOnResponse)(current, req)
      if (next instanceof Promise) {
        return next.then((settled) => this.continueOnResponse(settled, i + 1, req))
      }
      current = next
    }
    return current
  }

  private applyOnResponseAndFinalize(response: Response, req: Request): MaybePromise<Response> {
    try {
      const transformed = this.applyOnResponse(response, req)
      return transformed instanceof Promise
        ? transformed.then(
            (settled) => this.completeResponseFinalization({ response: settled }, req),
            (error) => this.failResponseFinalization(response, error, req),
          )
        : this.completeResponseFinalization({ response: transformed }, req)
    } catch (error) {
      return this.failResponseFinalization(response, error, req)
    }
  }

  private completeResponseFinalization(
    outcome: ResponseFinalization,
    req: Request,
  ): MaybePromise<Response> {
    const notified = this.notifyResponseFinalized(outcome, req)
    return notified instanceof Promise ? notified.then(() => outcome.response) : outcome.response
  }

  private failResponseFinalization(
    response: Response,
    error: unknown,
    req: Request,
  ): Promise<never> {
    const notified = this.notifyResponseFinalized({ response, error }, req)
    if (notified instanceof Promise) {
      return notified.then(() => {
        throw error
      })
    }
    // A hook failure must surface as a REJECTION even when every prior step ran synchronously:
    // `fetch()` may now resolve without a promise, but its failure contract stays promise-shaped -
    // a synchronous throw here would escape `Promise.resolve(app.fetch(...))` bridges and
    // `.then()`-style callers entirely instead of reaching their rejection handling.
    return Promise.reject(error)
  }

  /** Notify terminal observers in order while isolating both sync and async failures. */
  private notifyResponseFinalized(outcome: ResponseFinalization, req: Request): MaybePromise<void> {
    let pending: Promise<void> | undefined
    for (const hook of this.onResponseFinalizedHooks) {
      if (pending !== undefined) {
        pending = pending.then(async () => {
          try {
            await hook(outcome, req)
          } catch {
            // Terminal observation must never change request behavior.
          }
        })
        continue
      }
      try {
        const result = hook(outcome, req)
        if (result instanceof Promise) pending = result.catch(() => {})
      } catch {
        // Terminal observation must never change request behavior.
      }
    }
    return pending
  }

  /** Async tail of {@link applyOnResponse}: runs the remaining hooks once one has gone async. */
  private async continueOnResponse(
    response: Response,
    nextIndex: number,
    req: Request,
  ): Promise<Response> {
    let current = response
    for (let i = nextIndex; i < this.onResponseHooks.length; i++) {
      const next = (this.onResponseHooks[i] as RawOnResponse)(current, req)
      current = next instanceof Promise ? await next : next
    }
    return current
  }

  /**
   * Bound the response time. On timeout we abort `ctx.signal` (so cancellation-aware
   * handlers can bail) and return 503; the in-flight work keeps running but its
   * result is discarded - JS can't forcibly cancel a promise.
   */
  private async withTimeout<T>(
    work: Promise<T>,
    controller: AbortController,
    onTimeout: () => T,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(onTimeout())
      }, timeoutMs)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * The post-match lifecycle: validate → derive → beforeHandle → handler → afterHandle, with onError.
   * Generic over the render: a success value goes through `finalize(result, set)` (a Web `Response`, or
   * node-direct primitives); an early/error `Response` (validation, thrown, 500) through `wrapResponse`.
   */
  /** Synchronous until a validator, lifecycle hook, handler, or contract check actually returns a Promise. */
  private runLifecycle<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    try {
      const paramsSchema = entry.schema?.params
      if (paramsSchema !== undefined) {
        const validation = paramsSchema["~standard"].validate(ctx.params)
        if (validation instanceof Promise) {
          return validation.then(
            (result) =>
              this.runLifecycleAfterParamsResult(
                entry,
                source,
                ctx,
                finalize,
                wrapResponse,
                result,
              ),
            (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
          )
        }
        return this.runLifecycleAfterParamsResult(
          entry,
          source,
          ctx,
          finalize,
          wrapResponse,
          validation,
        )
      }
      // Registration already knows whether this route has body/params/query validation. Most real
      // read routes have no body or params schema, so skip the generic stage ladder and go straight to
      // query validation + lifecycle hooks. The fallback below remains the complete path for routes
      // with body/params combinations and validation recovery.
      if (entry.schema?.body === undefined) {
        return this.runQueryAndLifecycle(entry, ctx, finalize, wrapResponse)
      }
      return this.runLifecycleAfterParams(entry, source, ctx, finalize, wrapResponse, undefined)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  /** Registration-specialized query lifecycle: query validation (including recovery) → hooks. */
  private runLifecycleQuery<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    try {
      // The execution plan only selects this runner when the route has a query schema. Keeping the
      // non-null access here removes the per-request schema-presence branch from realistic GETs.
      const validation = entry.schema!.query!["~standard"].validate(
        queryObjectOf(ctx[CONTEXT_SEARCH]),
      )
      if (validation instanceof Promise) {
        return validation.then(
          (result) => {
            try {
              return this.runQueryAndLifecycleResult(entry, ctx, finalize, wrapResponse, result)
            } catch (err) {
              return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
            }
          },
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      }
      return this.runQueryAndLifecycleResult(entry, ctx, finalize, wrapResponse, validation)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  /** Registration-specialized body lifecycle: bounded body validation (including recovery) → hooks. */
  private runLifecycleBody<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    return this.readAndValidateBody(source, entry, ctx).then(
      (bodyError) =>
        bodyError === undefined
          ? this.runLifecycleHooks(entry, ctx, finalize, wrapResponse)
          : wrapResponse(bodyError),
      (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
    )
  }

  /** Registration-specialized body + query lifecycle: bounded body validation → query validation → hooks. */
  private runLifecycleBodyQuery<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    return this.readAndValidateBody(source, entry, ctx).then(
      (bodyError) =>
        bodyError === undefined
          ? this.runLifecycleQuery(entry, ctx, finalize, wrapResponse)
          : wrapResponse(bodyError),
      (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
    )
  }

  /** Registration-specialized no-body lifecycle: query validation (if present) → derives/hooks. */
  private runQueryAndLifecycle<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    const querySchema = entry.schema?.query
    return querySchema === undefined
      ? this.runLifecycleHooks(entry, ctx, finalize, wrapResponse)
      : this.runLifecycleQuery(entry, ctx, finalize, wrapResponse)
  }

  private runQueryAndLifecycleResult<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    result: StandardResult<unknown>,
  ): MaybePromise<T> {
    const queryError = this.applyLifecycleValidation(entry, result, ctx, "query")
    if (queryError instanceof Promise) {
      return queryError.then(
        (error) =>
          error === undefined
            ? this.runLifecycleHooks(entry, ctx, finalize, wrapResponse)
            : wrapResponse(error),
        (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
      )
    }
    if (queryError !== undefined) return wrapResponse(queryError)
    return this.runLifecycleHooks(entry, ctx, finalize, wrapResponse)
  }

  private runLifecycleAfterParamsResult<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    result: StandardResult<unknown>,
  ): MaybePromise<T> {
    try {
      return this.runLifecycleAfterParams(
        entry,
        source,
        ctx,
        finalize,
        wrapResponse,
        this.applyLifecycleValidation(entry, result, ctx, "params"),
      )
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private runLifecycleAfterParams<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    paramsError: MaybePromise<Response | undefined>,
  ): MaybePromise<T> {
    if (paramsError instanceof Promise) {
      return paramsError.then(
        (error) =>
          this.runLifecycleAfterParamsSettled(entry, source, ctx, finalize, wrapResponse, error),
        (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
      )
    }
    return this.runLifecycleAfterParamsSettled(
      entry,
      source,
      ctx,
      finalize,
      wrapResponse,
      paramsError,
    )
  }

  private runLifecycleAfterParamsSettled<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    paramsError: Response | undefined,
  ): MaybePromise<T> {
    if (paramsError !== undefined) return wrapResponse(paramsError)
    if (entry.schema?.body !== undefined) {
      return this.readAndValidateBody(source, entry, ctx).then(
        (bodyError) => this.runLifecycleAfterBody(entry, ctx, finalize, wrapResponse, bodyError),
        (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
      )
    }
    return this.runLifecycleAfterBody(entry, ctx, finalize, wrapResponse, undefined)
  }

  private runLifecycleAfterBody<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    bodyError: Response | undefined,
  ): MaybePromise<T> {
    if (bodyError !== undefined) return wrapResponse(bodyError)
    const querySchema = entry.schema?.query
    if (querySchema === undefined) return this.runLifecycleHooks(entry, ctx, finalize, wrapResponse)
    const validation = querySchema["~standard"].validate(queryObjectOf(ctx[CONTEXT_SEARCH]))
    if (validation instanceof Promise) {
      return validation.then(
        (result) => this.runLifecycleAfterQueryResult(entry, ctx, finalize, wrapResponse, result),
        (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
      )
    }
    return this.runLifecycleAfterQueryResult(entry, ctx, finalize, wrapResponse, validation)
  }

  private runLifecycleAfterQueryResult<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    result: StandardResult<unknown>,
  ): MaybePromise<T> {
    try {
      const queryError = this.applyLifecycleValidation(entry, result, ctx, "query")
      if (queryError instanceof Promise) {
        return queryError.then(
          (error) => this.runLifecycleAfterQuery(entry, ctx, finalize, wrapResponse, error),
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      }
      return this.runLifecycleAfterQuery(entry, ctx, finalize, wrapResponse, queryError)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private runLifecycleAfterQuery<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    queryError: Response | undefined,
  ): MaybePromise<T> {
    if (queryError !== undefined) return wrapResponse(queryError)
    return this.runLifecycleHooks(entry, ctx, finalize, wrapResponse)
  }

  private runLifecycleHooks<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    if (entry.lifecycleHookLane === "derive-before") {
      return this.runLifecycleDeriveBefore(entry, ctx, finalize, wrapResponse)
    }
    try {
      if (entry.hasDecorations) Object.assign(ctx, entry.decorations)
      for (let i = 0; i < entry.derives.length; i++) {
        const extension = entry.derives[i]!(ctx)
        if (extension instanceof Promise) {
          return this.continueLifecycleAfterDerive(entry, ctx, finalize, wrapResponse, i, extension)
        }
        Object.assign(ctx, extension)
      }
      for (let i = 0; i < entry.beforeHandle.length; i++) {
        const outcome = entry.beforeHandle[i]!(ctx)
        if (outcome instanceof Promise) {
          return this.continueLifecycleAfterBefore(entry, ctx, finalize, wrapResponse, i, outcome)
        }
        if (outcome !== undefined) return finalize(outcome, responseSet(ctx))
      }
      const result = entry.handler(ctx)
      if (result instanceof Promise) {
        return result.then(
          (value) => this.finishLifecycleResult(entry, ctx, finalize, wrapResponse, value),
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      }
      return this.finishLifecycleResult(entry, ctx, finalize, wrapResponse, result)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  /** Registration-specialized derive → before → handler lifecycle. */
  private runLifecycleDeriveBefore<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    try {
      const extension = entry.derives[0]!(ctx)
      if (extension instanceof Promise) {
        return this.continueLifecycleAfterDerive(entry, ctx, finalize, wrapResponse, 0, extension)
      }
      Object.assign(ctx, extension)

      const outcome = entry.beforeHandle[0]!(ctx)
      if (outcome instanceof Promise) {
        return this.continueLifecycleAfterBefore(entry, ctx, finalize, wrapResponse, 0, outcome)
      }
      if (outcome !== undefined)
        return this.finishSimpleLifecycleResult(entry, ctx, finalize, wrapResponse, outcome)

      const result = entry.handler(ctx)
      if (result instanceof Promise) {
        return result.then(
          (value) => this.finishSimpleLifecycleResult(entry, ctx, finalize, wrapResponse, value),
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      }
      return this.finishSimpleLifecycleResult(entry, ctx, finalize, wrapResponse, result)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  /** Finalize the specialized lane without rechecking its registration-proven invariants. */
  private finishSimpleLifecycleResult<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    result: unknown,
  ): MaybePromise<T> {
    try {
      return finalize(result, responseSet(ctx))
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private async continueLifecycleAfterDerive<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    firstIndex: number,
    first: Promise<unknown>,
  ): Promise<T> {
    try {
      Object.assign(ctx, await first)
      for (let i = firstIndex + 1; i < entry.derives.length; i++) {
        const extension = entry.derives[i]!(ctx)
        Object.assign(ctx, extension instanceof Promise ? await extension : extension)
      }
      return await this.runLifecycleHooksAsync(entry, ctx, finalize, wrapResponse)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private async runLifecycleHooksAsync<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): Promise<T> {
    try {
      for (const hook of entry.beforeHandle) {
        const outcome = hook(ctx)
        const early = outcome instanceof Promise ? await outcome : outcome
        if (early !== undefined) return finalize(early, responseSet(ctx))
      }
      return await this.runLifecycleHandlerAsync(entry, ctx, finalize, wrapResponse)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private async continueLifecycleAfterBefore<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    firstIndex: number,
    first: Promise<unknown>,
  ): Promise<T> {
    try {
      const firstOutcome = await first
      if (firstOutcome !== undefined) return finalize(firstOutcome, responseSet(ctx))
      for (let i = firstIndex + 1; i < entry.beforeHandle.length; i++) {
        const outcome = entry.beforeHandle[i]!(ctx)
        const early = outcome instanceof Promise ? await outcome : outcome
        if (early !== undefined) return finalize(early, responseSet(ctx))
      }
      return await this.runLifecycleHandlerAsync(entry, ctx, finalize, wrapResponse)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private async runLifecycleHandlerAsync<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): Promise<T> {
    try {
      const output = entry.handler(ctx)
      const result = output instanceof Promise ? await output : output
      return await this.finishLifecycleResult(entry, ctx, finalize, wrapResponse, result)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private finishLifecycleResult<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    initial: unknown,
  ): MaybePromise<T> {
    try {
      let result = initial
      for (let i = 0; i < entry.afterHandle.length; i++) {
        const transformed = entry.afterHandle[i]!(result, ctx)
        if (transformed instanceof Promise) {
          return this.continueLifecycleAfterHandle(
            entry,
            ctx,
            finalize,
            wrapResponse,
            i,
            transformed,
          )
        }
        result = transformed
      }
      return this.finishLifecycleContract(entry, ctx, finalize, wrapResponse, result)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private async continueLifecycleAfterHandle<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    firstIndex: number,
    first: Promise<unknown>,
  ): Promise<T> {
    try {
      let result = await first
      for (let i = firstIndex + 1; i < entry.afterHandle.length; i++) {
        const transformed = entry.afterHandle[i]!(result, ctx)
        result = transformed instanceof Promise ? await transformed : transformed
      }
      return await this.finishLifecycleContract(entry, ctx, finalize, wrapResponse, result)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private finishLifecycleContract<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    result: unknown,
  ): MaybePromise<T> {
    try {
      const contract = entry.responseContract
      if (contract === undefined) return finalize(result, responseSet(ctx))
      const checked = contract.runtime.check(contract.schema, result)
      if (checked instanceof Promise) {
        return checked.then(
          (outcome) => this.finishContractOutcome(ctx, finalize, wrapResponse, outcome),
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      }
      return this.finishContractOutcome(ctx, finalize, wrapResponse, checked)
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private finishContractOutcome<T>(
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
    outcome: {
      readonly kind: "ok" | "warn" | "violation"
      readonly value?: unknown
      readonly message?: string
    },
  ): T {
    if (outcome.kind === "violation") {
      this.logger.error("response contract violation", {
        method: ctx.req.method,
        path: pathnameOf(ctx.req.url),
        detail: outcome.message,
      })
      return wrapResponse(jsonError(500, "internal_error"))
    }
    if (outcome.kind === "warn") {
      this.logger.warn("response contract", {
        method: ctx.req.method,
        path: pathnameOf(ctx.req.url),
        detail: outcome.message,
      })
    }
    return finalize(outcome.value, responseSet(ctx))
  }

  private async handleLifecycleError<T>(
    entry: RouteEntry,
    err: unknown,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): Promise<T> {
    // A *thrown* Response is deliberate control flow, not an error - a guard throws a redirect/401,
    // an action throws an error page. Return it as-is (Remix/SvelteKit semantics); don't run onError
    // or log it as a 500. This is what makes `throw redirect(...)` / `requireSession(...)` work from
    // any handler or loader.
    if (err instanceof Response) return wrapResponse(err)
    // onError hooks may return a custom response; otherwise the default 500 stands.
    for (const hook of entry.onError) {
      const outcome = hook(err, ctx)
      const handled = outcome instanceof Promise ? await outcome : outcome
      if (handled !== undefined) return finalize(handled, responseSet(ctx))
    }
    // Never crash the server or leak internals. The client gets a flat 500; the detail goes to the
    // (redacting) logger. Body-read failures and around-hook failures land here too.
    this.logRequestError(err, ctx)
    return wrapResponse(jsonError(500, "internal_error"))
  }

  /** Log an unhandled request error to the (redacting) logger - shared by {@link runLifecycle} and the
   * bare fast path ({@link bareError}) so both record the same fields. Never throws; never leaks. */
  private logRequestError(err: unknown, ctx: RawContext): void {
    this.logger.error("unhandled request error", {
      method: ctx.req.method,
      path: pathnameOf(ctx.req.url),
      name: err instanceof Error ? err.name : "Error",
      // `detail`, not `message`: the logger uses `message` for its own first argument, so a field of
      // that name is silently overwritten and the thrown error's own text never reaches the sink. It
      // survived only incidentally inside `stack`, and was lost outright for a non-Error throw.
      detail: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  }

  private async readAndValidateBody(
    req: RequestSource,
    entry: RouteEntry,
    ctx: RawContext,
  ): Promise<Response | undefined> {
    const contentType = headerOf(req, "content-type") ?? ""
    let parsed: unknown
    if (contentType === "application/json" || contentType.includes("application/json")) {
      const json = await this.readBoundedJson(req)
      if (json instanceof Response) return json
      parsed = json
    } else if (isUrlEncodedForm(contentType)) {
      const form = await readBoundedForm(req, this.maxBodyBytes)
      if (form instanceof Response) return form
      parsed = form
    } else {
      // multipart/form-data (file uploads) stays 415 on the schema path by design - files don't
      // fit a value schema; use a schema-less route + @nifrajs/uploads helpers for those.
      return jsonError(415, "unsupported_media_type")
    }
    const validation = entry.schema!.body!["~standard"].validate(parsed)
    const result = validation instanceof Promise ? await validation : validation
    return this.applyLifecycleValidation(entry, result, ctx, "body")
  }

  /** Apply validation and its recovery hook on the generic lifecycle lane. Recovery is completed
   * before derives/beforeHandle run, matching the body-only and query-only execution lanes. */
  private applyLifecycleValidation(
    entry: RouteEntry,
    result: StandardResult<unknown>,
    ctx: RawContext,
    kind: "body" | "query" | "params",
  ): MaybePromise<Response | undefined> {
    const assign = (value: unknown): void => {
      if (kind === "body") ctx.body = value
      else if (kind === "query") ctx.query = value
      else ctx.params = value as Record<string, string>
    }
    if (result.issues === undefined) {
      assign(result.value)
      return undefined
    }
    const hook = entry.schema?.onValidationError ?? this.defaultOnValidationError
    if (hook === undefined) return validationError(result.issues)
    const attempted = hook(result.issues, ctx as unknown as Context, kind)
    if (attempted instanceof Promise) {
      return attempted.then((recovery) =>
        this.finishLifecycleValidationRecovery(entry, kind, result.issues!, recovery, assign),
      )
    }
    return this.finishLifecycleValidationRecovery(entry, kind, result.issues, attempted, assign)
  }

  private finishLifecycleValidationRecovery(
    entry: RouteEntry,
    kind: "body" | "query" | "params",
    issues: ReadonlyArray<StandardIssue>,
    recovery: unknown,
    assign: (value: unknown) => void,
  ): MaybePromise<Response | undefined> {
    if (recovery === undefined) return validationError(issues)
    if (recovery instanceof Response) return recovery
    const schema =
      kind === "body"
        ? entry.schema?.body
        : kind === "query"
          ? entry.schema?.query
          : entry.schema?.params
    const retried = schema!["~standard"].validate(recovery)
    if (retried instanceof Promise) {
      return retried.then((settled) => {
        if (settled.issues !== undefined) return validationError(settled.issues)
        assign(settled.value)
        return undefined
      })
    }
    if (retried.issues !== undefined) return validationError(retried.issues)
    assign(retried.value)
    return undefined
  }

  /**
   * Read the body as text, capped at `maxBodyBytes`. Rejects (`null`) on a
   * `Content-Length` over the cap *before* buffering, and aborts mid-stream once the
   * running byte count exceeds it - so a lying or absent length can't force us to
   * buffer an oversized payload.
   *
   * Fast path: when a non-chunked request carries a `Content-Length` within the cap,
   * a native `req.json()` is already bounded - under HTTP/1.1 + HTTP/2 framing the
   * runtime delivers at most `Content-Length` bytes - so we skip the manual stream
   * loop and a separate text decode. It trusts the wire
   * *framing*, not the header value: nifra only ever receives framed Requests from the
   * runtime's HTTP server, never a hand-built one with a mismatched length. Chunked or
   * length-less bodies fall through to the streaming byte-cap guard below.
   */
  private async readBoundedJson(req: RequestSource): Promise<unknown | Response> {
    return readBoundedJsonSource(req, this.maxBodyBytes)
  }

  /** Adapt one route's compiled execution plan to Bun's already-matched request shape. Route
   * semantics remain in the plan; this closure only supplies native params and deadline fallback. */
  private compileBunNativeHandler(
    entry: RouteEntry,
    paramNames: readonly string[],
    fused: FusedWebRunner | undefined,
    signal: AbortSignal | undefined,
    budget: RequestBudget | undefined,
  ): BunNativeHandler {
    if (paramNames.length === 0) {
      if (fused === undefined) {
        return (request) => this.fetchMatched(request, entry, EMPTY_PARAMS)
      }
      if (this.acceptInboundDeadlines) {
        return (request) =>
          request.headers.get(NIFRA_DEADLINE_HEADER) !== null
            ? this.fetchMatched(request, entry, EMPTY_PARAMS)
            : fused(request, EMPTY_PARAMS, undefined, signal!, budget!, undefined, true)
      }
      return (request) => fused(request, EMPTY_PARAMS, undefined, signal!, budget!, undefined, true)
    }

    const malformed =
      paramNames.length === 1
        ? (params: Record<string, string>) => params[paramNames[0]!]?.includes("\uFFFD") === true
        : hasReplacementParam
    if (fused === undefined) {
      return (request) => {
        const params = (request as BunRequestWithParams).params ?? EMPTY_PARAMS
        if (malformed(params)) return this.fetchSource(request)
        return this.fetchMatched(request, entry, params)
      }
    }
    if (this.acceptInboundDeadlines) {
      return (request) => {
        const params = (request as BunRequestWithParams).params ?? EMPTY_PARAMS
        if (malformed(params)) return this.fetchSource(request)
        return request.headers.get(NIFRA_DEADLINE_HEADER) !== null
          ? this.fetchMatched(request, entry, params)
          : fused(request, params, undefined, signal!, budget!, undefined, true)
      }
    }
    return (request) => {
      const params = (request as BunRequestWithParams).params ?? EMPTY_PARAMS
      if (malformed(params)) return this.fetchSource(request)
      return fused(request, params, undefined, signal!, budget!, undefined, true)
    }
  }

  /** Compile portable route registrations into Bun's native route table. Apps with request-rewrite
   * hooks or WebSockets retain the single portable dispatcher because those features must run before
   * route selection/upgrade. Named wildcards also stay on the fallback until Bun exposes their raw
   * capture semantics; static and `:param` routes take the native lane. */
  private buildBunNativeRoutes(): BunNativeRoutes | undefined {
    // A `clientIp` trust declaration must run the resolver in `dispatch`, which the fused native lane
    // bypasses - so an app that declares trust routes through the fetch lane (where `c.clientIp`
    // resolves) instead of Bun's native table. The allocation-free default keeps native fusion.
    if (
      this.onRequestHooks.length > 0 ||
      this.wsRouteCount > 0 ||
      this.clientIpTrust !== undefined
    ) {
      return undefined
    }

    const routes: BunNativeRoutes = Object.create(null) as BunNativeRoutes
    const mayUseFusedNative =
      this.requestTimeoutMs === 0 &&
      this.onResponseHooks.length === 0 &&
      this.onResponseFinalizedHooks.length === 0 &&
      // The capacity gate must wrap every request; the fused lane bypasses fetchMatched, so enabling
      // admission drops fusion (native matching stays) and routes through the gated matched lane.
      this.capacityGate === undefined
    const unboundedSignal = mayUseFusedNative ? getNeverAbortSignal() : undefined
    const unboundedBudget = mayUseFusedNative ? getUnboundedRequestBudget() : undefined
    let count = 0
    for (const { method, path, pattern, entry } of this.catalog.entries()) {
      if (pattern.segments.some((segment) => segment.kind === "wildcard")) continue
      let methods = routes[path]
      if (methods === undefined) {
        methods = Object.create(null) as BunNativeMethodTable
        routes[path] = methods
      }
      const paramNames = pattern.paramNames
      const fused = mayUseFusedNative ? entry.execution.fusedWeb : undefined
      methods[method] = this.compileBunNativeHandler(
        entry,
        paramNames,
        fused,
        unboundedSignal,
        unboundedBudget,
      )
      count += 1
    }
    return count === 0 ? undefined : routes
  }

  /**
   * Start a `Bun.serve` instance bound to `port` (use `0` for an ephemeral port).
   *
   * `reusePort` sets `SO_REUSEPORT` so **multiple processes can bind the same port** and the kernel
   * load-balances connections across them - the standard way to use every core (Bun is
   * single-threaded per process). Spawn one process per core, each calling
   * `app.listen(PORT, { reusePort: true })`; see `examples/cluster.ts`. Every process must opt in,
   * and all of them must be the same app. Linux balances ~evenly; macOS accepts the flag but may
   * favor one socket (fine for dev, measure on Linux for production numbers).
   *
   * `hostname` is the bind address, defaulting to Bun's `0.0.0.0` (every interface). Pass
   * `"127.0.0.1"` to bind loopback only - an admin surface, a sidecar, or anything that must not be
   * reachable off the box. Omitting it when you meant to restrict is a real exposure, so it is a
   * first-class option rather than something a caller has to drop down to `Bun.serve` for.
   */
  listen(
    port: number,
    options?: { readonly reusePort?: boolean; readonly hostname?: string },
  ): RunningServer {
    if (typeof Bun === "undefined") {
      // listen() is the one Bun-specific seam. Off Bun, fail loud + actionable rather
      // than letting the Bun.serve call below throw a bare `ReferenceError: Bun is not
      // defined`. Exercised by the @nifrajs/deno suite (which runs on a non-Bun runtime).
      throw new FrameworkError(
        "BUN_REQUIRED",
        "listen() uses Bun.serve and runs only on Bun. Serve on Node with @nifrajs/node or on Deno with @nifrajs/deno, or hand app.fetch to any fetch-compatible runtime (Workers, etc.).",
      )
    }
    // Bun's `Server` is the concrete handle; we expose the stable `RunningServer`
    // subset so the public types don't depend on the ambient `Bun` global. The cast
    // bridges them - Bun's `.port` is `number | undefined` (undefined only for unix
    // sockets, never a TCP `listen`) and its `.stop` returns a promise we don't await.
    // Pass only the request - Bun's `fetch` 2nd arg is the Bun `Server`, not our `platform`.
    // With WS routes, hand Bun a `websocket` config + a fetch that upgrades matching requests (the
    // `server` 2nd arg is how Bun exposes `upgrade`); otherwise the lean request-only fetch. The
    // `websocket` handlers are one shared dispatcher - each connection's `ws.data.handler` is the
    // matched route's handler, set by `server.upgrade`.
    // With WS routes, the dispatcher comes from the installed `.use(websocket())` runtime - non-null
    // because wsRouteCount > 0 means ws() ran, and ws() requires the runtime at registration.
    const wsHandlers =
      this.wsRouteCount === 0
        ? undefined
        : (this.wsRuntime as WsRuntime).bunHandlers(this.topics as TopicRegistry)
    const reusePort = options?.reusePort === true
    // Spread rather than pass `hostname: undefined` - Bun treats an explicit undefined as a value
    // on some option paths, and omitting is what selects its 0.0.0.0 default.
    const bind = options?.hostname === undefined ? {} : { hostname: options.hostname }
    const nativeRoutes = wsHandlers === undefined ? this.buildBunNativeRoutes() : undefined
    const running = (wsHandlers === undefined
      ? Bun.serve({
          port,
          reusePort,
          ...bind,
          ...(nativeRoutes === undefined ? {} : { routes: nativeRoutes }),
          fetch: (req: Request, server) =>
            this.fetch(req, bunPeerPlatform(server, req) as Platform<EnvOf<Ctx>>),
        })
      : Bun.serve<BunWsData>({
          port,
          reusePort,
          ...bind,
          fetch: (req, server) => this.bunFetchWithWebSocket(req, server),
          // Bun's `ServerWebSocket<BunWsData>` is runtime-compatible with the handlers' structural
          // `BunSocket` view (kept local so `Bun.*` types never leak into the published .d.ts); the
          // `unknown` params bridge a TS structural-variance quirk. Round-trip covered by websocket.test.ts.
          websocket: {
            // Cap inbound frames so a huge message can't be buffered/JSON-parsed into memory; the runtime
            // closes an over-cap connection before the handler runs. Default 1 MB (maxBodyBytes).
            maxPayloadLength: this.wsMaxPayloadBytes,
            open: (ws) => wsHandlers.open(ws),
            message: (ws, message) => wsHandlers.message(ws, message),
            close: (ws, code, reason) => wsHandlers.close(ws, code, reason),
          },
        })) as unknown as RunningServer
    this.bunServer = running
    this.sealed = true
    if (this.gracefulSignals) this.installSignalHandlers()
    return running
  }

  /**
   * Gracefully stop: wait for in-flight requests to finish (up to `drainMs`), then
   * issue a single terminal stop - graceful if everything drained, forced if
   * stragglers remain. Safe to call when not listening.
   *
   * The Bun semantics: poll `pendingRequests` (awaiting
   * `stop()`'s promise drops in-flight requests), and decide graceful-vs-forced in
   * ONE call (Bun can't escalate an already-graceful `stop()` to a forced close).
   * New connections may be accepted during the drain window; in a real deploy the
   * load balancer has already stopped routing here, and `drainMs` bounds it.
   */
  async stop({ drainMs = DEFAULT_DRAIN_MS }: { drainMs?: number } = {}): Promise<void> {
    const server = this.bunServer
    if (server === undefined) return
    this.bunServer = undefined
    const deadline = Date.now() + drainMs
    while (server.pendingRequests > 0 && Date.now() < deadline) {
      await Bun.sleep(DRAIN_POLL_MS)
    }
    server.stop(server.pendingRequests > 0) // force-close iff stragglers remain past the deadline
  }

  private installSignalHandlers(): void {
    // Drain, then let the process exit naturally - the stopped server no longer
    // holds the event loop open. Opt-in (`gracefulSignals`), so taking over the
    // signals is consented; we don't force `process.exit`.
    const onSignal = (): void => {
      void this.stop()
    }
    process.once("SIGTERM", onSignal)
    process.once("SIGINT", onSignal)
  }
}

/**
 * Create a new {@link Server}. Pass an `Env` to type the platform bindings - `server<Env>()` makes
 * `c.env: Env` in every handler + middleware, and types the `env` argument of `app.fetch` /
 * `toFetchHandler`. Omit it and `c.env` is `unknown` (validate/cast before use).
 */
export function server<Env = unknown>(
  options?: ServerOptions,
): Server<EmptyRegistry, { readonly env: Env }> {
  // `Env` is a phantom type-level marker: the runtime `env` arrives via `app.fetch(req, { env })` at
  // request time, not stored on the builder - so seed the context type with a cast (as `derive`/
  // `decorate` do for their `Ctx` extensions).
  return new Server(options) as unknown as Server<EmptyRegistry, { readonly env: Env }>
}
