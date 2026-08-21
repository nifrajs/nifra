/**
 * The runtime request context (`c`): the `RawContext` implementation the handler receives, its lazy
 * `c.set` response-controls backing, and the bounded body readers behind `c.boundedBody`/`c.boundedJson`.
 * Type-imports the kernel's spine (never its values) and pulls its primitives from `runtime-core`, so it
 * sits below the server module in the graph.
 */
import type { RequestBudget } from "../budget.ts"
import { applyTransportCap, readBoundedBytes } from "./body.ts"
import { readBoundedJsonSource } from "./body-lane.ts"
import type { Platform } from "./context.ts"
import { type CookieOptions, cookieNamePrefix, parseCookies, serializeCookie } from "./cookies.ts"
import { headerObjectOf } from "./headers.ts"
import { plainError } from "./http.ts"
import type { ProtoPoisoning } from "./proto-guard.ts"
import { searchOf } from "./query.ts"
import { responseJsonContentType } from "./respond.ts"
import {
  CONTEXT_SEARCH,
  CONTEXT_SET,
  fallbackWaitUntil,
  getNeverAbortSignal,
  getUnboundedRequestBudget,
  headerOf,
  isResponseResult,
  requestOf,
} from "./runtime-core.ts"
import type { CtxSet, RawContext, RequestSource } from "./server.ts"

export { readBodyFramed, readBoundedJsonSource } from "./body-lane.ts"

/** A fixed past instant for cookie deletion (`Expires`). A literal epoch - deterministic, unlike an
 * argless `new Date()`. */
const EPOCH = new Date(0)

class LazyResponseControls implements CtxSet {
  status?: number
  _headers?: Record<string, string>
  _cookies?: string[]

  get headers(): Record<string, string> {
    // A plain literal record on purpose: values here are strings, and assigning a STRING through
    // the inherited `__proto__` setter is a silent no-op by spec - it cannot mutate the record's
    // prototype - so a literal object is not pollutable through header writes. The trade is that a
    // header literally named "__proto__" is dropped rather than stored (the sinks that accept
    // attacker-influenced names guard that name explicitly); in exchange the record stays in V8's
    // fast property mode, which a null-prototype object never enters - measured at ~2% of
    // throughput on a realistic middleware route on BOTH V8 and JSC.
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
    // A prefixed name gets Secure on the deletion write too - the browser holds the deletion
    // Set-Cookie to the same prefix contract as the original, and rejects it without.
    this._cookies ??= []
    const base = { path: "/", ...options, maxAge: 0, expires: EPOCH }
    this._cookies.push(
      serializeCookie(
        name,
        "",
        cookieNamePrefix(name) !== undefined ? { ...base, secure: true } : base,
      ),
    )
  }
}

/** Coerce `c.json`/`c.text`'s second arg - a status number (the common case) or a full `ResponseInit`. */
function statusInit(init?: ResponseInit | number): ResponseInit | undefined {
  return typeof init === "number" ? { status: init } : init
}

/**
 * Whether a body built here should be deferred instead of turned into a `Response` on the spot.
 *
 * Only the Node bridge can use a deferred body: it writes status + headers + bytes straight to the
 * socket, so the undici `Response` those two helpers used to build (~2us, about a quarter of the
 * request budget on a small text response) was pure loss. Bun and Deno hand the `Response` to their
 * native server, where nothing reads the deferral. Probed once at module load, not per response.
 */
const DEFERS_RESPONSE =
  typeof (globalThis as { Deno?: unknown }).Deno === "undefined" &&
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined" &&
  typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node ===
    "string"

/**
 * The Node adapter's deferred-response factory, received over the shared-symbol seam rather than a
 * package import - `@nifrajs/node` stays dependency-free from core's runtime and talks to it only
 * through `Symbol.for` marks, so the stand-in it builds (and the ~0.4 KB gzip the class costs) never
 * ships in a Bun/Deno bundle that will never run this branch. `c.json`/`c.text` route the Node fast
 * lane through it: given a status, an owned header record, and the bytes, it returns a `Response`-shaped
 * value the bridge writes straight to the socket (no undici `Response` built, no body stream drained).
 * Absent - no adapter loaded - the two helpers fall back to a real `Response`. Cached on first read;
 * the adapter registers at its own module load, before any request reaches a handler.
 */
const DEFERRED_RESPONDER_KEY = Symbol.for("nifra.deferred.responder")
type DeferredResponder = (body: string, status: number, headers: Record<string, string>) => Response
let deferredResponder: DeferredResponder | undefined
function deferredResponderFor(): DeferredResponder | undefined {
  if (deferredResponder === undefined) {
    deferredResponder = (globalThis as unknown as Record<symbol, DeferredResponder | undefined>)[
      DEFERRED_RESPONDER_KEY
    ]
  }
  return deferredResponder
}

/**
 * A header record the deferred response can own outright - a fresh object with lowercase names, since
 * the Node writer mutates it in place to declare `content-length`. `undefined` means the caller's
 * shape (a `Headers`, an entries array) is not worth walking here: those take the `Response` path.
 */
