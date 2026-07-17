import {
  admitDeadline,
  createRequestBudget,
  createUnboundedRequestBudget,
  type DeadlineAdmissionOptions,
  NIFRA_DEADLINE_HEADER,
  type RequestBudget,
} from "../budget.ts"
import { FrameworkError, RouteConfigError } from "../errors.ts"
import {
  CAPABILITY_GUARD,
  type CapabilityUseEvent,
  createCapabilityGuard,
  normalizeRouteCapabilities,
} from "../internal/capability-runtime.ts"
import {
  type AssuranceDeclaration,
  assuranceDeclarationsOf,
  assuranceEvidenceFor,
  NIFRA_ASSURANCE_IDS,
  validEvidenceId,
} from "../internal/route-assurance.ts"
import type { RequestLedger } from "../ledger.ts"
import {
  type CompiledRoutePattern,
  compileRoutePattern,
  decodeRouteParams,
} from "../router/pattern.ts"
import { EMPTY_PARAMS, type Method, Router, type RouterMatch } from "../router/router.ts"
import type {
  InferOutput,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
} from "../schema/standard.ts"
import { parseContentLength } from "./body.ts"
import { type ClientIpTrust, resolveClientIp } from "./client-ip.ts"
import type { Context, Platform, ResponseControls, RouteSchema } from "./context.ts"
import { jsonError, pathnameOf, urlPartsOf } from "./http.ts"
import type { NodeServeOutcome } from "./node-outcome.ts"
import type { NodeOutcomeRuntime } from "./node-outcome-hook.ts"
import {
  isUrlEncodedForm,
  type QueryValue,
  queryObjectOf,
  readBoundedForm,
  searchOf,
} from "./query.ts"
import { RequestContext, readBoundedJsonSource } from "./request-context.ts"
import { fusedRespond, fusedRespondNoSet, toResponse } from "./respond.ts"
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

// NodeServeOutcome (the nifra<->node bridge render form) now lives in `./node-outcome.ts`; re-exported
// so existing importers keep resolving it from the server module.
export type { NodeServeOutcome }

import type { IdempotencyRuntime, ResolvedIdempotency } from "./idempotency-lane.ts"
import {
  INSTALL_EFFECT_LEDGER,
  INSTALL_IDEMPOTENCY,
  INSTALL_MCP,
  INSTALL_NODE_DIRECT,
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
  StandardWebSocket,
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
 * their `Request` **directly** (zero wrapper allocation on the hot path — `request` is simply absent and
 * {@link requestOf} returns the source itself). Node's adapter passes a *lazy* source whose `request`
 * getter builds an undici `Request` only when user code reads `c.req`, an onRequest/onResponse hook
 * needs it, or a body helper consumes it — so the common Node request never pays for a `Request` build.
 */
export interface RequestSource {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  header?(name: string): string | null
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

type InternalHandler = (ctx: RawContext) => MaybePromise<HandlerResult>

/** Broad shape so the implementation signature is compatible with both typed overloads. */
type ErasedHandler = (ctx: never) => MaybePromise<HandlerResult>

/** A `derive` computes per-request context extensions; stored path-erased. */
type RawDerive = (ctx: RawContext) => MaybePromise<object>
type RawBeforeHandle = (ctx: RawContext) => MaybePromise<unknown>
type RawAfterHandle = (result: unknown, ctx: RawContext) => MaybePromise<unknown>
type RawErrorHandler = (error: unknown, ctx: RawContext) => MaybePromise<unknown>
type RawAround = <T>(ctx: RawContext, next: () => MaybePromise<T>) => MaybePromise<T>
export type OnRequestResult = Response | Request | undefined
type RawOnRequest = (req: Request, platform?: Platform) => MaybePromise<OnRequestResult>
type RawOnResponse = (response: Response, req: Request) => MaybePromise<Response>
type RawOnResponseFinalized = (outcome: ResponseFinalization, req: Request) => MaybePromise<void>

type RouteExecutionRunner = <T, R extends Registry, Ctx>(
  runtime: Server<R, Ctx>,
  entry: RouteEntry,
  source: RequestSource,
  params: Record<string, string>,
  search: string | undefined,
  signal: AbortSignal,
  budget: RequestBudget,
  platform: Platform | undefined,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response) => T,
) => MaybePromise<T>

type ContextRouteRunner = <T, R extends Registry, Ctx>(
  runtime: Server<R, Ctx>,
  entry: RouteEntry,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response) => T,
) => MaybePromise<T>

/** Registration-compiled route behavior. Every adapter invokes the same runner; the optional fused
 * renderer is only a response-format specialization of that same selected route semantics. */
interface RouteExecutionPlan {
  readonly run: RouteExecutionRunner
  readonly fusedWeb: FusedWebRunner | undefined
}

interface RouteEntry {
  readonly handler: InternalHandler
  readonly schema: RouteSchema | undefined
  /** Resolved idempotency config; `undefined` = off (the dedupe lane is never entered). */
  readonly idempotent: ResolvedIdempotency | undefined
  /** Resolved effect-ledger wiring; `undefined` = off (no per-request ledger, no settle step). */
  readonly ledgered: ResolvedEffectLedger | undefined
  /** Per-request context extensions captured at registration (order-scoped). */
  readonly derives: ReadonlyArray<RawDerive>
  /** Static context extensions captured at registration. */
  readonly decorations: Record<PropertyKey, unknown>
  /** Whether {@link decorations} has any keys — precomputed so the hot path skips a no-op
   * `Object.assign` on the (common) no-decoration route. */
  readonly hasDecorations: boolean
  /** Lifecycle hooks captured at registration (order-scoped). */
  readonly beforeHandle: ReadonlyArray<RawBeforeHandle>
  readonly afterHandle: ReadonlyArray<RawAfterHandle>
  readonly onError: ReadonlyArray<RawErrorHandler>
  /** Wraps the matched route lifecycle. Empty for the common no-around path. */
  readonly around: ReadonlyArray<RawAround>
  /** The single immutable execution decision consumed by portable, Node-direct, and Bun-native paths. */
  readonly execution: RouteExecutionPlan
}

