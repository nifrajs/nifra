/**
 * Runtime-core: the small primitives shared across the server's request/response modules - the context
 * symbols, the `ResponseResult` marker, the lazy never-abort signal / unbounded budget singletons, and
 * the request-source accessors. Kept in one leaf (it only type-imports the server's spine types, never
 * its values) so `request-context`, `respond`, `node-outcome`, and the kernel form a cycle-free graph.
 */
import { createUnboundedRequestBudget, type RequestBudget } from "../budget.ts"
import type { CtxSet, RequestSource } from "./server.ts"

/** A handler returns a `Response` (used as-is) or any value (serialized to JSON). */
export type HandlerResult = Response | unknown

export const RESPONSE_RESULT = Symbol.for("nifra.response.result")
export const CONTEXT_SET = Symbol("nifra.context.set")
export const CONTEXT_SEARCH = Symbol("nifra.context.search")

export interface ResponseResult {
  readonly [RESPONSE_RESULT]: true
  toResponse(): Response
  toNodeBody?(): {
    readonly status: number
    readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
    readonly body: string | Uint8Array
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

/** The concrete `Request` for a source - itself when a real `Request` was passed (the Web path), or the
 * lazily-built one (the Node adapter). A real `Request` IS a `RequestSource`, so no wrapper is allocated
 * on the Web hot path. */
export function requestOf(source: RequestSource): Request {
  return source.request ?? (source as unknown as Request)
}

export function headerOf(source: RequestSource, name: string): string | null {
  return source.header?.(name) ?? source.headers.get(name)
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