function ownHeaderRecord(
  // `unknown`: the lib's `ResponseInit.headers` is a runtime-specific `HeadersInit` (Bun's vs
  // undici's differ), and this only needs to recognize the plain-record case anyway.
  headers: unknown,
  contentType: string,
): Record<string, string> | undefined {
  if (headers === undefined) return { "content-type": contentType }
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return undefined
  if (headers instanceof Headers) return undefined
  const record: Record<string, string> = {}
  let hasContentType = false
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower === "content-type") hasContentType = true
    record[lower] = (headers as Record<string, string>)[name] as string
  }
  if (!hasContentType) record["content-type"] = contentType
  return record
}

/** The content-type the runtime's own `Response` puts on a string body, read off it once. A deferred
 * text response fills it in itself, so it must fill in exactly what the `Response` would have. */
let stringBodyContentType: string | undefined
function responseTextContentType(): string {
  stringBodyContentType ??=
    new Response("").headers.get("content-type") ?? "text/plain;charset=UTF-8"
  return stringBodyContentType
}

/** `c.text`'s own default, unchanged: the explicit one nifra has always declared when the caller
 * passes no headers of their own. */
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"

export class RequestContext implements RawContext {
  // `declare` keeps TypeScript's class-field emit from first writing `undefined` to every slot; the
  // constructor initializes only the eager request state, while lazy fields remain absent until used.
  // Not `readonly`: the lifecycle replaces it with the validated/coerced value when a `params` schema is
  // declared (`c.params` stays `readonly` to handlers via the `Context` interface).
  declare params: Record<string, string>
  declare body: unknown
  private declare searchValue: string | undefined
  private declare signalValue: AbortSignal | undefined
  private declare budgetValue: RequestBudget | undefined
  private declare platformValue: Platform | undefined

  private declare setValue: CtxSet | undefined
  private declare queryValue: unknown
  private declare queryReady: boolean
  private declare headersValue: Record<string, string> | undefined
  private declare cookiesValue: Readonly<Record<string, string>> | undefined
  private declare readonly source: RequestSource
  private declare readonly maxBodyBytes: number
  private declare readonly protoPoisoning: ProtoPoisoning

  constructor(
    source: RequestSource,
    params: Record<string, string>,
    maxBodyBytes: number,
    protoPoisoning?: ProtoPoisoning,
  )
  constructor(
    source: RequestSource,
    params: Record<string, string>,
    search: string | undefined,
    signal: AbortSignal,
    budget: RequestBudget,
    platform: Platform | undefined,
    maxBodyBytes: number,
    protoPoisoning?: ProtoPoisoning,
  )
  constructor(
    source: RequestSource,
    params: Record<string, string>,
    searchOrMaxBodyBytes: string | number | undefined,
    signalOrProtoPoisoning?: AbortSignal | ProtoPoisoning,
    budget?: RequestBudget,
    platform?: Platform,
    maxBodyBytes?: number,
    protoPoisoning?: ProtoPoisoning,
  ) {
    this.source = source
    this.params = params
    if (typeof searchOrMaxBodyBytes === "number") {
      this.maxBodyBytes = searchOrMaxBodyBytes
      this.protoPoisoning =
        typeof signalOrProtoPoisoning === "string" ? signalOrProtoPoisoning : "reject"
      return
    }
    if (searchOrMaxBodyBytes !== undefined) this.searchValue = searchOrMaxBodyBytes
    this.signalValue = signalOrProtoPoisoning as AbortSignal | undefined
    this.budgetValue = budget
    if (platform !== undefined) this.platformValue = platform
    this.maxBodyBytes = maxBodyBytes as number
    this.protoPoisoning = protoPoisoning ?? "reject"
  }

  /**
   * The no-timeout context: `c.signal`/`c.budget` fall back to the never-abort signal and the
   * unbounded budget, which is exactly what the request would have been handed, so the two slots
   * are left unwritten instead of initialized. `search` carries the router's already-split query
   * string when it has one; `undefined` leaves `c.query` to re-scan the URL lazily.
   */
  static native(
    source: RequestSource,
    params: Record<string, string>,
    search: string | undefined,
    maxBodyBytes: number,
    platform?: Platform,
    protoPoisoning?: ProtoPoisoning,
  ): RequestContext {
    const context = new RequestContext(source, params, maxBodyBytes, protoPoisoning)
    if (search !== undefined) context.searchValue = search
    if (platform !== undefined) context.platformValue = platform
    return context
  }

  [CONTEXT_SET](): CtxSet | undefined {
    return this.setValue
  }

  get [CONTEXT_SEARCH](): string {
    this.searchValue ??= searchOf(this.source.url)
    return this.searchValue
  }

  get set(): CtxSet {
    this.setValue ??= new LazyResponseControls()
    return this.setValue
  }

  get signal(): AbortSignal {
    return this.signalValue ?? getNeverAbortSignal()
  }

  get budget(): RequestBudget {
    return this.budgetValue ?? getUnboundedRequestBudget()
  }

  get env(): unknown {
    return this.platformValue?.env
  }