/** One canonical runtime route fact. The catalog owns matching, reflection, assurance, tool metadata,
 * replay, and native compilation input so batch registration has one commit point. */
interface CatalogRoute {
  readonly method: Method
  readonly path: string
  readonly pattern: CompiledRoutePattern
  readonly entry: RouteEntry
  readonly descriptor: RouteDescriptor
  readonly assurance: readonly AssuranceDeclaration[]
}

/**
 * Runtime route catalog. Single-route registration mutates directly; multi-route registration replays
 * the existing catalog plus the candidate batch into a staged router, then swaps the complete state only
 * after every route validates. Failed `implement()`/`merge()` batches therefore leave matching and
 * reflection unchanged.
 */
class RouteCatalog {
  private matcher = new Router<RouteEntry>()
  private records: CatalogRoute[] = []
  /** Allocation-free reflection view for the common no-assurance case. Derived only at commit time. */
  private descriptors: RouteDescriptor[] = []
  private assurancePresent = false

  add(route: CatalogRoute): void {
    this.matcher.add(route.method, route.pattern, route.entry)
    this.records.push(route)
    this.descriptors.push(route.descriptor)
    if (route.assurance.length > 0) this.assurancePresent = true
  }

  addBatch(routes: readonly CatalogRoute[]): void {
    if (routes.length === 0) return
    const nextRecords = this.records.concat(routes)
    const nextDescriptors = this.descriptors.concat(routes.map(({ descriptor }) => descriptor))
    const nextAssurancePresent =
      this.assurancePresent || routes.some((route) => route.assurance.length > 0)
    const staged = new Router<RouteEntry>()
    for (const route of this.records) staged.add(route.method, route.pattern, route.entry)
    for (const route of routes) staged.add(route.method, route.pattern, route.entry)
    this.matcher = staged
    this.records = nextRecords
    this.descriptors = nextDescriptors
    this.assurancePresent = nextAssurancePresent
  }

  find(method: string, path: string): RouterMatch<RouteEntry> {
    return this.matcher.find(method, path)
  }

  entries(): readonly CatalogRoute[] {
    return this.records
  }

  routeDescriptors(): ReadonlyArray<RouteDescriptor> {
    return this.descriptors
  }

  lastDescriptor(): RouteDescriptor | undefined {
    return this.records[this.records.length - 1]?.descriptor
  }

  hasAssurance(): boolean {
    return this.assurancePresent
  }
}

/** The fused Web lane: same inputs `routeAndRun` would hand the generic path, a `Response` out. */
type FusedWebRunner = (
  source: RequestSource,
  params: Record<string, string>,
  search: string | undefined,
  signal: AbortSignal,
  budget: RequestBudget,
  platform: Platform | undefined,
  nativeContext: boolean,
) => MaybePromise<Response>

