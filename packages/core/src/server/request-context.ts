/**
 * The runtime request context (`c`): the `RawContext` implementation the handler receives, its lazy
 * `c.set` response-controls backing, and the bounded body readers behind `c.boundedBody`/`c.boundedJson`.
 * Type-imports the kernel's spine (never its values) and pulls its primitives from `runtime-core`, so it
 * sits below the server module in the graph.
 */
import type { RequestBudget } from "../budget.ts"
import { drainCapped, parseContentLength, readBoundedBytes } from "./body.ts"
import type { Platform } from "./context.ts"
import { type CookieOptions, cookieNamePrefix, parseCookies, serializeCookie } from "./cookies.ts"
import { jsonError } from "./http.ts"
import { guardParsedValue, type ProtoPoisoning, parseJsonGuarded } from "./proto-guard.ts"
import { searchOf } from "./query.ts"
import {
  CONTEXT_SEARCH,
  CONTEXT_SET,
  fallbackWaitUntil,
  getNeverAbortSignal,
  getUnboundedRequestBudget,
  headerOf,
  PRE_DECODED_BODY,
  type PreDecodedBody,
  requestOf,
  TEXT_DECODER,
} from "./runtime-core.ts"
import type { CtxSet, RawContext, RequestSource } from "./server.ts"

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
    return requestOf(this.source)
  }

  get request(): Request {
    return requestOf(this.source)
  }

  header(name: string): string | null {
    return headerOf(this.source, name)
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
    return readBoundedJsonBodyOrThrow<T>(
      this.source,
      this.maxBodyBytes,
      this.protoPoisoning,
      maxBytes,
    )
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

/** Backs `c.boundedJson`: `readBoundedJsonSource`, throwing its flat 400/413 on failure. */
async function readBoundedJsonBodyOrThrow<T>(
  req: RequestSource,
  maxBodyBytes: number,
  protoPoisoning: ProtoPoisoning,
  maxBytes?: number,
): Promise<T> {
  const parsed = await readBoundedJsonSource(req, maxBytes ?? maxBodyBytes, protoPoisoning)
  if (parsed instanceof Response) throw parsed
  return parsed as T
}

/**
 * Read a JSON body with the same byte cap used by schema validation and `c.boundedJson`, then
 * parse it through the prototype-poisoning guard (`protoPoisoning`, default `"reject"` - a
 * poisoned payload answers the same flat 400 as malformed JSON). Non-chunked, framed requests
 * with an in-cap `Content-Length` use the runtime's native `json()` and guard the parsed value;
 * chunked or length-less requests fall back to the streaming byte-cap guard.
 */
export async function readBoundedJsonSource(
  req: RequestSource,
  maxBytes: number,
  protoPoisoning: ProtoPoisoning = "reject",
): Promise<unknown | Response> {
  // A pre-parsing hook (the transport-codec lane) may have decoded the body already - its stash
  // is taken verbatim: the stasher enforced its own byte cap and poisoning policy on text this
  // lane never sees. One symbol read; a miss on ordinary requests costs a cache-line, not a parse.
  const preDecoded = (req as { [PRE_DECODED_BODY]?: PreDecodedBody })[PRE_DECODED_BODY]
  if (preDecoded !== undefined) return preDecoded.value
  const declared = headerOf(req, "content-length")
  if (declared !== null) {
    // A present Content-Length must be a non-negative integer (HTTP grammar: `1*DIGIT`). A
    // non-numeric / negative / fractional / exponential value (`Number()` would happily accept
    // "abc"->NaN, "-5", "1.5", "1e3", "0x10") is malformed -> 400, rather than silently falling
    // through to the streaming guard - which is an UPPER-bound cap only, so a lying SMALLER length
    // would otherwise be read in full. Real HTTP servers only hand us a valid framed length; this
    // hardens hand-built Requests (tests, the in-process client) and crafted input.
    const length = parseContentLength(declared)
    if (length === undefined) return jsonError(400, "invalid_content_length")
    if (length > maxBytes) return jsonError(413, "payload_too_large")
    const chunked = headerOf(req, "transfer-encoding") !== null
    if (!chunked) {
      // Native `json()` keeps the runtime's fused decode+parse (measurably faster than
      // buffering + a JS-side parse); the guard then walks the PARSED value, which needs no raw
      // text - escapes are already resolved, so a `\u`-spelled `__proto__` is an own key like any
      // other. The byte-exact delivered-size re-check lives in `readBoundedBytes` (the raw-bytes
      // lane); here the declared length was already capped above and the runtime enforces framing.
      let parsed: unknown
      try {
        parsed = await req.json()
      } catch {
        return jsonError(400, "invalid_json")
      }
      try {
        return guardParsedValue(parsed, protoPoisoning)
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
    return parseJsonGuarded(TEXT_DECODER.decode(drained.bytes), protoPoisoning)
  } catch {
    return jsonError(400, "invalid_json")
  }
}