  get clientIp(): string | undefined {
    // The server resolves the trust declaration into `platform.clientIp` before the context is built,
    // so this getter just surfaces the already-derived value (raw socket peer by default).
    return this.platformValue?.clientIp
  }

  get waitUntil(): (promise: Promise<unknown>) => void {
    return this.platformValue?.waitUntil ?? fallbackWaitUntil
  }

  get req(): Request {
    // A dispatcher-marked source gets its route's transport byte cap applied here - at the moment
    // user code reaches for the request - so routes that never direct-read the body pay nothing.
    const request = requestOf(this.source)
    applyTransportCap(this.source, request)
    return request
  }

  get request(): Request {
    const request = requestOf(this.source)
    applyTransportCap(this.source, request)
    return request
  }

  header(name: string): string | null {
    return headerOf(this.source, name)
  }

  get headers(): Record<string, string> {
    this.headersValue ??= headerObjectOf(this.source.headers)
    return this.headersValue
  }

  set headers(value: Record<string, string>) {
    this.headersValue = value
  }

  /**
   * Return a JSON body. Prefer this (and {@link text}) over a hand-rolled `return new Response(...)`:
   * on Node these helpers hand the adapter a status, a header record, and the bytes directly, so the
   * Web `Response` is deferred and the reply lands on the fastest write lane. A raw `new Response` is
   * fully supported and returns identical bytes, but it is the last-resort lane - the adapter has to
   * drain its body stream, which no direct-write helper pays.
   */
  json(body: unknown, init?: ResponseInit | number): Response {
    const i = statusInit(init)
    if (!DEFERS_RESPONSE) return Response.json(body, i)
    const defer = deferredResponderFor()
    if (defer === undefined) return Response.json(body, i)
    // The same bytes `Response.json` would produce, kept one step short of it so the direct writer
    // can have them. `JSON.stringify` returns `undefined` for a value with no JSON form (`undefined`,
    // a function, a symbol) - exactly the case where `Response.json` throws, so hand it back the
    // throw rather than inventing a body. The content-type is the runtime's own, read off
    // `Response.json` once, so a deferred response carries the same one byte for byte.
    const text = JSON.stringify(body) as string | undefined
    if (text === undefined) return Response.json(body, i)
    const headers = ownHeaderRecord(i?.headers, responseJsonContentType())
    if (headers === undefined) return Response.json(body, i)
    return defer(text, i?.status ?? 200, headers)
  }

  /**
   * Return a text body. The fast lane on Node - see {@link json}. Reach for a raw `return new
   * Response(body)` only when you need a Response shape these helpers do not build; it costs the
   * adapter a body-stream drain that this path skips.
   */
  text(body: string, init?: ResponseInit | number): Response {
    const i = statusInit(init)
    if (DEFERS_RESPONSE) {
      const defer = deferredResponderFor()
      if (defer !== undefined) {
        // The content-type each shape would have ended up with: nifra's declared default when the
        // caller brought no headers, the runtime's own string-body default when they did (there the
        // caller owns the content-type, and only fills in for one they did not set).
        const headers = ownHeaderRecord(
          i?.headers,
          i?.headers === undefined ? TEXT_CONTENT_TYPE : responseTextContentType(),
        )
        if (headers !== undefined) return defer(body, i?.status ?? 200, headers)
      }
    }
    // Default to text/plain; if the caller passes their own headers, they own the content-type.
    if (i?.headers !== undefined) return new Response(body, i)
    return new Response(body, { ...i, headers: { "content-type": TEXT_CONTENT_TYPE } })
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
    return readBoundedJsonBodyOrThrow<T>(
      this.source,
      this.maxBodyBytes,
      this.protoPoisoning,
      maxBytes,
    )
  }
}

/** Backs `c.boundedBody`: bounded byte read that throws a flat 413/400 plain render (caught by
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
    ? plainError(413, "payload_too_large")
    : plainError(400, "invalid_content_length")
}

/** Backs `c.boundedJson`: `readBoundedJsonSource`, throwing its flat 400/413 on failure. */
async function readBoundedJsonBodyOrThrow<T>(
  req: RequestSource,
  maxBodyBytes: number,
  protoPoisoning: ProtoPoisoning,
  maxBytes?: number,
): Promise<T> {
  const parsed = await readBoundedJsonSource(req, maxBytes ?? maxBodyBytes, protoPoisoning)
  // The lane's own failures are the only branded values it can produce: a parsed JSON body is
  // `JSON.parse` output, which carries string keys only and so can never answer to a symbol brand.
  if (isResponseResult(parsed)) throw parsed
  return parsed as T
}

/**
 * Read a JSON body with the same byte cap used by schema validation and `c.boundedJson`, then
 * parse it through the prototype-poisoning guard (`protoPoisoning`, default `"reject"` - a
 * poisoned payload answers the same flat 400 as malformed JSON). Non-chunked, framed requests
 * with an in-cap `Content-Length` take the runtime's fused `json()` and walk the parsed value;
 * chunked or length-less requests fall back to the streaming byte-cap guard.
 */