/** A registered WebSocket route — just its handler; matching reuses {@link Router} under the GET verb. */
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
): Platform | undefined {
  const address = server.requestIP(req)?.address
  return address === undefined ? undefined : { clientIp: address }
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
 * constrained to the contract's type (or a raw `Response`) — so the implementation can't drift from the
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

/** Same-origin check for a WebSocket handshake (CSWSH default): the `Origin`'s host[:port] must equal the
 * request's own host (from `req.url`, which the runtime builds from the `Host` header). Scheme differs
 * (ws↔http), so compare host only. An unparseable Origin is treated as NOT same-origin (rejected). */
function wsSameOrigin(origin: string, req: Request): boolean {
  try {
    return new URL(origin).host === new URL(req.url).host
  } catch {
    return false
  }
}

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
  /** Accumulated `Set-Cookie` values — a list, since a `Record` would collapse multiple cookies. */
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
   * Created by the first `app.ws()` via the `@nifrajs/core/ws` runtime — `undefined` until then, so a
   * no-WebSocket app never constructs (or bundles) it. */
  private topics: TopicRegistry | undefined
  private readonly maxBodyBytes: number
  private readonly wsMaxPayloadBytes: number
  private readonly requestTimeoutMs: number
  /** Opt-in caller-IP trust declaration; `undefined` = socket peer only, no forwarded header believed. */
  private readonly clientIpTrust: ClientIpTrust | undefined
  private readonly acceptInboundDeadlines: boolean
  private readonly maxInboundDeadlineMs: number
  private readonly deadlineAdmissionOptions: DeadlineAdmissionOptions
  private readonly gracefulSignals: boolean
  /** Capacity-admission gate; `undefined` = off (the request path pays nothing). */
  private readonly capacityGate: AdmissionController | undefined
  private readonly onCapabilityUse: ((event: CapabilityUseEvent) => void) | undefined
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
  private readonly onResponseHooks: RawOnResponse[]
  private readonly onResponseFinalizedHooks: RawOnResponseFinalized[]
  private readonly responseRequests: WeakMap<Request, Request>
  /** Names of plugins/middleware already applied via `use` — for idempotent dedupe. */
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
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.wsMaxPayloadBytes = options.wsMaxPayloadBytes ?? this.maxBodyBytes
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
    // The effect-ledger runtime is installed by `.use(effectLedger())`; a bare app never imports it, so
    // the ledger machinery tree-shakes out. Capability-declaring routes simply carry no ledger without it.
    this.effectLedgerRuntime = undefined
    // The idempotency runtime is installed by `.use(idempotency())`; a bare app never imports it, so the
    // dedupe machinery tree-shakes out. A route that declares idempotency without it is a build error.
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
    this.onResponseHooks = []
    this.onResponseFinalizedHooks = []
    this.responseRequests = new WeakMap()
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

  /** Transform every outgoing response — success, error, 404, 405, short-circuit. Global. */
  onResponse(fn: (response: Response, req: Request) => MaybePromise<Response>): this {
    this.assertConfigurable("onResponse()")
    this.onResponseHooks.push(fn)
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
   * Apply a type-**identity** plugin ({@link IdentityPlugin}, from {@link defineIdentityPlugin}) — it
   * registers routes/hooks but doesn't change the types, so this returns `this` with the route registry
   * and context fully intact. This overload exists specifically so a *named* identity plugin (e.g.
   * `@nifrajs/better-auth`) threads the registry: its `& { pluginName }` intersection would otherwise
   * defeat the generic inference of the transforming overload below and collapse the result to `any`.
   */
  use(plugin: IdentityPlugin): this
  /**
   * Apply a **plugin function** — `(app) => app`, typically built with {@link definePlugin}. It's
   * called with `this` and its result is returned, so an inline plugin's `derive`/`decorate` thread
   * the added context to handlers defined after `use` (the overload is generic over the concrete
   * `this`). A named plugin already applied is skipped (idempotent dedupe).
   */
  use<Out extends AnyServer>(plugin: (app: this) => Out): Out
  /**
   * Apply a {@link Middleware} bundle — wire each hook it provides to its lifecycle point. Returns
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
    if (arg.onRequest !== undefined) this.onRequest(arg.onRequest)
    if (arg.around !== undefined) this.around(arg.around)
    if (arg.beforeHandle !== undefined) this.beforeHandle(arg.beforeHandle)
    if (arg.afterHandle !== undefined) this.afterHandle(arg.afterHandle)
    if (arg.onResponse !== undefined) this.onResponse(arg.onResponse)
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
   * Register a **typed SSE route** — a GET endpoint streaming `text/event-stream` whose event
   * payloads are contracted by `schema.sse`. The handler receives the validated context plus a
   * {@link TypedSSEStream}: `stream.send(event)` is compile-time-checked against the schema and
   * JSON-serialized into the SSE `data:` field. The typed client sees the marker and grows a
   * `.subscribe(onEvent)` for the route with the same payload type — end-to-end typed streaming.
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
    // introspection field), so write it through a narrow mutable view — not `any`.
    const lastRoute = this.catalog.lastDescriptor()
    if (lastRoute) {
      ;(lastRoute as { tool?: RouteDescriptor["tool"] }).tool = plan.descriptor
    }
    return this as unknown as Server<Registry, Ctx>
  }

  /**
   * Declare an MCP **resource** — read-only data an agent can fetch through `nifra mcp` (app config, a
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
   * Declare an MCP **prompt** — a reusable prompt template an agent can fetch through `nifra mcp`.
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

  /** The MCP resources declared via {@link resource} — enumerated by `nifra mcp`. */
  mcpResources(): readonly McpResourceDescriptor[] {
    return this.mcpResourceList
  }

  /** The MCP prompts declared via {@link prompt} — enumerated by `nifra mcp`. */
  mcpPrompts(): readonly McpPromptDescriptor[] {
    return this.mcpPromptList
  }

  /**
   * Register a **WebSocket** route. The connection upgrades on a `GET` to `path` carrying
   * `Upgrade: websocket`; the optional `handler.upgrade(c)` runs in the request context first and may
   * reject (return a `Response`) or seed per-connection `ws.data`. WebSockets are served by the
   * adapter (`listen()`, `@nifrajs/node`, `@nifrajs/deno`, `toFetchHandler`) — not by bare `app.fetch`, which
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
    // bundle it. Registration is the loud, early failure point — never the first connection.
    const runtime = requireWsRuntime(this.wsRuntime)
    this.topics ??= runtime.createTopics()
    // A `messageSchema` wraps `message` with validation once, here — every adapter then dispatches
    // already-validated, typed messages (Bun/Deno/Node/Workers) with no per-adapter code.
    this.wsRouter.add("GET", path, {
      handler: runtime.wrapHandler(handler as WebSocketHandler),
    })
    this.wsRouteCount += 1
    return this as never
  }

  /**
   * Broadcast `data` to every WebSocket connection subscribed to `topic` (via `ws.subscribe(topic)`).
   * In-process and **single-instance** (see {@link TopicRegistry}) — a multi-instance deploy must bridge
   * an external fan-out (Redis, a Durable Object) to this. A no-op when nobody is subscribed.
   */
  publish(topic: string, data: string | ArrayBufferView | ArrayBuffer): void {
    // No `app.ws()` yet ⇒ no registry and necessarily no subscribers — a publish is a no-op anyway.
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
   * Captures the server's current `derive`/`decorate` chain into the route — this
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
      )
    }
    const hasDecorations = Reflect.ownKeys(routeDecorations).length > 0
    // An idempotency route runs a dedupe lane that must buffer the body and capture the response, so it
    // never takes the fused/native fast path — force it onto the portable matched lane (which routes
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
    // fused/contextless fast path. Resolved per route, at registration — like the capability guard.
    const ledgered: ResolvedEffectLedger | undefined = this.effectLedgerRuntime?.resolve(
      capabilities,
      method,
      path,
    )
    const bare =
      schema?.params === undefined &&
      schema?.body === undefined &&
      schema?.query === undefined &&
      idempotent === undefined &&
      ledgered === undefined &&
      this.derives.length === 0 &&
      this.beforeHandleHooks.length === 0 &&
      this.afterHandleHooks.length === 0 &&
      this.onErrorHooks.length === 0
    const fusedWeb =
      bare && this.aroundHooks.length === 0
        ? this.buildFusedWeb(
            handler as unknown as InternalHandler,
            hasDecorations ? routeDecorations : undefined,
            isContextlessNoArgArrow(handler),
          )
        : undefined
    const contextless = bare && this.aroundHooks.length === 0 && isContextlessNoArgArrow(handler)
    const lane = bare
      ? "bare"
      : schema?.body !== undefined &&
          schema.query === undefined &&
          schema.params === undefined &&
          this.derives.length === 0 &&
          this.beforeHandleHooks.length === 0 &&
          this.afterHandleHooks.length === 0 &&
          this.onErrorHooks.length === 0
        ? "body"
        : schema?.body === undefined &&
            schema?.query !== undefined &&
            schema.params === undefined &&
            this.derives.length === 0 &&
            this.beforeHandleHooks.length === 0 &&
            this.afterHandleHooks.length === 0 &&
            this.onErrorHooks.length === 0
          ? "query"
          : "lifecycle"
    const execution = this.compileExecutionPlan(
      lane,
      contextless,
      this.aroundHooks.length > 0,
      ledgered !== undefined,
      fusedWeb,
    )
    const entry: RouteEntry = {
      // (context: never) => unknown -> InternalHandler: the framework invokes it
      // with the concrete RawContext the typed handler expects, so this is sound.
      handler: handler as unknown as InternalHandler,
      schema,
      idempotent,
      ledgered,
      derives: [...this.derives],
      decorations: routeDecorations,
      hasDecorations,
      beforeHandle: [...this.beforeHandleHooks],
      afterHandle: [...this.afterHandleHooks],
      onError: [...this.onErrorHooks],
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
      entry,
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
    fusedWeb: FusedWebRunner | undefined,
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
      return Object.freeze({ run, fusedWeb })
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
        inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
          runtime.runLifecycle(entry, source, ctx, finalize, wrapResponse)
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
      finalize,
      wrapResponse,
    ) => {
      const ctx = new RequestContext(
        source,
        params,
        search,
        signal,
        budget,
        platform,
        runtime.maxBodyBytes,
      )
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
    return Object.freeze({ run, fusedWeb })
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
        toResponse,
        IDENTITY_RESPONSE,
        RESPONSE_TIMEOUT,
        false,
      ),
    )
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
   * Merge another server's routes into this one — the composition escape hatch for large apps.
   *
   * WHY: the fluent chain accumulates one type-alias level per route, and TypeScript resolves
   * that stack in one recursion — a single chain hits TS2589 at ~95 routes. Groups keep every
   * chain short: build each domain (`listings`, `agents`, …) as its own `server()` (its registry
   * resolves independently), then `app.merge(listings).merge(agents)` — each merge adds ONE level
   * regardless of group size. 300+ routes stay fully typed (see many-routes.test-d.ts). The
   * other escape hatch is contract-first `implement()`, whose registry is a single object type.
   *
   * Semantics: merged routes keep the chains captured where they were DEFINED — the group's
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
        "merge() does not carry WebSocket routes — register .ws() routes on the parent server",
      )
    }
    this.catalog.addBatch(source.catalog.entries().map((route) => this.bindFusedRuntime(route)))
    // Resolved idempotency/ledger route entries carry their own store/sink configuration, while the
    // runtime object supplies the generic execution machinery. Preserve a group's installed runtime
    // when the parent has none so merging cannot silently disable a safety lane. If the parent already
    // has a runtime, either implementation can execute every resolved entry because route-specific
    // options were pinned during registration.
    this.idempotencyRuntime ??= source.idempotencyRuntime
    this.effectLedgerRuntime ??= source.effectLedgerRuntime
    this.mcpRuntime ??= source.mcpRuntime
    this.nodeOutcomeRuntime ??= source.nodeOutcomeRuntime
    this.sseRuntime ??= source.sseRuntime
    this.wsRuntime ??= source.wsRuntime
    this.onRequestHooks.push(...source.onRequestHooks)
    this.onResponseHooks.push(...source.onResponseHooks)
    this.onResponseFinalizedHooks.push(...source.onResponseFinalizedHooks)
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
    const fusedWeb = this.buildFusedWeb(
      entry.handler,
      entry.hasDecorations ? entry.decorations : undefined,
      isContextlessNoArgArrow(entry.handler),
    )
    return {
      ...route,
      entry: {
        ...entry,
        execution: Object.freeze({ ...entry.execution, fusedWeb }),
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
   * Resolve a `Request` to a `Response` — the whole lifecycle, testable without a port. The
   * optional `platform` carries edge inputs (`env`, `waitUntil`); edge adapters pass it, and
   * Bun/Node/Deno omit it (then `c.env` is `undefined` and `c.waitUntil` runs fire-and-forget).
   */
  fetch(req: Request, platform?: Platform<EnvOf<Ctx>>): MaybePromise<Response> {
    // A real `Request` satisfies `RequestSource`, so it's passed straight through — no per-request
    // wrapper allocation on the Web/Bun hot path.
    return this.fetchSource(req, platform)
  }

  private fetchSource(
    source: RequestSource,
    platform?: Platform<EnvOf<Ctx>>,
  ): MaybePromise<Response> {
    // Off path (default): straight through — one property check, no closure, no promise.
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
      toResponse,
      IDENTITY_RESPONSE,
      RESPONSE_TIMEOUT,
      true,
    )
    if (this.onResponseHooks.length === 0 && this.onResponseFinalizedHooks.length === 0) {
      return outcome
    }
    // onResponse sees every response — success, validation error, 404/405, timeout, onRequest
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
      toResponse,
      IDENTITY_RESPONSE,
      RESPONSE_TIMEOUT,
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
   * nothing. The slot is held for the duration of handler execution, not the streaming of the body —
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
    // Release the slot once the response settles — on resolve OR reject — via `finally`, which passes
    // the value/rejection through unchanged. (A single settle hook, rather than separate then-arms: the
    // request pipeline resolves handler errors to a Response, so a rejection arm would be unreachable.)
    if (outcome instanceof Promise) return outcome.finally(release)
    release()
    return outcome
  }

  /**
   * Like {@link fetch}, but renders a plain-data result **without** building a Web `Response` — the
   * `@nifrajs/node` adapter serializes the returned primitives straight to the socket, skipping the undici
   * `Response` build + body drain (the bulk of the Node bridge cost, measured ≈4µs/req). A handler that
   * returns a `Response`, an error/short-circuit, or any registered `onResponse` hook falls back to the
   * full Web path (`{ kind: "response" }`), so behavior is identical — only the common JSON-data case is
   * faster. Same lifecycle as {@link fetch} (body cap, validation, hooks all run); only the final
   * render differs.
   */
  resolveNode(req: Request, platform?: Platform<EnvOf<Ctx>>): MaybePromise<NodeServeOutcome> {
    return this.resolveNodeSource(req, platform)
  }

  resolveNodeSource(
    source: RequestSource,
    platform?: Platform<EnvOf<Ctx>>,
    suppliedRuntime?: NodeOutcomeRuntime,
  ): MaybePromise<NodeServeOutcome> {
    // onResponse hooks transform a Response, and the capacity gate wraps the Web response path — both
    // force the Web path here (the gated `fetchSource` admits/sheds/releases); wrap its result.
    if (
      this.onResponseHooks.length > 0 ||
      this.onResponseFinalizedHooks.length > 0 ||
      this.capacityGate !== undefined
    ) {
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
    return this.dispatch<NodeServeOutcome>(
      source,
      platform,
      runtime.toOutcome,
      runtime.fromResponse,
      runtime.timeout,
      false,
    )
  }

  /**
   * Resolve a WebSocket upgrade — the seam every serving adapter uses. Returns `pass` (not a WS
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
      // Secure default (no explicit `allowedOrigins`): reject a CROSS-ORIGIN browser handshake — the
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
   * context + lifecycle implementation — no duplication across the trust boundary.
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
    // True only from the Web `fetch` path — unlocks each route's fused lane, whose output type IS
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
    return this.runWithOnRequest(source, resolved, finalize, wrapResponse, onTimeout, webFast)
  }

  /**
   * onRequest short-circuit path. Synchronous as long as every hook returns synchronously (the
   * common case — e.g. CORS returning `undefined` for a non-preflight request): an `async` version
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
   * the remaining hooks (awaiting freely — we're already async here). */
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
    const request = requestOf(source)
    const rewritten = this.responseRequests.get(request)
    if (rewritten === undefined) return request
    this.responseRequests.delete(request)
    return rewritten
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
    const url = urlPartsOf(source.url)
    const match = this.catalog.find(source.method, url.pathname)
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
      url.search,
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
    // (with the body buffered). All non-idempotent routes skip straight to the lanes — no added cost.
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
    const outcome: MaybePromise<T> =
      webFast && plan.fusedWeb !== undefined
        ? (plan.fusedWeb(
            source,
            params,
            search,
            signal,
            budget,
            platform,
            false,
          ) as MaybePromise<T>)
        : plan.run(
            this,
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
    // The request timeout only bounds work that is actually pending — a synchronous (bare) result is
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
   * handler, render the result — **no `await`** unless the handler itself returns a promise. It mirrors
   * the bare slice of {@link runLifecycle} (which a bare route would otherwise no-op through) and shares
   * {@link logRequestError}; a bare route has no `onError` hooks, so error handling is fully synchronous
   * (a thrown `Response` is control flow; anything else is a logged flat 500). This is where nifra skips
   * the per-request async-frame tax — the same win codegen routers get, but without `eval`.
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

  /** Bare-route error rendering — identical to {@link runLifecycle}'s catch minus the (absent) onError
   * loop: a thrown `Response` is returned as deliberate control flow; anything else is logged + 500. */
  /**
   * Build a route's fused Web renderer. Composition happens once at
   * registration; the returned closure is what every request to the route runs. Behavior is
   * byte-identical to the generic `runBare`/`runContextlessBare` + `toResponse` pair — same
   * decoration order, same error routing (thrown `Response` = control flow; anything else logs and
   * 500s), same respond semantics (the lifecycle parity suite pins it).
   */
  private buildFusedWeb(
    handler: InternalHandler,
    decorations: Record<PropertyKey, unknown> | undefined,
    contextless: boolean,
  ): FusedWebRunner {
    const logError = (err: unknown, ctx: RawContext): Response => {
      if (err instanceof Response) return err
      this.logRequestError(err, ctx)
      return jsonError(500, "internal_error")
    }
    if (contextless && decorations === undefined) {
      // `() => ...` can't observe the context — skip allocating one entirely (errors still build
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
              ? RequestContext.native(source, params, this.maxBodyBytes)
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
          return result.then(fusedRespondNoSet, (err) =>
            logError(
              err,
              nativeContext
                ? RequestContext.native(source, params, this.maxBodyBytes)
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
        return fusedRespondNoSet(result)
      }
    }
    return (source, params, search, signal, budget, platform, nativeContext) => {
      const ctx = nativeContext
        ? RequestContext.native(source, params, this.maxBodyBytes)
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
          (value) => fusedRespond(value, ctx),
          (err) => logError(err, ctx),
        )
      }
      return fusedRespond(result, ctx)
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
    const contentType = headerOf(source, "content-type") ?? ""
    if (contentType !== "application/json" && !contentType.includes("application/json")) {
      if (isUrlEncodedForm(contentType)) {
        // HTML form posts validate through the same schema as JSON (parity with Elysia/Hono).
        // Off the JSON inline lane on purpose: forms are a fraction of API traffic, and the
        // bounded form reader shares the streaming guard. JSON requests are untouched.
        return readBoundedForm(source, this.maxBodyBytes).then((form) => {
          if (form instanceof Response) return wrapResponse(form)
          return this.finishBodyOnly(entry, form, ctx, finalize, wrapResponse) as Promise<T> | T
        }) as Promise<T>
      }
      return Promise.resolve(wrapResponse(jsonError(415, "unsupported_media_type")))
    }

    // Inline fast path (profiled): a framed, in-cap, non-chunked body parses with the native
    // `req.json()` directly — one promise, one `.then` closure per request. The generic
    // `readBoundedJson` (an extra async-fn frame + per-request `finish`/`applyValidation`
    // closures) is kept for the chunked / length-less / oversized cases it exists for.
    // Semantics are identical to readBoundedJsonSource — same checks, same error codes.
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
        return source.json().then(
          (parsed) => this.finishBodyOnly(entry, parsed, ctx, finalize, wrapResponse),
          // Native json() rejection = malformed JSON; anything past parse goes through
          // finishBodyOnly's own error handling.
          () => wrapResponse(jsonError(400, "invalid_json")),
        )
      }
    }

    try {
      return this.readBoundedJson(source).then(
        (parsed) => {
          if (parsed instanceof Response) return wrapResponse(parsed)
          return this.finishBodyOnly(entry, parsed, ctx, finalize, wrapResponse)
        },
        (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
      )
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  /** Validate + run the handler for the bodyOnly path — shared by the inline fast path and the
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
      // Call the validator directly for the raw StandardResult (read `.issues`/`.value`) — skip
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
   * actually returns a Promise — an `async` version forced a promise + microtask on EVERY response
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
  ): Promise<never> | never {
    const notified = this.notifyResponseFinalized({ response, error }, req)
    if (notified instanceof Promise) {
      return notified.then(() => {
        throw error
      })
    }
    throw error
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
   * result is discarded — JS can't forcibly cancel a promise.
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
  private async runLifecycle<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): Promise<T> {
    try {
      if (entry.schema?.params !== undefined) {
        // Path params arrive as strings from routing; validate (and coerce) them at the boundary, before
        // the body/query, so a malformed `:id` is a 422 before any work runs. Raw `.validate` (no wrapper
        // alloc), same recovery-hook path as body/query.
        const validation = entry.schema.params["~standard"].validate(ctx.params)
        const result = validation instanceof Promise ? await validation : validation
        const paramsError = await this.applyLifecycleValidation(entry, result, ctx, "params")
        if (paramsError !== undefined) return wrapResponse(paramsError)
      }
      if (entry.schema?.body !== undefined) {
        const bodyError = await this.readAndValidateBody(source, entry, ctx)
        if (bodyError !== undefined) return wrapResponse(bodyError)
      }
      if (entry.schema?.query !== undefined) {
        // Repeated query keys promote to `string[]` (so an array schema validates `?a=1&a=2`); a
        // single occurrence stays a string. Raw `.validate` (read `.issues`/`.value`) skips the
        // validateStandard wrapper alloc.
        const validation = entry.schema.query["~standard"].validate(
          queryObjectOf(ctx[CONTEXT_SEARCH]),
        )
        const result = validation instanceof Promise ? await validation : validation
        const queryError = await this.applyLifecycleValidation(entry, result, ctx, "query")
        if (queryError !== undefined) return wrapResponse(queryError)
      }

      // Context extensions: static decorations, then per-request derives.
      // Each hook below only awaits when it actually returns a Promise — a sync hook
      // skips the microtask tick (a fast-path; ~64 ns/hook).
      if (entry.hasDecorations) Object.assign(ctx, entry.decorations) // skip the no-op on bare routes
      // The `.length` guards skip iterator setup for the common no-hook route (most
      // routes have neither derives nor before/after hooks); a hooked route pays only
      // the length check.
      if (entry.derives.length > 0) {
        for (const derive of entry.derives) {
          const extension = derive(ctx)
          Object.assign(ctx, extension instanceof Promise ? await extension : extension)
        }
      }

      // beforeHandle: a non-undefined return short-circuits, skipping the handler.
      if (entry.beforeHandle.length > 0) {
        for (const hook of entry.beforeHandle) {
          const outcome = hook(ctx)
          const early = outcome instanceof Promise ? await outcome : outcome
          if (early !== undefined) return finalize(early, responseSet(ctx))
        }
      }

      const handlerOutput = entry.handler(ctx)
      let result = handlerOutput instanceof Promise ? await handlerOutput : handlerOutput

      // afterHandle: transform the result before serialization.
      if (entry.afterHandle.length > 0) {
        for (const hook of entry.afterHandle) {
          const transformed = hook(result, ctx)
          result = transformed instanceof Promise ? await transformed : transformed
        }
      }

      return finalize(result, responseSet(ctx))
    } catch (err) {
      return this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse)
    }
  }

  private async handleLifecycleError<T>(
    entry: RouteEntry,
    err: unknown,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): Promise<T> {
    // A *thrown* Response is deliberate control flow, not an error — a guard throws a redirect/401,
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

  /** Log an unhandled request error to the (redacting) logger — shared by {@link runLifecycle} and the
   * bare fast path ({@link bareError}) so both record the same fields. Never throws; never leaks. */
  private logRequestError(err: unknown, ctx: RawContext): void {
    this.logger.error("unhandled request error", {
      method: ctx.req.method,
      path: pathnameOf(ctx.req.url),
      name: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message : String(err),
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
      // multipart/form-data (file uploads) stays 415 on the schema path by design — files don't
      // fit a value schema; use a schema-less route + @nifrajs/uploads helpers for those.
      return jsonError(415, "unsupported_media_type")
    }
    const validation = entry.schema!.body!["~standard"].validate(parsed)
    const result = validation instanceof Promise ? await validation : validation
    return this.applyLifecycleValidation(entry, result, ctx, "body")
  }

  /** Apply validation and its recovery hook on the generic lifecycle lane. Recovery is completed
   * before derives/beforeHandle run, matching the body-only and query-only execution lanes. */
  private async applyLifecycleValidation(
    entry: RouteEntry,
    result: StandardResult<unknown>,
    ctx: RawContext,
    kind: "body" | "query" | "params",
  ): Promise<Response | undefined> {
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
    const recovery = attempted instanceof Promise ? await attempted : attempted
    if (recovery === undefined) return validationError(result.issues)
    if (recovery instanceof Response) return recovery
    const schema =
      kind === "body"
        ? entry.schema?.body
        : kind === "query"
          ? entry.schema?.query
          : entry.schema?.params
    const retried = schema!["~standard"].validate(recovery)
    const settled = retried instanceof Promise ? await retried : retried
    if (settled.issues !== undefined) return validationError(settled.issues)
    assign(settled.value)
    return undefined
  }

  /**
   * Read the body as text, capped at `maxBodyBytes`. Rejects (`null`) on a
   * `Content-Length` over the cap *before* buffering, and aborts mid-stream once the
   * running byte count exceeds it — so a lying or absent length can't force us to
   * buffer an oversized payload.
   *
   * Fast path: when a non-chunked request carries a `Content-Length` within the cap,
   * a native `req.json()` is already bounded — under HTTP/1.1 + HTTP/2 framing the
   * runtime delivers at most `Content-Length` bytes — so we skip the manual stream
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
    // bypasses — so an app that declares trust routes through the fetch lane (where `c.clientIp`
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
   * load-balances connections across them — the standard way to use every core (Bun is
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
    // bridges them — Bun's `.port` is `number | undefined` (undefined only for unix
    // sockets, never a TCP `listen`) and its `.stop` returns a promise we don't await.
    // Pass only the request — Bun's `fetch` 2nd arg is the Bun `Server`, not our `platform`.
    // With WS routes, hand Bun a `websocket` config + a fetch that upgrades matching requests (the
    // `server` 2nd arg is how Bun exposes `upgrade`); otherwise the lean request-only fetch. The
    // `websocket` handlers are one shared dispatcher — each connection's `ws.data.handler` is the
    // matched route's handler, set by `server.upgrade`.
    // With WS routes, the dispatcher comes from the installed `.use(websocket())` runtime — non-null
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
   * issue a single terminal stop — graceful if everything drained, forced if
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
    // Drain, then let the process exit naturally — the stopped server no longer
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
 * Create a new {@link Server}. Pass an `Env` to type the platform bindings — `server<Env>()` makes
 * `c.env: Env` in every handler + middleware, and types the `env` argument of `app.fetch` /
 * `toFetchHandler`. Omit it and `c.env` is `unknown` (validate/cast before use).
 */
export function server<Env = unknown>(
  options?: ServerOptions,
): Server<EmptyRegistry, { readonly env: Env }> {
  // `Env` is a phantom type-level marker: the runtime `env` arrives via `app.fetch(req, { env })` at
  // request time, not stored on the builder — so seed the context type with a cast (as `derive`/
  // `decorate` do for their `Ctx` extensions).
  return new Server(options) as unknown as Server<EmptyRegistry, { readonly env: Env }>
}

/** A Cloudflare Workers-style execution context (the `fetch` 3rd arg). Structural — only
 * `waitUntil` is used; declared here so `@nifrajs/core` needs no Workers type dependency. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

/** A Cloudflare Workers-style scheduled (cron) controller. Structural — no Workers type dependency. */
export interface ScheduledController {
  /** Epoch ms the run was scheduled for. */
  readonly scheduledTime: number
  /** The matching cron expression from `wrangler.toml` `[triggers]`. */
  readonly cron: string
  /** Tell the platform not to retry this run on failure. */
  noRetry(): void
}

/** A nifra cron handler: the platform controller + the same typed `env`/`waitUntil` nifra threads into
 * request handlers. Schedule background work with `waitUntil` so it outlives the trigger. */
export type ScheduledHandler<Env = unknown> = (
  controller: ScheduledController,
  context: { readonly env: Env; waitUntil(promise: Promise<unknown>): void },
) => MaybePromise<void>

/**
 * Adapt a nifra app to an edge "ExportedHandler" — use it as a Cloudflare Workers (or any
 * `fetch(request, env, ctx)` runtime) default export. It threads `env` + `ctx.waitUntil` into the
 * nifra Context, so handlers read `c.env` and schedule background work via `c.waitUntil`:
 *
 *   export default toFetchHandler(app)
 *
 * Pass `{ scheduled }` to also export a Workers cron handler (for a `[triggers]` schedule) — it
 * receives the platform controller plus the same typed `env`/`waitUntil`:
 *
 *   export default toFetchHandler(app, {
 *     scheduled: (controller, { env, waitUntil }) =>
 *       waitUntil(env.KV.put("last-run", String(controller.scheduledTime))),
 *   })
 *
 * No Workers-only deps — `app.fetch` stays a portable Web-standard handler; this is the thin
 * shim from the platform's 3-arg `fetch`/`scheduled` to it.
 */
/** Cloudflare's `WebSocketPair` — feature-detected (absent off Workers). Yields `{ 0: client, 1: server }`. */
type WebSocketPairCtor = new () => {
  readonly 0: unknown
  readonly 1: StandardWebSocket & { accept(): void }
}

/** Structural view of a Cloudflare Durable Object namespace binding — keeps `@cloudflare/workers-types`
 * out of `@nifrajs/core`. The real `DurableObjectNamespace` satisfies it. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** The single hub Durable Object id nifra routes WS upgrades to (one hub per app — see `@nifrajs/workers`). */
const NIFRA_WS_HUB_ID = "nifra-ws-hub"

export function toFetchHandler<Env = unknown>(
  app: {
    fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>
    resolveWebSocketUpgrade?(
      request: Request,
      platform?: Platform<Env>,
    ): MaybePromise<WebSocketUpgradeOutcome>
  },
  options?: {
    scheduled?: ScheduledHandler<Env>
    /**
     * Route WebSocket upgrades to a Durable Object that holds the connections and runs the app's
     * pub/sub — enabling cross-connection broadcast (`app.publish`) on Cloudflare Workers, where a
     * stateless isolate can't. Pass the DO namespace binding from `env`; pair with `@nifrajs/workers`'
     * `createWebSocketHub(app)` (the DO class) + a `wrangler.toml` binding. Without this, WS upgrades use
     * a per-connection `WebSocketPair` (no broadcast).
     */
    webSocketHub?: (env: Env) => DurableObjectNamespaceLike
  },
): {
  fetch(request: Request, env: Env, ctx: ExecutionContext): MaybePromise<Response>
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): MaybePromise<void>
} {
  const scheduled = options?.scheduled
  const webSocketHub = options?.webSocketHub
  const resolveWs = app.resolveWebSocketUpgrade?.bind(app)
  return {
    fetch: (request, env, ctx) => {
      const platform: Platform<Env> = { env, waitUntil: (promise) => ctx.waitUntil(promise) }
      // WebSocket broadcast on Workers: route upgrades to the hub Durable Object (it holds the
      // connections + runs the app's pub/sub, so `app.publish` reaches every client). The hub itself
      // resolves the route and rejects non-WS paths. See `@nifrajs/workers`' `createWebSocketHub`.
      if (
        webSocketHub !== undefined &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        const ns = webSocketHub(env)
        return ns.get(ns.idFromName(NIFRA_WS_HUB_ID)).fetch(request)
      }
      // Workers WebSockets: a WS upgrade for a registered route becomes a `WebSocketPair` + a 101.
      // Feature-detected, so non-Workers edge runtimes (which lack `WebSocketPair` — e.g. Deno Deploy
      // uses `@nifrajs/deno`'s `Deno.upgradeWebSocket`) simply fall through to the normal `fetch`.
      const Pair = (globalThis as { WebSocketPair?: WebSocketPairCtor }).WebSocketPair
      if (resolveWs !== undefined && Pair !== undefined) {
        const accept = (outcome: WebSocketUpgradeOutcome): MaybePromise<Response> => {
          if (outcome.kind === "pass") return app.fetch(request, platform)
          if (outcome.kind === "reject") return outcome.response
          const pair = new Pair()
          const server = pair[1]
          server.accept()
          // The outcome carries the installed runtime's `attach`, so `toFetchHandler` (a standalone
          // function, no access to the app's private runtime) wires the socket without a static WS import.
          outcome.attach(server, outcome.handler, outcome.data, {
            openNow: true,
            pubsub: outcome.pubsub,
          })
          // `webSocket` is a Workers-only `ResponseInit` field (absent from the standard type), and a
          // 101 status is only valid on the Workers runtime — both gated by the `Pair` feature check.
          return new Response(null, { status: 101, webSocket: pair[0] } as unknown as ResponseInit)
        }
        const out = resolveWs(request, platform)
        return out instanceof Promise ? out.then(accept) : accept(out)
      }
      return app.fetch(request, platform)
    },
    ...(scheduled !== undefined
      ? {
          scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) =>
            scheduled(controller, { env, waitUntil: (promise) => ctx.waitUntil(promise) }),
        }
      : {}),
  }
}
