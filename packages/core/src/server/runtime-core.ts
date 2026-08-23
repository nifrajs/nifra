/**
 * Runtime-core: the small primitives shared across the server's request/response modules - the context
 * symbols, the `ResponseResult` marker, the lazy never-abort signal / unbounded budget singletons, and
 * the request-source accessors. Kept in one leaf (it only type-imports the server's spine types, never
 * its values) so `request-context`, `respond`, `node-outcome`, and the kernel form a cycle-free graph.
 */
import { createUnboundedRequestBudget, type RequestBudget } from "../budget.ts"
import { NODE_BRIDGE_MARKER_KEYS } from "./bridge-markers.ts"
import type { CtxSet, RequestSource } from "./server.ts"

/** A handler returns a `Response` (used as-is) or any value (serialized to JSON). */
export type HandlerResult = Response | unknown

export const RESPONSE_RESULT = Symbol.for(NODE_BRIDGE_MARKER_KEYS.responseResult)
export const CONTEXT_SET = Symbol("nifra.context.set")
export const CONTEXT_SEARCH = Symbol("nifra.context.search")

/**
 * A transport codec (or other pre-parsing hook) that already decoded the body stashes the value
 * here on the replacement `RequestSource`; the JSON body lane takes it verbatim instead of
 * parsing again. Boxed so a decoded `undefined` stays distinguishable from "not present". The
 * stasher owns the poisoning guard for what it stashes - the body lane's own guard only covers
 * text the lane itself parses.
 */
export const PRE_DECODED_BODY = Symbol("nifra.body.preDecoded")

/** The stash shape under {@link PRE_DECODED_BODY}. */
export interface PreDecodedBody {
  readonly value: unknown
}

/**
 * A response described as plain data - the status, any headers of its own, and a body still in value
 * form. A `ResponseResult` carrying one is rendered on the SAME lane a handler's plain return takes:
 * `JSON.stringify` straight into the node writer's `kind: "json"` outcome, or the web lane's prebuilt
 * JSON init. No `Response` is constructed anywhere on the node path.
 *
 * That matters because building one is the dominant cost of answering early. Measured on the rig, one
 * server per shape, all five answering the same 401: `c.set.status` + a plain object 82802 req/s,
 * `beforeHandle` returning that same object 81819, `return new Response(...)` 49668, `throw new
 * Response(...)` 47505, the same throw from a `derive` 48746. The `Response` costs 40%; the throw
 * around it costs another 4%; unwinding a lifecycle stage instead of a handler costs nothing
 * measurable. So the fix for a slow rejection is not a faster throw - it is not allocating the
 * `Response`.
 */
export interface PlainRender {
  readonly status: number
  /** Headers belonging to this render. They win over anything the request left in `c.set.headers`. */
  readonly headers?: Readonly<Record<string, string>>
  /** The body as a value, serialized by the lane that renders it. `undefined` means no body. */
  readonly body: unknown
}

export interface ResponseResult {
  readonly [RESPONSE_RESULT]: true
  toResponse(): Response
  toNodeBody?(): {
    readonly status: number
    readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
    readonly body: string | Uint8Array
  }
  /** Present when this result can be rendered as plain data - see {@link PlainRender}. Every lane
   * checks it before `toNodeBody`/`toResponse`, so a carrier that has one never builds a `Response`. */
  readonly plain?: PlainRender
}

/**
 * Type-only metadata carried by {@link status}. The symbol is declared, not created, so this brand
 * adds no runtime property and no per-response allocation. It lets the registry distinguish a typed
 * early response from an ordinary handler value while preserving the existing ResponseResult marker.
 */
export declare const STATUS_RESPONSE_TYPE: unique symbol

/** A status-bearing response whose code and body remain visible to TypeScript. */
export interface StatusResponse<Code extends number = number, Body = unknown>
  extends ResponseResult {
  readonly [STATUS_RESPONSE_TYPE]: {
    readonly code: Code
    readonly body: Body
  }
}

export function isResponseResult(value: unknown): value is ResponseResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [RESPONSE_RESULT]?: unknown })[RESPONSE_RESULT] === true &&
    typeof (value as { readonly toResponse?: unknown }).toResponse === "function"
  )
}

/**
 * The headers a plain render ships: its own on top of whatever the request left in `c.set.headers`,
 * so an ambient header (a request id, say) survives an early exit the way it survives an ordinary
 * return, and a header named at the exit site still wins.
 *
 * Always a fresh object when the render has headers of its own: the node writers mutate the record
 * they are handed (content-type, content-length, cookies), and a `status(...)` value is commonly
 * hoisted to module scope and answered from on every request.
 */
export function plainRenderHeaders(
  plain: PlainRender,
  set: CtxSet,
): Record<string, string> | undefined {
  const own = plain.headers
  if (own === undefined) return set._headers
  return set._headers === undefined ? { ...own } : { ...set._headers, ...own }
}

