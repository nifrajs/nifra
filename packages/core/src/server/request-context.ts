/**
 * The runtime request context (`c`): the `RawContext` implementation the handler receives, its lazy
 * `c.set` response-controls backing, and the bounded body readers behind `c.boundedBody`/`c.boundedJson`.
 * Type-imports the kernel's spine (never its values) and pulls its primitives from `runtime-core`, so it
 * sits below the server module in the graph.
 */
import type { RequestBudget } from "../budget.ts"
import { drainCapped, parseContentLength, readBoundedBytes } from "./body.ts"
import type { Platform } from "./context.ts"
import { type CookieOptions, parseCookies, serializeCookie } from "./cookies.ts"
import { jsonError } from "./http.ts"
import { searchOf } from "./query.ts"
import {
  CONTEXT_SEARCH,
  CONTEXT_SET,
  fallbackWaitUntil,
  getNeverAbortSignal,
  getUnboundedRequestBudget,
  headerOf,
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

/** Coerce `c.json`/`c.text`'s second arg - a status number (the common case) or a full `ResponseInit`. */
function statusInit(init?: ResponseInit | number): ResponseInit | undefined {
  return typeof init === "number" ? { status: init } : init
}

export class RequestContext implements RawContext {
  // `declare` keeps TypeScript's class-field emit from first writing `undefined` to every slot; the
  // constructor initializes only the eager request state, while lazy fields remain absent until used.
  declare readonly params: Record<string, string>
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

  constructor(source: RequestSource, params: Record<string, string>, maxBodyBytes: number)
  constructor(
    source: RequestSource,
    params: Record<string, string>,
    search: string | undefined,
    signal: AbortSignal,
    budget: RequestBudget,
    platform: Platform | undefined,
    maxBodyBytes: number,
  )
  constructor(
    source: RequestSource,
    params: Record<string, string>,
    searchOrMaxBodyBytes: string | number | undefined,
    signal?: AbortSignal,
    budget?: RequestBudget,
    platform?: Platform,
    maxBodyBytes?: number,
  ) {
    this.source = source
    this.params = params
    if (typeof searchOrMaxBodyBytes === "number") {
      this.maxBodyBytes = searchOrMaxBodyBytes
      return
    }
    if (searchOrMaxBodyBytes !== undefined) this.searchValue = searchOrMaxBodyBytes
    this.signalValue = signal
    this.budgetValue = budget
    if (platform !== undefined) this.platformValue = platform
    this.maxBodyBytes = maxBodyBytes as number
  }

  static native(
    source: RequestSource,
    params: Record<string, string>,
    maxBodyBytes: number,
  ): RequestContext {
    return new RequestContext(source, params, maxBodyBytes)
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

  get waitUntil(): (promise: Promise<unknown>) => void {
    return this.platformValue?.waitUntil ?? fallbackWaitUntil
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
export async function readBoundedJsonSource(
  req: RequestSource,
  maxBytes: number,
): Promise<unknown | Response> {
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
