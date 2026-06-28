import { FrameworkError } from "../errors.ts"
import { EMPTY_PARAMS, type Method, Router } from "../router/router.ts"
import type {
  InferOutput,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
} from "../schema/standard.ts"
import { drainCapped, parseContentLength, readBoundedBytes } from "./body.ts"
import type { Context, Platform, ResponseControls, RouteSchema } from "./context.ts"
import { type CookieOptions, parseCookies, serializeCookie } from "./cookies.ts"
import { jsonLogger, type Logger } from "./logger.ts"
import type { AddRoute, EmptyRegistry, OutputOf, Registry, RouteInfoFor } from "./registry.ts"
import type {
  StandardWebSocket,
  TopicRegistry,
  WebSocketContext,
  WebSocketHandler,
  WebSocketUpgradeOutcome,
} from "./websocket.ts"
import type { BunWsData } from "./ws-bun.ts"
import { getWsRuntime, type WsRuntime } from "./ws-hook.ts"

type MaybePromise<T> = T | Promise<T>

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

/** The concrete `Request` for a source — itself when a real `Request` was passed (the Web path), or the
 * lazily-built one (the Node adapter). A real `Request` IS a `RequestSource`, so no wrapper is allocated
 * on the Web hot path. */
function requestOf(source: RequestSource): Request {
  return source.request ?? (source as unknown as Request)
}

function headerOf(source: RequestSource, name: string): string | null {
  return source.header?.(name) ?? source.headers.get(name)
}

/** The empty context extension. `NonNullable<unknown>` is `{}` without tripping noBannedTypes. */
type EmptyContext = NonNullable<unknown>

/**
 * Extracts the app's platform `Env` from its context `Ctx`. `server<Env>()` seeds `Ctx` with
 * `{ env: Env }`, so this pulls that back out to type `fetch`/`toFetchHandler`'s `env` argument
 * against the app's declared bindings. Defaults to `unknown` when no env was declared.
 */
type EnvOf<Ctx> = Ctx extends { readonly env: infer E } ? E : unknown

/** A handler returns a `Response` (used as-is) or any value (serialized to JSON). */
type HandlerResult = Response | unknown
type ContextlessHandler = () => MaybePromise<HandlerResult>

const RESPONSE_RESULT = Symbol.for("nifra.response.result")
const CONTEXT_SET = Symbol("nifra.context.set")
const CONTEXT_SEARCH = Symbol("nifra.context.search")
const functionToString = Function.prototype.toString
const CONTEXTLESS_ARROW = /^(?:async\s*)?\(\s*\)\s*(?::[\s\S]*?)?=>/

interface ResponseResult {
  readonly [RESPONSE_RESULT]: true
  toResponse(): Response
  toNodeBody?(): {
    readonly status: number
    readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
    readonly body: string | Uint8Array
  }
}

function isResponseResult(value: unknown): value is ResponseResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [RESPONSE_RESULT]?: unknown })[RESPONSE_RESULT] === true &&
    typeof (value as { readonly toResponse?: unknown }).toResponse === "function"
  )
}

/** Internal, path-erased runtime context. The typed `Context<Path, S>` is a structural view of this. */
interface RawContext {
  readonly req: Request
  readonly request: Request
  readonly json: (body: unknown, init?: ResponseInit | number) => Response
  readonly text: (body: string, init?: ResponseInit | number) => Response
  readonly params: Record<string, string>
  query: unknown
  readonly cookies: Readonly<Record<string, string>>
  body: unknown
  readonly set: ResponseControls
  readonly [CONTEXT_SET]: () => CtxSet | undefined
  readonly [CONTEXT_SEARCH]: string
  readonly signal: AbortSignal
  readonly env: unknown
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly boundedBody: (maxBytes?: number) => Promise<Uint8Array>
  readonly boundedJson: <T = unknown>(maxBytes?: number) => Promise<T>
}

/** Off-edge `waitUntil`: run the background work fire-and-forget, never leaking an unhandled
 * rejection. Edge runtimes pass their own (Workers `ctx.waitUntil`) via the platform arg. */