/**
 * Finish the request here, with this status and body, without building a `Response`.
 *
 * Returned or thrown, from a handler or from any lifecycle stage:
 *
 * ```ts
 * app.derive((c) => {
 *   const user = sessionOf(c)
 *   if (user === undefined) return status(401, { error: "unauthorized" })
 *   return { user }
 * })
 * ```
 *
 * A `derive` is the reason this exists as a value rather than as a rule about `beforeHandle`: a
 * `beforeHandle` already short-circuits by returning a value, but a `derive`'s return IS the context
 * extension, so before this its only exit was `throw new Response(...)` - the most expensive way to
 * say 401 (see {@link PlainRender} for the measurements). Returning it is preferred; throwing it
 * carries the same cost as any other throw and stays supported so a guard helper called for effect
 * (`requireSession(c)`) can still end the request from inside a call it makes.
 *
 * The body is serialized by the lane that renders it, exactly like a handler's plain return, so the
 * response carries a `content-length` rather than falling to chunked, and queued cookies still apply.
 */
export function status<const Code extends number>(
  code: Code,
  body?: undefined,
  init?: { readonly headers?: Readonly<Record<string, string>> },
): StatusResponse<Code, undefined>
export function status<const Code extends number, const Body>(
  code: Code,
  body: Body,
  init?: { readonly headers?: Readonly<Record<string, string>> },
): StatusResponse<Code, Body>
export function status(
  code: number,
  body?: unknown,
  init?: { readonly headers?: Readonly<Record<string, string>> },
): StatusResponse<number, unknown> {
  // The range `Response` accepts, enforced HERE so the plain lane cannot outrun it. A plain render
  // is written straight to the socket by the Node adapter, where `writeHead` takes 100-999 - so a
  // status this rejects would otherwise ship on Node and throw on every Web runtime, from the same
  // code. One integer comparison against the value already in a register; the divergence it closes
  // is the kind that only shows up in the runtime an app did not test on.
  if (!Number.isInteger(code) || code < 200 || code > 599) {
    throw new RangeError(`[nifra] status(${String(code)}): HTTP status must be an integer 200-599`)
  }
  const headers = init?.headers
  const plain: PlainRender =
    headers === undefined ? { status: code, body } : { status: code, headers, body }
  return {
    [RESPONSE_RESULT]: true,
    plain,
    // Only the lanes that cannot take plain data reach this - an edge runtime handed the value by a
    // caller outside the server, say. Built on demand, never on the lanes that matter.
    toResponse(): Response {
      const headers: Record<string, string> = { ...init?.headers }
      if (body === undefined) return new Response(null, { status: code, headers })
      headers["content-type"] ??= "application/json;charset=utf-8"
      return new Response(JSON.stringify(body), { status: code, headers })
    },
  } as StatusResponse<number, unknown>
}

/** The concrete `Request` for a source - itself when a real `Request` was passed (the Web path), or the
 * lazily-built one (the Node adapter). A real `Request` IS a `RequestSource`, so no wrapper is allocated
 * on the Web hot path. */
export function requestOf(source: RequestSource): Request {
  return source.request ?? (source as unknown as Request)
}

/** Read one request header. `header()` answers authoritatively when the source implements it - its
 * `null` means ABSENT, not "ask `headers` instead". Falling through on `null` would materialize the
 * lazy sources' full `Headers` object on every absent-header probe (measured at ~4% of request CPU
 * on the Node POST lane, which checks `transfer-encoding` on every request). */
export function headerOf(source: RequestSource, name: string): string | null {
  return source.header !== undefined ? source.header(name) : source.headers.get(name)
}

/** Off-edge `waitUntil`: run the background work fire-and-forget, never leaking an unhandled
 * rejection. Edge runtimes pass their own (Workers `ctx.waitUntil`) via the platform arg. */
export const fallbackWaitUntil = (promise: Promise<unknown>): void => {
  void promise.catch(() => {})
}

// Finalization only reads `status`, `_headers`, and `_cookies`. The user-visible mutator methods
// live on `LazyResponseControls`, created by the `c.set` getter only when user code touches it.
export const EMPTY_RESPONSE_CONTROLS = Object.freeze({}) as CtxSet

export const TEXT_DECODER = new TextDecoder()

/**
 * Shared never-aborting signal for `ctx.signal` when no timeout is armed - created lazily and
 * cached. NOT a module-scope `new AbortController()`: edge runtimes (Cloudflare workerd) forbid
 * constructing one in global scope; the first request builds it inside the handler, then it's
 * reused at zero per-request cost.
 */
let neverAbortSignal: AbortSignal | undefined
let unboundedRequestBudget: RequestBudget | undefined
export const getNeverAbortSignal = (): AbortSignal => {
  neverAbortSignal ??= new AbortController().signal
  return neverAbortSignal
}
export const getUnboundedRequestBudget = (): RequestBudget => {
  unboundedRequestBudget ??= createUnboundedRequestBudget(getNeverAbortSignal())
  return unboundedRequestBudget
}