const fallbackWaitUntil = (promise: Promise<unknown>): void => {
  void promise.catch(() => {})
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
type RawOnRequest = (req: Request) => MaybePromise<OnRequestResult>
type RawOnResponse = (response: Response, req: Request) => MaybePromise<Response>

interface RouteEntry {
  readonly handler: InternalHandler
  readonly schema: RouteSchema | undefined
  /** Per-request context extensions captured at registration (order-scoped). */
  readonly derives: ReadonlyArray<RawDerive>
  /** Static context extensions captured at registration. */
  readonly decorations: Record<string, unknown>
  /** Whether {@link decorations} has any keys — precomputed so the hot path skips a no-op
   * `Object.assign` on the (common) no-decoration route. */
  readonly hasDecorations: boolean
  /** Lifecycle hooks captured at registration (order-scoped). */
  readonly beforeHandle: ReadonlyArray<RawBeforeHandle>
  readonly afterHandle: ReadonlyArray<RawAfterHandle>
  readonly onError: ReadonlyArray<RawErrorHandler>
  /** Wraps the matched route lifecycle. Empty for the common no-around path. */
  readonly around: ReadonlyArray<RawAround>
  /**
   * Precomputed: the route has no body/query schema and no derive/beforeHandle/afterHandle/onError
   * hooks — so its lifecycle reduces to `finalize(handler(ctx), set)` with simple error handling, no
   * `await` unless the handler itself is async. Such routes take the **synchronous fast path**
   * ({@link Server.runBare}), which skips the `async` machinery of the full {@link Server.runLifecycle}
   * (≈2 promise frames/req — the per-request tax codegen routers avoid; nifra avoids it here without
   * `eval`, so it stays edge-safe). Static decorations are still applied (they're a sync `Object.assign`).
   */
  readonly bare: boolean
  /**
   * A narrower bare-route path for syntactic zero-parameter arrow handlers (`() => ...`). Unlike
   * `handler.length === 0`, this intentionally excludes `function () { arguments }`, rest params,
   * default params, bound/native functions, and anything else that can observe the passed context.
   */
  readonly contextlessBare: boolean
  /** Precomputed body-schema-only path: JSON body validation + handler, no other lifecycle hooks. */
  readonly bodyOnly: boolean
  /** Precomputed query-schema-only path: query validation + handler, no other lifecycle hooks. */
  readonly queryOnly: boolean
  /**
   * Registration-time-fused Web lane for a {@link bare} route with no `around` hooks: context (when
   * the handler can observe one), handler, and the JSON respond collapsed into ONE monomorphic
   * closure — no per-request branch ladder, no `responseSet` lookup, no codegen (`new Function`
   * measured equivalent to closures on JSC). Only the Web finalizer
   * (`fetch`) uses it — the node-direct path keeps the generic lifecycle.
   */
  readonly fusedWeb: FusedWebRunner | undefined
}

/** The fused Web lane: same inputs `routeAndRun` would hand the generic path, a `Response` out. */
type FusedWebRunner = (
  source: RequestSource,
  params: Record<string, string>,
  search: string,
  signal: AbortSignal,
  platform: Platform | undefined,
) => MaybePromise<Response>

/** A registered WebSocket route — just its handler; matching reuses {@link Router} under the GET verb. */
interface WsEntry {
  readonly handler: WebSocketHandler
}

/** Structural view of the Bun `Server` `upgrade` the `fetch` 2nd arg exposes. */
interface BunUpgradeServer {
  upgrade(request: Request, options?: { data?: BunWsData }): boolean
}

const WS_PASS: WebSocketUpgradeOutcome = { kind: "pass" }

/** `app.ws()` (and everything downstream of it) needs the runtime `@nifrajs/core/ws` registers. */
function requireWsRuntime(): WsRuntime {
  const runtime = getWsRuntime()
  if (runtime === undefined) {
    throw new FrameworkError(
      "WS_RUNTIME_MISSING",
      'app.ws() needs the WebSocket runtime, which ships as a subpath so no-WebSocket apps stay lean. Add `import "@nifrajs/core/ws"` at your server entry.',
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

export interface ServerOptions {
  /**
   * Max request body size (bytes), enforced **only when a route declares a body schema** — the cap
   * lives in the schema-validated read path. Default 1_000_000.
   *
   * A route WITHOUT a body schema (raw body, file upload, BYO-validation) that reads `c.req` directly
   * is not auto-bounded — use **`c.boundedBody(maxBytes?)`** / **`c.boundedJson(maxBytes?)`**, which
   * apply this same cap (override per route by passing `maxBytes` — larger for an upload endpoint,
   * smaller to tighten one).
   */
  readonly maxBodyBytes?: number
  /** Per-request timeout (ms): a slower request gets a 503 and `ctx.signal` aborts. 0 disables (default). */
  readonly requestTimeoutMs?: number
  /** When `listen()`ing, install SIGTERM/SIGINT handlers that gracefully `stop()`. Default false. */
  readonly gracefulSignals?: boolean
  /** Structured logger for framework events (redacts secrets). Default: JSON to stderr. */
  readonly logger?: Logger
}

/**
 * A registered route's public descriptor — method, path, and input schemas. The
 * router trie discards the original patterns, so this flat list is what lets tools
 * (e.g. `toOpenAPI`) enumerate routes after registration.
 */
export interface RouteDescriptor {
  readonly method: Method
  readonly path: string
  readonly schema: RouteSchema | undefined
}

/**
 * The handle `listen()` returns — the slice of Bun's server nifra holds and exposes.
 * Declared explicitly (rather than `ReturnType<typeof Bun.serve>`) so the public type
 * surface doesn't leak the ambient `Bun` global into consumers' `.d.ts` resolution.
 */
export interface RunningServer {
  readonly port: number
  readonly hostname: string
  readonly pendingRequests: number
  stop(closeActiveConnections?: boolean): void
}

/**
 * A bundle of lifecycle hooks applied together via {@link Server.use} — the unit
 * `@nifrajs/middleware` ships (cors, security headers, rate-limit). Every hook is
 * optional and wired to its lifecycle point. Middleware is context-agnostic (sees
 * the base `Context`); `use` does no context-type merging — the full type-merging
 * plugin system is deferred, and `.use` is reserved as its future entry point.
 */
export interface Middleware {
  readonly name?: string
  readonly onRequest?: (req: Request) => MaybePromise<OnRequestResult>
  readonly around?: <T>(context: Context, next: () => MaybePromise<T>) => MaybePromise<T>
  readonly beforeHandle?: (context: Context) => MaybePromise<unknown>
  readonly afterHandle?: (result: unknown, context: Context) => MaybePromise<unknown>
  readonly onResponse?: (response: Response, req: Request) => MaybePromise<Response>
  readonly onError?: (error: unknown, context: Context) => MaybePromise<unknown>
}

// A plugin operates over arbitrary Server shapes; `any` here is the standard framework escape hatch
// (the precise threading happens at the `use` call site, which is generic over the *concrete* `this`).
// biome-ignore lint/suspicious/noExplicitAny: plugins are generic over any Server's Registry/Context
export type AnyServer = Server<any, any>

/**
 * A nifra **plugin**: a function that augments an app — calling `use`/`derive`/`decorate` and/or
 * registering routes — and returns it. Because `derive`/`decorate` are type-threaded, an **inline**
 * `app.use((a) => a.derive(...).decorate(...))` carries the added context to handlers defined after
 * it (the `use` overload is generic over the concrete `this`). Wrap with {@link definePlugin} to
 * attach a name for idempotent dedupe (applying the same named plugin twice — e.g. transitively — is
 * a no-op).
 */
export type NifraPlugin<In extends AnyServer = AnyServer, Out extends AnyServer = In> = ((
  app: In,
) => Out) & { readonly pluginName?: string }

/**
 * A named type-identity plugin built with {@link defineIdentityPlugin}. It returns the same concrete
 * server type it receives, preserving the caller's typed registry and context across `.use()` while
 * still allowing the plugin to register runtime hooks or handlers.
 */
export type IdentityPlugin = (<S extends AnyServer>(app: S) => S) & {
  readonly pluginName?: string
}

/**
 * Name + ergonomics for a plugin. `app.use(myPlugin)` applies it once; a second `use` of the same
 * name is skipped (idempotent), so plugins can depend on each other without double-registering hooks.
 *
 * ```ts
 * export const requestId = definePlugin("requestId", (app) => app.derive(() => ({ requestId: uuid() })))
 * app.use(requestId)   // downstream handlers see c.requestId
 * ```
 */
export function definePlugin<In extends AnyServer, Out extends AnyServer>(
  name: string,
  apply: (app: In) => Out,
): NifraPlugin<In, Out> {
  return Object.assign(apply, { pluginName: name }) as NifraPlugin<In, Out>
}

/**
 * Define a type-**identity** plugin: it registers routes/hooks as a side effect but returns the app with
 * its `Registry` + `Context` UNCHANGED. Use this (not {@link definePlugin}) for any plugin that doesn't
 * add context types — e.g. one mounting an auth handler. It threads the caller's *concrete* server type
 * through `use`, so routes declared after `app.use(plugin)` keep their types.
 *
 * Why a dedicated helper: `definePlugin((app) => app)` infers `app: Server<any, any>`, so `use` returns
 * `Server<any, any>` and the whole typed client collapses to `any`. The explicit generic return type here
 * (which a plain `Object.assign` can't preserve) is what keeps `use` returning the precise server type.
 *
 * ```ts
 * export const audit = defineIdentityPlugin("audit", (app) => app.onResponse(logResponse))
 * const api = server().get("/a", h).use(audit).get("/b", h) // /a AND /b stay typed
 * ```
 */
export function defineIdentityPlugin(
  name: string,
  apply: <S extends AnyServer>(app: S) => S,
): IdentityPlugin {
  return Object.assign(apply, { pluginName: name }) as IdentityPlugin
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000
const DEFAULT_DRAIN_MS = 10_000
const DRAIN_POLL_MS = 10
const TEXT_DECODER = new TextDecoder()
/**
 * Shared never-aborting signal for `ctx.signal` when no timeout is armed — created lazily and
 * cached. NOT a module-scope `new AbortController()`: edge runtimes (Cloudflare workerd) forbid
 * constructing one in global scope; the first request builds it inside the handler, then it's
 * reused at zero per-request cost.
 */
let neverAbortSignal: AbortSignal | undefined
const getNeverAbortSignal = (): AbortSignal => {
  neverAbortSignal ??= new AbortController().signal
  return neverAbortSignal
}

function jsonError(status: number, error: string, headers?: Record<string, string>): Response {
  return Response.json(
    { ok: false, error },
    headers !== undefined ? { status, headers } : { status },
  )
}

function validationError(issues: ReadonlyArray<StandardIssue>): Response {
  const serialized = issues.map((issue) => {
    const path = issue.path?.map((seg) => String(typeof seg === "object" ? seg.key : seg))
    return path !== undefined ? { message: issue.message, path } : { message: issue.message }
  })
  return Response.json({ ok: false, error: "validation", issues: serialized }, { status: 400 })
}

interface UrlParts {
  readonly pathname: string
  readonly search: string
}

// Extract pathname + query WITHOUT a full WHATWG `new URL(req.url)` parse.
// `req.url` from every supported runtime is an absolute, already-normalized URL, so the pathname is
// the substring after `scheme://host[:port]` up to `?`/`#`. Query-schema routes also need the search
// string; parsing both in one scanner avoids the old `pathnameOf()` + `searchOf()` double scan.
export function urlPartsOf(url: string): UrlParts {
  const schemeEnd = url.indexOf("://")
  const start = schemeEnd === -1 ? url.indexOf("/") : url.indexOf("/", schemeEnd + 3)
  if (start === -1) return { pathname: "/", search: "" }

  let pathEnd = url.length
  let searchStart = -1
  let searchEnd = url.length
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c === 63 /* ? */ && searchStart === -1) {
      pathEnd = i
      searchStart = i
    } else if (c === 35 /* # */) {
      if (searchStart === -1) pathEnd = i
      searchEnd = i
      break
    }
  }

  return {
    pathname: url.slice(start, pathEnd),
    search: searchStart === -1 ? "" : url.slice(searchStart, searchEnd),
  }
}

// Extract the pathname WITHOUT a full WHATWG `new URL(req.url)` parse. Kept as a public-ish helper
// for tests and callers that only need the path; the request hot path uses `urlPartsOf()` once.
export function pathnameOf(url: string): string {
  return urlPartsOf(url).pathname
}

// The query string ("?a=1", or "" when absent) — for lazily building `c.query` only when read.
// The fragment (after the first `#`) bounds the search: a `?` that appears only inside the fragment
// is NOT a query (matches WHATWG). Fragments never reach the server in `req.url`, so this is purely
// for provable equivalence with `new URL(req.url).search`.
export function searchOf(url: string): string {
  return urlPartsOf(url).search
}

/** A query value: a single occurrence is a string; a repeated key promotes to a string[] so an
 * array query schema (`t.array(t.string())`) can validate `?tag=a&tag=b` — last-wins silently
 * dropped values before (audit 2026-06). Single-occurrence keys stay plain strings, so existing
 * `t.string()` schemas are untouched; a repeated key against a string schema now FAILS validation
 * (an explicit 400 beats silently picking one). */
export type QueryValue = string | string[]

/** Accumulate into a NULL-PROTOTYPE record (every call site below creates one): with no inherited
 * `constructor`/`toString`/`__proto__` accessors, a hostile key is just an own data key — the
 * promotion logic can't collide with `Object.prototype` members, and `__proto__` needs no special
 * case (direct assignment on a null-proto object creates an own property). */
function setQueryValue(out: Record<string, QueryValue>, key: string, value: string): void {
  const existing = out[key]
  if (existing === undefined) {
    out[key] = value
  } else if (typeof existing === "string") {
    out[key] = [existing, value]
  } else {
    existing.push(value)
  }
}

function queryObjectFallback(search: string): Record<string, QueryValue> {
  // Manual iteration instead of Object.fromEntries: repeated keys must promote to arrays
  // (fromEntries is last-wins), and __proto__ needs the same own-property guard.
  const out: Record<string, QueryValue> = Object.create(null) as Record<string, QueryValue>
  for (const [key, value] of new URLSearchParams(search)) {
    setQueryValue(out, key, value)
  }
  return out
}

/**
 * Build the plain object passed to query schemas. Plain ASCII-ish queries avoid
 * `URLSearchParams` + iterator allocations; encoded queries fall back to the Web API so `+`,
 * percent-decoding, malformed escapes, and empty-key behavior stay exact. Repeated keys promote
 * to `string[]` on BOTH paths (see {@link setQueryValue}).
 */
// Shared empty result for no-query requests: frozen + null-prototype (same shape contract as the
// populated path), allocated once instead of per request.
const EMPTY_QUERY = Object.freeze(Object.create(null)) as Record<string, QueryValue>

export function queryObjectOf(search: string): Record<string, QueryValue> {
  const start = search.charCodeAt(0) === 63 /* ? */ ? 1 : 0
  if (start >= search.length) return EMPTY_QUERY

  for (let i = start; i < search.length; i++) {
    const c = search.charCodeAt(i)
    if (c === 37 /* % */ || c === 43 /* + */) return queryObjectFallback(search)
  }

  const out: Record<string, QueryValue> = Object.create(null) as Record<string, QueryValue>
  let pos = start
  while (pos <= search.length) {
    const amp = search.indexOf("&", pos)
    const end = amp === -1 ? search.length : amp
    if (end > pos) {
      const eq = search.indexOf("=", pos)
      const split = eq !== -1 && eq < end ? eq : end
      const key = search.slice(pos, split)
      const value = split === end ? "" : search.slice(split + 1, end)
      setQueryValue(out, key, value)
    }
    if (amp === -1) break
    pos = amp + 1
  }
  return out
}

/** `application/x-www-form-urlencoded`, with or without a charset suffix. */
function isUrlEncodedForm(contentType: string): boolean {
  return (
    contentType === "application/x-www-form-urlencoded" ||
    contentType.startsWith("application/x-www-form-urlencoded;")
  )
}

const FORM_DECODER = new TextDecoder()

/**
 * Read an HTML-form body (urlencoded) into the plain object a body schema validates — same byte
 * cap as the JSON path (a lying/absent Content-Length can't force an oversized buffer), same
 * repeated-key → `string[]` promotion as query parsing, same `__proto__` guard.
 */
async function readBoundedForm(
  req: RequestSource,
  maxBytes: number,
): Promise<Record<string, QueryValue> | Response> {
  const read = await readBoundedBytes(req, maxBytes)
  if (!read.ok) {
    return read.status === 413
      ? jsonError(413, "payload_too_large")
      : jsonError(400, "invalid_content_length")
  }
  const out: Record<string, QueryValue> = Object.create(null) as Record<string, QueryValue>
  // URLSearchParams owns the format's quirks (`+` as space, percent-decoding, empty keys);
  // it never throws on junk input, so no try/catch is needed here.
  for (const [key, value] of new URLSearchParams(FORM_DECODER.decode(read.bytes))) {
    setQueryValue(out, key, value)
  }
  return out
}

function decodeParams(raw: Record<string, string>): Record<string, string> | null {
  let out: Record<string, string> | undefined
  for (const key in raw) {
    const value = raw[key]!
    // `decodeURIComponent` only changes strings containing `%`; for the common
    // unencoded param (`/users/123`) skip the call and its throw-check entirely —
    // semantically identical (no `%` ⇒ no escapes to decode), ~3× cheaper on that path. If every
    // param is already plain, return the router's per-request object directly and skip a clone.
    if (!value.includes("%")) {
      continue
    }
    try {
      out ??= { ...raw }
      out[key] = decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return out ?? raw
}

/** `ctx.set` carrying the lazy backings (`_headers`, `_cookies`) so `toResponse` can skip allocating
 * anything when no handler touched `c.set.*`. Server-internal. */
type CtxSet = ResponseControls & {
  _headers?: Record<string, string>
  /** Accumulated `Set-Cookie` values — a list, since a `Record` would collapse multiple cookies. */
  _cookies?: string[]
}

class LazyResponseControls implements CtxSet {
  status?: number
  _headers?: Record<string, string>
  _cookies?: string[]

  get headers(): Record<string, string> {
    this._headers ??= {}
    return this._headers
  }

  cookie(name: string, value: string, options?: CookieOptions): void {
    // Secure-by-default: HttpOnly + Secure + SameSite=Lax + Path=/, overridable per call.
    const merged: CookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      ...options,
    }
    this._cookies ??= []
    this._cookies.push(serializeCookie(name, value, merged))
  }

  deleteCookie(name: string, options?: Pick<CookieOptions, "path" | "domain">): void {
    // Expire immediately; default Path=/, and match the original path/domain or the browser keeps it.
    this._cookies ??= []
    this._cookies.push(
      serializeCookie(name, "", { path: "/", ...options, maxAge: 0, expires: EPOCH }),
    )
  }
}

// Finalization only reads `status`, `_headers`, and `_cookies`. The user-visible mutator methods
// live on `LazyResponseControls`, created by the `c.set` getter only when user code touches it.
const EMPTY_RESPONSE_CONTROLS = Object.freeze({}) as CtxSet

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

/** Coerce `c.json`/`c.text`'s second arg — a status number (the common case) or a full `ResponseInit`. */
function statusInit(init?: ResponseInit | number): ResponseInit | undefined {
  return typeof init === "number" ? { status: init } : init
}

class RequestContext implements RawContext {
  readonly params: Record<string, string>
  readonly signal: AbortSignal
  readonly env: unknown
  readonly waitUntil: (promise: Promise<unknown>) => void
  body: unknown
  readonly [CONTEXT_SEARCH]: string

  private setValue: CtxSet | undefined
  private queryValue: unknown
  private queryReady: boolean
  private cookiesValue: Readonly<Record<string, string>> | undefined
  private readonly source: RequestSource
  private readonly maxBodyBytes: number

  constructor(
    source: RequestSource,
    params: Record<string, string>,
    search: string,
    signal: AbortSignal,
    platform: Platform | undefined,
    maxBodyBytes: number,
  ) {
    this.source = source
    this.params = params
    this[CONTEXT_SEARCH] = search
    this.signal = signal
    this.env = platform?.env
    this.waitUntil = platform?.waitUntil ?? fallbackWaitUntil
    this.maxBodyBytes = maxBodyBytes
    this.setValue = undefined
    this.body = undefined
    this.queryValue = undefined
    this.queryReady = false
    this.cookiesValue = undefined
  }

  [CONTEXT_SET](): CtxSet | undefined {
    return this.setValue
  }

  get set(): CtxSet {
    this.setValue ??= new LazyResponseControls()
    return this.setValue
  }

  get req(): Request {
    return requestOf(this.source)
  }

  get request(): Request {
    return requestOf(this.source)
  }

  json(body: unknown, init?: ResponseInit | number): Response {
    return Response.json(body, statusInit(init))
  }

  text(body: string, init?: ResponseInit | number): Response {
    const i = statusInit(init)
    // Default to text/plain; if the caller passes their own headers, they own the content-type.
    if (i?.headers !== undefined) return new Response(body, i)
    return new Response(body, { ...i, headers: { "content-type": "text/plain; charset=utf-8" } })
  }

  get query(): unknown {
    if (!this.queryReady) {
      this.queryValue = new URLSearchParams(this[CONTEXT_SEARCH])
      this.queryReady = true
    }
    return this.queryValue
  }

  set query(v: unknown) {
    this.queryValue = v
    this.queryReady = true
  }

  get cookies(): Readonly<Record<string, string>> {
    this.cookiesValue ??= parseCookies(headerOf(this.source, "cookie"))
    return this.cookiesValue
  }

  boundedBody(maxBytes?: number): Promise<Uint8Array> {
    return readBoundedBodyOrThrow(this.source, this.maxBodyBytes, maxBytes)
  }

  boundedJson<T = unknown>(maxBytes?: number): Promise<T> {
    return readBoundedJsonBodyOrThrow<T>(this.source, this.maxBodyBytes, maxBytes)
  }
}

/** Backs `c.boundedBody`: bounded byte read that throws a flat 413/400 `Response` (caught by
 * `runLifecycle` as control flow, like `throw redirect(...)`), so a handler can't ignore the cap.
 * The byte-cap itself lives in `./body.ts` (shared with the schema path and `verifyWebhook`). */
async function readBoundedBodyOrThrow(
  req: RequestSource,
  maxBodyBytes: number,
  maxBytes?: number,
): Promise<Uint8Array> {
  const r = await readBoundedBytes(req, maxBytes ?? maxBodyBytes)
  if (r.ok) return r.bytes
  throw r.status === 413
    ? jsonError(413, "payload_too_large")
    : jsonError(400, "invalid_content_length")
}

/** Backs `c.boundedJson`: `readBoundedBodyOrThrow` + `JSON.parse`, throwing a flat 400 on bad JSON. */
async function readBoundedJsonBodyOrThrow<T>(
  req: RequestSource,
  maxBodyBytes: number,
  maxBytes?: number,
): Promise<T> {
  const parsed = await readBoundedJsonSource(req, maxBytes ?? maxBodyBytes)
  if (parsed instanceof Response) throw parsed
  return parsed as T
}

/**
 * Read a JSON body with the same byte cap used by schema validation and `c.boundedJson`.
 * Non-chunked, framed requests with an in-cap `Content-Length` use the runtime-native `req.json()`;
 * chunked or length-less requests fall back to the streaming byte-cap guard.
 */
async function readBoundedJsonSource(
  req: RequestSource,
  maxBytes: number,
): Promise<unknown | Response> {
  const declared = headerOf(req, "content-length")
  if (declared !== null) {
    // A present Content-Length must be a non-negative integer (HTTP grammar: `1*DIGIT`). A
    // non-numeric / negative / fractional / exponential value (`Number()` would happily accept
    // "abc"→NaN, "-5", "1.5", "1e3", "0x10") is malformed → 400, rather than silently falling
    // through to the streaming guard — which is an UPPER-bound cap only, so a lying SMALLER length
    // would otherwise be read in full. Real HTTP servers only hand us a valid framed length; this
    // hardens hand-built Requests (tests, the in-process client) and crafted input.
    const length = parseContentLength(declared)
    if (length === undefined) return jsonError(400, "invalid_content_length")
    if (length > maxBytes) return jsonError(413, "payload_too_large")
    const chunked = headerOf(req, "transfer-encoding") !== null
    if (!chunked) {
      try {
        return await req.json()
      } catch {
        return jsonError(400, "invalid_json")
      }
    }
  }
  const body = req.body
  if (body === null) return jsonError(400, "invalid_json")
  const drained = await drainCapped(body, maxBytes)
  if (!drained.ok) return jsonError(413, "payload_too_large")
  try {
    return JSON.parse(TEXT_DECODER.decode(drained.bytes))
  } catch {
    return jsonError(400, "invalid_json")
  }
}

/** A fixed past instant for cookie deletion (`Expires`). A literal epoch — deterministic, unlike an
 * argless `new Date()`. */
const EPOCH = new Date(0)

/** Build the response headers init. The common path (no `c.set`) returns `undefined` so `Response`
 * gets no `headers` at all. Cookies force a `Headers` object — multiple `Set-Cookie`s can't live in a
 * `Record<string,string>` (the 2nd would overwrite the 1st), so they're `append`ed individually. */
function headersInit(set: CtxSet): Record<string, string> | Headers | undefined {
  const cookies = set._cookies
  if (cookies === undefined || cookies.length === 0) return set._headers
  const headers = new Headers(set._headers)
  for (const cookie of cookies) headers.append("set-cookie", cookie)
  return headers
}

// Keep the fast JSON respond path byte-identical to `Response.json` without probing it at module
// scope: workerd forbids `Response.json()` during startup. A shared `Headers` is safe to reuse
// across responses: the Response constructor copies `init.headers` into its own list.
const JSON_CT_HEADERS = new Headers({
  "content-type": "application/json;charset=utf-8",
})
const JSON_INIT_200: ResponseInit = { status: 200, headers: JSON_CT_HEADERS }

/** Fused-lane respond when the handler ran with NO context (so `c.set` can't exist): the fast
 * JSON respond directly, with `toResponse` + the empty controls as the exact-semantics fallback. */
function fusedRespondNoSet(result: unknown): Response {
  if (
    result !== undefined &&
    !(result instanceof Response) &&
    typeof result === "object" &&
    result !== null &&
    !isResponseResult(result)
  ) {
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) return new Response(body, JSON_INIT_200)
  }
  return toResponse(result as HandlerResult, EMPTY_RESPONSE_CONTROLS)
}

/** Fused-lane respond with a context: read `c.set` once; untouched (the common case) → the fast
 * JSON respond; touched → the generic `toResponse` with those controls (statuses, headers, cookies). */
function fusedRespond(result: unknown, ctx: RawContext): Response {
  const set = ctx[CONTEXT_SET]()
  if (set === undefined) return fusedRespondNoSet(result)
  return toResponse(result as HandlerResult, set)
}

function toResponse(result: HandlerResult, set: CtxSet): Response {
  if (isResponseResult(result)) {
    return appendCookiesToResponse(result.toResponse(), set)
  }
  if (result instanceof Response) {
    return appendCookiesToResponse(result, set)
  }
  const headers = headersInit(set)
  const status = set.status ?? (result === undefined ? 204 : 200)
  if (headers === undefined && result !== undefined) {
    // Fast respond (profiled ≈ −50 ns/req on every plain-JSON return): `JSON.stringify` + a
    // prebuilt init beats `Response.json`'s internal init handling. Output is byte-identical —
    // same body bytes, same probed content-type. `undefined` from stringify (a function/symbol
    // result) delegates to Response.json so its TypeError contract stays the single source.
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) {
      return new Response(
        body,
        status === 200 ? JSON_INIT_200 : { status, headers: JSON_CT_HEADERS },
      )
    }
  }
  const init: ResponseInit = headers === undefined ? { status } : { status, headers }
  return result === undefined ? new Response(null, init) : Response.json(result, init)
}

function appendCookiesToResponse(response: Response, set: CtxSet): Response {
  // A handler may queue cookies (`c.set.cookie` — e.g. a session cookie) AND return its own Response
  // (e.g. `redirect("/")` after login). Cookies accumulate additively, so append them to the
  // returned Response — otherwise the canonical set-session-then-redirect pattern would silently drop
  // the cookie. (Other `c.set` fields stay the returned Response's own concern.)
  const cookies = set._cookies
  if (cookies !== undefined && cookies.length > 0) {
    for (const cookie of cookies) response.headers.append("set-cookie", cookie)
  }
  return response
}

/**
 * What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes
 * to the socket directly (`kind: "json"` — status + headers + cookies + a pre-stringified body, **no**
 * undici `Response` built or drained), a marked buffered response body (`kind: "body"` — e.g.
 * @nifrajs/web's non-deferred SSR HTML), or a `Response` (`kind: "response"`) for everything else
 * (redirects, 404/405/errors, unmarked or streaming bodies). Internal to the nifra↔node bridge.
 */
export type NodeServeOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | {
      readonly kind: "json"
      readonly status: number
      /** `c.set.headers` backing, or `undefined` when the handler never set a header. */
      readonly headers: Readonly<Record<string, string>> | undefined
      /** Queued `Set-Cookie` lines, or `undefined`; the adapter emits one header line each. */
      readonly cookies: readonly string[] | undefined
      /** The JSON body already stringified, or `null` for an empty (204) response. */
      readonly body: string | null
    }
  | {
      readonly kind: "body"
      readonly status: number
      readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
      readonly body: string | Uint8Array
    }

/**
 * `finalize` for the node-direct path — mirror of {@link toResponse} that skips the `Response` build:
 * a plain value becomes pre-stringified JSON primitives (the adapter `JSON.stringify`s once, here, not
 * via `Response.json` + a body drain); a handler-returned `Response` is wrapped as-is, with queued
 * cookies appended exactly as `toResponse` does (so the set-cookie-then-`redirect()` pattern still
 * works on Node).
 */
function toNodeOutcome(result: HandlerResult, set: CtxSet): NodeServeOutcome {
  if (isResponseResult(result)) {
    const body = result.toNodeBody?.()
    if (body !== undefined) {
      return {
        kind: "body",
        status: body.status,
        headers: appendCookiesToNodeHeaders(body.headers, set._cookies),
        body: body.body,
      }
    }
    return nodeOutcomeFromResponse(appendCookiesToResponse(result.toResponse(), set))
  }
  if (result instanceof Response) {
    return nodeOutcomeFromResponse(appendCookiesToResponse(result, set))
  }
  const status = set.status ?? (result === undefined ? 204 : 200)
  return {
    kind: "json",
    status,
    headers: set._headers,
    cookies: set._cookies,
    body: result === undefined ? null : JSON.stringify(result),
  }
}

// Stable module-level finalizers so `fetch`/`resolveNode` allocate no per-request closures.
const IDENTITY_RESPONSE = (response: Response): Response => response
const RESPONSE_TIMEOUT = (): Response => jsonError(503, "request_timeout")
const NODE_RESPONSE_BODY = Symbol.for("nifra.response.body")
const NODE_FROM_RESPONSE = (response: Response): NodeServeOutcome =>
  nodeOutcomeFromResponse(response)
const NODE_TIMEOUT = (): NodeServeOutcome => ({
  kind: "response",
  response: jsonError(503, "request_timeout"),
})

function nodeOutcomeFromResponse(response: Response): NodeServeOutcome {
  const body = nodeResponseBody(response)
  return body === undefined
    ? { kind: "response", response }
    : { kind: "body", status: response.status, headers: responseHeadersForNode(response), body }
}

function nodeResponseBody(response: Response): string | Uint8Array | undefined {
  if (response.bodyUsed) return undefined
  const body = (response as { readonly [NODE_RESPONSE_BODY]?: unknown })[NODE_RESPONSE_BODY]
  return typeof body === "string" || body instanceof Uint8Array ? body : undefined
}

function responseHeadersForNode(
  response: Response,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  let headers: Record<string, string | readonly string[]> | undefined
  response.headers.forEach((value, key) => {
    headers ??= {}
    headers[key] = value
  })
  const setCookies = response.headers.getSetCookie?.()
  if (setCookies !== undefined && setCookies.length > 0) {
    headers ??= {}
    headers["set-cookie"] = setCookies
  }
  return headers
}

function appendCookiesToNodeHeaders(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
  cookies: readonly string[] | undefined,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  if (cookies === undefined || cookies.length === 0) return headers
  const out: Record<string, string | readonly string[]> =
    headers === undefined ? {} : { ...headers }
  const existing = out["set-cookie"]
  const setCookies =
    existing === undefined ? [] : typeof existing === "string" ? [existing] : [...existing]
  out["set-cookie"] = [...setCookies, ...cookies]
  return out
}

/**
 * The inline server. Routes are chainable and fully type-inferred. `derive`/
 * `decorate` extend the handler context (`Ctx`) for routes defined *after* them,
 * with full types; `Ctx` is server-only and never touches the client registry.
 *
 *   app.decorate("db", db).derive((c) => ({ user: auth(c) }))
 *      .get("/me", (c) => c.user)            // c.user + c.db are typed
 */
export class Server<R extends Registry = EmptyRegistry, Ctx = EmptyContext> {
  private readonly router: Router<RouteEntry>
  /** WebSocket routes, matched separately at upgrade time (a GET + `Upgrade: websocket`). */
  private readonly wsRouter: Router<WsEntry>
  private wsRouteCount: number
  /** In-process pub/sub backing `ws.subscribe(topic)` + `app.publish(topic, data)` (single-instance).
   * Created by the first `app.ws()` via the `@nifrajs/core/ws` runtime — `undefined` until then, so a
   * no-WebSocket app never constructs (or bundles) it. */
  private topics: TopicRegistry | undefined
  private readonly routeList: RouteDescriptor[]
  private readonly maxBodyBytes: number
  private readonly requestTimeoutMs: number
  private readonly gracefulSignals: boolean
  private readonly logger: Logger
  private bunServer: RunningServer | undefined
  private readonly derives: RawDerive[]
  private readonly decorations: Record<string, unknown>
  private readonly beforeHandleHooks: RawBeforeHandle[]
  private readonly afterHandleHooks: RawAfterHandle[]
  private readonly onErrorHooks: RawErrorHandler[]
  private readonly aroundHooks: RawAround[]
  private readonly onRequestHooks: RawOnRequest[]
  private readonly onResponseHooks: RawOnResponse[]
  private readonly responseRequests: WeakMap<Request, Request>
  /** Names of plugins/middleware already applied via `use` — for idempotent dedupe. */
  private readonly appliedPlugins: Set<string>

  constructor(options: ServerOptions = {}) {
    this.router = new Router<RouteEntry>()
    this.wsRouter = new Router<WsEntry>()
    this.wsRouteCount = 0
    this.topics = undefined
    this.routeList = []
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0
    this.gracefulSignals = options.gracefulSignals ?? false
    this.logger = options.logger ?? jsonLogger()
    this.bunServer = undefined
    this.derives = []
    this.decorations = {}
    this.beforeHandleHooks = []
    this.afterHandleHooks = []
    this.onErrorHooks = []
    this.aroundHooks = []
    this.onRequestHooks = []
    this.onResponseHooks = []
    this.responseRequests = new WeakMap()
    this.appliedPlugins = new Set()
  }

  /** Add a per-request, computed context extension for subsequent routes. */
  derive<D extends object>(fn: (context: Context & Ctx) => MaybePromise<D>): Server<R, Ctx & D> {
    this.derives.push(fn as unknown as RawDerive)
    return this as unknown as Server<R, Ctx & D>
  }

  /** Add a static context value for subsequent routes. */
  decorate<const K extends string, V>(key: K, value: V): Server<R, Ctx & Record<K, V>> {
    this.decorations[key] = value
    return this as unknown as Server<R, Ctx & Record<K, V>>
  }

  /**
   * Run before routing on the raw request. Return a `Response` to short-circuit, or a replacement
   * `Request` to continue routing with a rewritten method/URL/headers. Global.
   */
  onRequest(fn: (req: Request) => MaybePromise<OnRequestResult>): this {
    this.onRequestHooks.push(fn)
    return this
  }

  /** Run after validation, before the handler; a non-`undefined` return short-circuits. Order-scoped. */
  beforeHandle(fn: (context: Context & Ctx) => MaybePromise<unknown>): this {
    this.beforeHandleHooks.push(fn as unknown as RawBeforeHandle)
    return this
  }

  /**
   * Wrap the matched route lifecycle for subsequent routes. This is intentionally generic over the
   * route output, so wrappers like async context storage do not force Node's direct JSON path through
   * a Web `Response`. The first registered wrapper is outermost.
   */
  around(fn: <T>(context: Context & Ctx, next: () => MaybePromise<T>) => MaybePromise<T>): this {
    this.aroundHooks.push(fn as unknown as RawAround)
    return this
  }

  /** Transform the handler's result before it is serialized. Order-scoped. */
  afterHandle(fn: (result: unknown, context: Context & Ctx) => MaybePromise<unknown>): this {
    this.afterHandleHooks.push(fn as unknown as RawAfterHandle)
    return this
  }

  /** Handle a thrown error; a non-`undefined` return becomes the response (else the default 500). Order-scoped. */
  onError(fn: (error: unknown, context: Context & Ctx) => MaybePromise<unknown>): this {
    this.onErrorHooks.push(fn as unknown as RawErrorHandler)
    return this
  }

  /** Transform every outgoing response — success, error, 404, 405, short-circuit. Global. */
  onResponse(fn: (response: Response, req: Request) => MaybePromise<Response>): this {
    this.onResponseHooks.push(fn)
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
    if (typeof arg === "function") {
      const name = (arg as { pluginName?: string }).pluginName
      if (name !== undefined) {
        if (this.appliedPlugins.has(name)) return this // idempotent: already applied
        this.appliedPlugins.add(name)
      }
      return arg(this)
    }
    if (arg.name !== undefined) {
      if (this.appliedPlugins.has(arg.name)) return this
      this.appliedPlugins.add(arg.name)
    }
    if (arg.onRequest !== undefined) this.onRequest(arg.onRequest)
    if (arg.around !== undefined) this.around(arg.around)
    if (arg.beforeHandle !== undefined) this.beforeHandle(arg.beforeHandle)
    if (arg.afterHandle !== undefined) this.afterHandle(arg.afterHandle)
    if (arg.onResponse !== undefined) this.onResponse(arg.onResponse)
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
   * Register a **WebSocket** route. The connection upgrades on a `GET` to `path` carrying
   * `Upgrade: websocket`; the optional `handler.upgrade(c)` runs in the request context first and may
   * reject (return a `Response`) or seed per-connection `ws.data`. WebSockets are served by the
   * adapter (`listen()`, `@nifrajs/node`, `@nifrajs/deno`, `toFetchHandler`) — not by bare `app.fetch`, which
   * has no socket (a WS path through `app.fetch` is a normal HTTP response).
   *
   *   app.ws("/chat", { open: (ws) => ws.send("hi"), message: (ws, data) => ws.send(data) })
   */
  ws<Data = unknown, Schema extends StandardSchemaV1 | undefined = undefined>(
    path: string,
    handler: WebSocketHandler<Data, EnvOf<Ctx>, Schema>,
  ): this {
    // Boot-time guard: the WS runtime is a subpath (`@nifrajs/core/ws`) so no-WebSocket apps don't
    // bundle it. Registration is the loud, early failure point — never the first connection.
    const runtime = requireWsRuntime()
    this.topics ??= runtime.createTopics()
    // A `messageSchema` wraps `message` with validation once, here — every adapter then dispatches
    // already-validated, typed messages (Bun/Deno/Node/Workers) with no per-adapter code.
    this.wsRouter.add("GET", path, {
      handler: runtime.wrapHandler(handler as WebSocketHandler),
    })
    this.wsRouteCount += 1
    return this
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
    const bare =
      schema?.body === undefined &&
      schema?.query === undefined &&
      this.derives.length === 0 &&
      this.beforeHandleHooks.length === 0 &&
      this.afterHandleHooks.length === 0 &&
      this.onErrorHooks.length === 0
    const fusedWeb =
      bare && this.aroundHooks.length === 0
        ? this.buildFusedWeb(
            handler as unknown as InternalHandler,
            Object.keys(this.decorations).length > 0 ? { ...this.decorations } : undefined,
            isContextlessNoArgArrow(handler),
          )
        : undefined
    this.router.add(method, path, {
      // (context: never) => unknown -> InternalHandler: the framework invokes it
      // with the concrete RawContext the typed handler expects, so this is sound.
      handler: handler as unknown as InternalHandler,
      schema,
      fusedWeb,
      derives: [...this.derives],
      decorations: { ...this.decorations },
      hasDecorations: Object.keys(this.decorations).length > 0,
      beforeHandle: [...this.beforeHandleHooks],
      afterHandle: [...this.afterHandleHooks],
      onError: [...this.onErrorHooks],
      around: [...this.aroundHooks],
      // Sync-fast-path eligibility (see RouteEntry.bare). Validation + every hook kind must be absent;
      // decorations and generic around wrappers are fine: around wraps the inner bare route in
      // `routeAndRun`, while the inner validation/derive/before/after/onError lifecycle remains empty.
      // Most GET/no-schema routes qualify.
      bare,
      contextlessBare: bare && this.aroundHooks.length === 0 && isContextlessNoArgArrow(handler),
      bodyOnly:
        schema?.body !== undefined &&
        schema.query === undefined &&
        this.derives.length === 0 &&
        this.beforeHandleHooks.length === 0 &&
        this.afterHandleHooks.length === 0 &&
        this.onErrorHooks.length === 0,
      queryOnly:
        schema?.body === undefined &&
        schema?.query !== undefined &&
        this.derives.length === 0 &&
        this.beforeHandleHooks.length === 0 &&
        this.afterHandleHooks.length === 0 &&
        this.onErrorHooks.length === 0,
    })
    this.routeList.push({ method, path, schema })
  }

  /**
   * Enumerate the registered routes (method, path, input schemas), in registration
   * order. Powers `toOpenAPI` and other introspection; the router trie itself no
   * longer holds the original patterns.
   */
  routes(): ReadonlyArray<RouteDescriptor> {
    return this.routeList
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
    // Non-`async` on purpose: `dispatch` may return a `Response` *synchronously* (the bare-route fast
    // path, see RouteEntry.bare), and an `async fetch` would wrap every such result in a redundant
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
    if (this.onResponseHooks.length === 0) {
      return outcome
    }
    // onResponse sees every response — success, validation error, 404/405, timeout, onRequest
    // short-circuit; normalize to a promise, then thread through the hooks.
    return outcome instanceof Promise
      ? outcome.then((response) => this.applyOnResponse(response, this.takeResponseRequest(source)))
      : this.applyOnResponse(outcome, this.takeResponseRequest(source))
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
  ): MaybePromise<NodeServeOutcome> {
    // onResponse hooks transform a Response, so they force the Web path; wrap its result.
    if (this.onResponseHooks.length > 0) {
      const response = this.fetchSource(source, platform)
      return response instanceof Promise
        ? response.then((settled) => ({ kind: "response", response: settled }))
        : { kind: "response", response }
    }
    // May resolve **synchronously** for a bare route + sync handler (RouteEntry.bare) — the `@nifrajs/node`
    // adapter `await`s the result, so it transparently handles either; the sync case allocates no promise
    // at all on the Node hot path.
    return this.dispatch<NodeServeOutcome>(
      source,
      platform,
      toNodeOutcome,
      NODE_FROM_RESPONSE,
      NODE_TIMEOUT,
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
    const params = match.params === EMPTY_PARAMS ? EMPTY_PARAMS : decodeParams(match.params)
    if (params === null) return { kind: "reject", response: jsonError(400, "malformed_path") }
    const handler = match.payload.handler
    // Non-null: wsRouteCount > 0 ⇒ ws() ran ⇒ the runtime created the registry.
    const pubsub = this.topics as TopicRegistry
    // CSWSH guard, before any per-connection work or the user's upgrade(): reject a disallowed
    // Origin with 403. Browsers don't CORS-protect WS handshakes but do send cookies, so this
    // blocks cross-site authenticated sockets when the route opts in via `allowedOrigins`.
    if (handler.allowedOrigins !== undefined) {
      const origin = req.headers.get("origin")
      const allowed =
        typeof handler.allowedOrigins === "function"
          ? handler.allowedOrigins(origin)
          : origin !== null && handler.allowedOrigins.includes(origin)
      if (!allowed) return { kind: "reject", response: jsonError(403, "forbidden_origin") }
    }
    if (handler.upgrade === undefined) {
      return { kind: "upgrade", handler, data: undefined, pubsub }
    }
    const ctx = new RequestContext(
      req,
      params,
      url.search,
      getNeverAbortSignal(),
      platform,
      this.maxBodyBytes,
    )
    const settle = (value: unknown): WebSocketUpgradeOutcome =>
      value instanceof Response
        ? { kind: "reject", response: value }
        : { kind: "upgrade", handler, data: value, pubsub }
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
      if (o.kind === "pass") return this.fetch(req)
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
    // onRequest hooks may be async, so a hooked app takes the async path; with no hooks (the common
    // case) routing stays synchronous, letting a bare route resolve with no lifecycle promise at all.
    if (this.onRequestHooks.length === 0) {
      return this.routeAndRun(source, platform, finalize, wrapResponse, onTimeout, webFast)
    }
    return this.runWithOnRequest(source, platform, finalize, wrapResponse, onTimeout, webFast)
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
      const outcome = (hooks[i] as RawOnRequest)(requestOf(current))
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
      const outcome = (this.onRequestHooks[index] as RawOnRequest)(requestOf(current))
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
   * ({@link RouteEntry.bare}), so a sync handler produces its result with zero promise allocations;
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
    const match = this.router.find(source.method, url.pathname)
    if (!match.found) {
      if (match.reason === "method-not-allowed") {
        return wrapResponse(
          jsonError(405, "method_not_allowed", { Allow: match.allowed.join(", ") }),
        )
      }
      return wrapResponse(jsonError(404, "not_found"))
    }

    const params = match.params === EMPTY_PARAMS ? EMPTY_PARAMS : decodeParams(match.params)
    if (params === null) {
      return wrapResponse(jsonError(400, "malformed_path"))
    }

    const entry = match.payload
    // A per-request cancellation signal. Only allocate a real controller when a
    // timeout is armed; otherwise share a never-aborting signal so the (common)
    // no-timeout path pays nothing.
    let controller: AbortController | undefined
    let signal = getNeverAbortSignal()
    if (this.requestTimeoutMs > 0) {
      controller = new AbortController()
      signal = controller.signal
    }
    // A bare route runs synchronously (no schema/derives/hooks); everything else keeps the full async
    // lifecycle. `runBare` returns a value directly for a sync handler — no promise.
    let outcome: MaybePromise<T>
    if (webFast && entry.fusedWeb !== undefined) {
      // Fused Web lane (bare route, no around): one closure end to end. Sound cast — webFast is
      // passed only by the `fetch` path, where T = Response by construction.
      outcome = entry.fusedWeb(source, params, url.search, signal, platform) as MaybePromise<T>
    } else if (entry.contextlessBare) {
      outcome = this.runContextlessBare(
        entry,
        source,
        params,
        url.search,
        signal,
        platform,
        finalize,
        wrapResponse,
      )
    } else {
      // Build the context up front so `onError` always has it. Query, cookies, headers, and body helpers
      // stay lazy, but their accessors live on the prototype instead of allocating per-request closures.
      const ctx = new RequestContext(
        source,
        params,
        url.search,
        signal,
        platform,
        this.maxBodyBytes,
      )

      if (entry.around.length === 0) {
        outcome = entry.bare
          ? this.runBare(entry, ctx, finalize, wrapResponse)
          : entry.bodyOnly
            ? this.runBodyOnly(entry, source, ctx, finalize, wrapResponse)
            : entry.queryOnly
              ? this.runQueryOnly(entry, ctx, finalize, wrapResponse)
              : this.runLifecycle(entry, source, ctx, finalize, wrapResponse)
      } else {
        outcome = this.runWithAround(
          entry,
          ctx,
          () =>
            entry.bare
              ? this.runBare(entry, ctx, finalize, wrapResponse)
              : entry.bodyOnly
                ? this.runBodyOnly(entry, source, ctx, finalize, wrapResponse)
                : entry.queryOnly
                  ? this.runQueryOnly(entry, ctx, finalize, wrapResponse)
                  : this.runLifecycle(entry, source, ctx, finalize, wrapResponse),
          finalize,
          wrapResponse,
        )
      }
    }
    // The request timeout only bounds work that is actually pending — a synchronous (bare) result is
    // already complete and can't time out, so it's returned as-is (no 503 race, no promise).
    if (controller !== undefined && outcome instanceof Promise) {
      return this.withTimeout(outcome, controller, onTimeout)
    }
    return outcome
  }

  /** The narrowest bare route: a syntactic `() => ...` handler cannot observe the context argument, so
   * successful requests can skip allocating `RequestContext`. Errors still allocate one for logging. */
  private runContextlessBare<T>(
    entry: RouteEntry,
    source: RequestSource,
    params: Record<string, string>,
    search: string,
    signal: AbortSignal,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    let result: unknown
    try {
      result = (entry.handler as unknown as ContextlessHandler)()
    } catch (err) {
      return this.contextlessBareError(err, source, params, search, signal, platform, wrapResponse)
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => finalize(value, EMPTY_RESPONSE_CONTROLS),
        (err) =>
          this.contextlessBareError(err, source, params, search, signal, platform, wrapResponse),
      )
    }
    return finalize(result, EMPTY_RESPONSE_CONTROLS)
  }

  private contextlessBareError<T>(
    err: unknown,
    source: RequestSource,
    params: Record<string, string>,
    search: string,
    signal: AbortSignal,
    platform: Platform | undefined,
    wrapResponse: (response: Response) => T,
  ): T {
    if (err instanceof Response) return wrapResponse(err)
    const ctx = new RequestContext(source, params, search, signal, platform, this.maxBodyBytes)
    this.logRequestError(err, ctx)
    return wrapResponse(jsonError(500, "internal_error"))
  }

  /**
   * The synchronous fast path for a {@link RouteEntry.bare} route: apply static decorations, call the
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
   * Build a route's fused Web lane (see {@link RouteEntry.fusedWeb}). Composition happens once at
   * registration; the returned closure is what every request to the route runs. Behavior is
   * byte-identical to the generic `runBare`/`runContextlessBare` + `toResponse` pair — same
   * decoration order, same error routing (thrown `Response` = control flow; anything else logs and
   * 500s), same respond semantics (the lifecycle parity suite pins it).
   */
  private buildFusedWeb(
    handler: InternalHandler,
    decorations: Record<string, unknown> | undefined,
    contextless: boolean,
  ): FusedWebRunner {
    const maxBodyBytes = this.maxBodyBytes
    const logError = (err: unknown, ctx: RawContext): Response => {
      if (err instanceof Response) return err
      this.logRequestError(err, ctx)
      return jsonError(500, "internal_error")
    }
    if (contextless && decorations === undefined) {
      // `() => ...` can't observe the context — skip allocating one entirely (errors still build
      // one for the structured log, exactly like runContextlessBare).
      const contextlessHandler = handler as unknown as ContextlessHandler
      return (source, params, search, signal, platform) => {
        let result: unknown
        try {
          result = contextlessHandler()
        } catch (err) {
          return logError(
            err,
            new RequestContext(source, params, search, signal, platform, maxBodyBytes),
          )
        }
        if (result instanceof Promise) {
          return result.then(fusedRespondNoSet, (err) =>
            logError(
              err,
              new RequestContext(source, params, search, signal, platform, maxBodyBytes),
            ),
          )
        }
        return fusedRespondNoSet(result)
      }
    }
    return (source, params, search, signal, platform) => {
      const ctx = new RequestContext(source, params, search, signal, platform, maxBodyBytes)
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

  private applyBodyValidation<T>(
    entry: RouteEntry,
    result: StandardResult<unknown>,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T> {
    if (result.issues !== undefined) return wrapResponse(validationError(result.issues))
    ctx.body = result.value
    if (entry.hasDecorations) Object.assign(ctx, entry.decorations)
    const handlerOutput = entry.handler(ctx)
    return handlerOutput instanceof Promise
      ? handlerOutput.then((value) => finalize(value, responseSet(ctx)))
      : finalize(handlerOutput, responseSet(ctx))
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
    if (result.issues !== undefined) return wrapResponse(validationError(result.issues))
    ctx.query = result.value
    if (entry.hasDecorations) Object.assign(ctx, entry.decorations)
    const handlerOutput = entry.handler(ctx)
    return handlerOutput instanceof Promise
      ? handlerOutput.then(
          (value) => finalize(value, responseSet(ctx)),
          (err) => this.handleLifecycleError(entry, err, ctx, finalize, wrapResponse),
        )
      : finalize(handlerOutput, responseSet(ctx))
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
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(onTimeout())
      }, this.requestTimeoutMs)
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
      if (entry.schema?.body !== undefined) {
        const bodyError = await this.readAndValidateBody(source, entry.schema.body, ctx)
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
        if (result.issues !== undefined) return wrapResponse(validationError(result.issues))
        ctx.query = result.value
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
    schema: StandardSchemaV1,
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
    const validation = schema["~standard"].validate(parsed)
    const result = validation instanceof Promise ? await validation : validation
    if (result.issues !== undefined) return validationError(result.issues)
    ctx.body = result.value
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

  /**
   * Start a `Bun.serve` instance bound to `port` (use `0` for an ephemeral port).
   *
   * `reusePort` sets `SO_REUSEPORT` so **multiple processes can bind the same port** and the kernel
   * load-balances connections across them — the standard way to use every core (Bun is
   * single-threaded per process). Spawn one process per core, each calling
   * `app.listen(PORT, { reusePort: true })`; see `examples/cluster.ts`. Every process must opt in,
   * and all of them must be the same app. Linux balances ~evenly; macOS accepts the flag but may
   * favor one socket (fine for dev, measure on Linux for production numbers).
   */
  listen(port: number, options?: { readonly reusePort?: boolean }): RunningServer {
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
    // With WS routes, the dispatcher comes from the `@nifrajs/core/ws` runtime — non-null because
    // wsRouteCount > 0 means ws() ran, and ws() requires the runtime at registration.
    const wsHandlers =
      this.wsRouteCount === 0
        ? undefined
        : (getWsRuntime() as WsRuntime).bunHandlers(this.topics as TopicRegistry)
    const reusePort = options?.reusePort === true
    const running = (wsHandlers === undefined
      ? Bun.serve({ port, reusePort, fetch: (req: Request) => this.fetch(req) })
      : Bun.serve<BunWsData>({
          port,
          reusePort,
          fetch: (req, server) => this.bunFetchWithWebSocket(req, server),
          // Bun's `ServerWebSocket<BunWsData>` is runtime-compatible with the handlers' structural
          // `BunSocket` view (kept local so `Bun.*` types never leak into the published .d.ts); the
          // `unknown` params bridge a TS structural-variance quirk. Round-trip covered by websocket.test.ts.
          websocket: {
            open: (ws) => wsHandlers.open(ws),
            message: (ws, message) => wsHandlers.message(ws, message),
            close: (ws, code, reason) => wsHandlers.close(ws, code, reason),
          },
        })) as unknown as RunningServer
    this.bunServer = running
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
          // Non-null: an `upgrade` outcome only exists for an app with ws() routes, and ws()
          // requires the `@nifrajs/core/ws` runtime at registration.
          ;(getWsRuntime() as WsRuntime).attach(server, outcome.handler, outcome.data, {
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
