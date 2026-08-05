/** Lazy Node-direct renderer seam. The base server retains the typed method but not its renderer. */

import type { Platform } from "./context.ts"
import type { NodeServeOutcome } from "./node-outcome.ts"
import type { CtxSet, MaybePromise } from "./server.ts"

/**
 * Allocation-light request view used by Node-native header middleware.
 *
 * Identity contract: within one request, the SAME object is passed to every `onNodeRequest` hook
 * and every `onNodeResponse` hook (the native lanes engage together - see the server's gate), so a
 * middleware may use it as a `WeakMap` key to carry per-request state from its request twin to its
 * response twin.
 */
export interface NodeRequestContext {
  readonly method: string
  readonly url: string
  readonly header: (name: string) => string | null
}

/**
 * The mutable, case-insensitive header surface a portable {@link ResponseHeadersHook} writes
 * through. Deliberately the subset of the Web `Headers` interface every runtime can satisfy
 * natively: on the Web paths the hook receives the response's own `Headers` object directly (which
 * structurally implements this), and on the Node direct-writer path it receives a thin view over
 * the outcome's plain header record - so ONE hook implementation is fast everywhere.
 */
export interface ResponseHeadersView {
  get(name: string): string | null
  has(name: string): boolean
  set(name: string, value: string): void
  append(name: string, value: string): void
  delete(name: string): void
}

/**
 * A portable header-only response hook - the recommended shape for response middleware that only
 * reads or writes headers (security headers, CORS reflection, cache directives, negotiation). It
 * runs on every runtime from one implementation: the server adapts it into the Web `onResponse`
 * walk AND the Node-native response lane, so registering one never forces the Node adapter off its
 * direct socket writer the way a full `onResponse(res: Response)` hook does. It cannot replace the
 * response or touch the body - middleware needing that keeps the full `onResponse` contract and
 * its cost.
 */
export type ResponseHeadersHook = (
  headers: ResponseHeadersView,
  req: NodeRequestContext,
  status: number,
) => MaybePromise<void>

/** Native equivalent of a paired `onRequest` hook. It may short-circuit, but cannot rewrite a request. */
export type NodeRequestHook = (
  request: NodeRequestContext,
  platform?: Platform,
) => MaybePromise<Response | undefined>

/**
 * Response view used by Node-direct middleware. Header hooks mutate `headers`; a BODY hook
 * (adapted from the portable `onResponseBody`) may replace `body` - the already-serialized bytes
 * the direct writer is about to send - and, through its structured replacement, the status
 * (an ETag 304 being the canonical case).
 */
export interface NodeResponseContext {
  /** Mutable ONLY through a body hook's replacement object (e.g. an ETag 304); header hooks read. */
  status: number
  headers: Record<string, string | readonly string[]> | undefined
  readonly cookies: readonly string[] | undefined
  /** The framework-serialized body bytes (`null` for a bodiless render). Replaceable by body hooks. */
  body: string | Uint8Array | null
}

/** A body hook's structured replacement: new bytes (or `null` to drop the body) and/or a status. */
export interface ResponseBodyReplacement {
  readonly body?: string | Uint8Array | null
  readonly status?: number
}

/**
 * A portable post-serialization body hook - the Fastify-`onSend`-shaped tier. The hook receives
 * the FINAL framework-serialized bytes plus the header view, and may return replacement bytes
 * (`undefined` keeps the body unchanged). It runs at the framework's cheapest point on every
 * runtime: the bytes are already resident before any Web `Response` exists, so no body stream is
 * ever drained. A handler-returned raw `Response` (a proxied fetch, SSE, streamed SSR) is SKIPPED
 * by definition - transforming those is exactly what the full `onResponse` contract is for.
 */
export type ResponseBodyHook = (
  body: string | Uint8Array,
  headers: ResponseHeadersView,
  req: NodeRequestContext,
  status: number,
) => MaybePromise<string | Uint8Array | ResponseBodyReplacement | undefined>

/** Native equivalent of a paired `onResponse` hook. It must preserve the Web hook's header semantics. */
export type NodeResponseHook = (
  response: NodeResponseContext,
  req: NodeRequestContext,
) => MaybePromise<void>

/** Find the actual stored key for `name` in a possibly mixed-case header record. */
function recordKeyOf(
  record: Record<string, string | readonly string[]>,
  name: string,
): string | undefined {
  if (name in record) return name
  const wanted = name.toLowerCase()
  if (wanted in record) return wanted
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return key
  }
  return undefined
}

/**
 * A {@link ResponseHeadersView} over a Node outcome's plain header record - the direct-writer
 * counterpart of handing a Web hook the response's `Headers`. Mutations write lowercase names (the
 * wire form every runtime emits) and reads are case-insensitive across whatever casing earlier
 * writers used; repeated values join with `", "` on read, matching `Headers.get`. A class with
 * prototype methods (not per-call closures), memoized per context, so a request running several
 * portable hooks allocates ONE small view total.
 */
class RecordHeadersView implements ResponseHeadersView {
  readonly #target: NodeResponseContext

  constructor(target: NodeResponseContext) {
    this.#target = target
  }

  #record(): Record<string, string | readonly string[]> {
    this.#target.headers ??= {}
    return this.#target.headers
  }

  get(name: string): string | null {
    const headers = this.#target.headers
    if (headers === undefined) return null
    const key = recordKeyOf(headers, name)
    if (key === undefined) return null
    const value = headers[key]
    return typeof value === "string" ? value : (value?.join(", ") ?? null)
  }

  has(name: string): boolean {
    const headers = this.#target.headers
    return headers !== undefined && recordKeyOf(headers, name) !== undefined
  }

  set(name: string, value: string): void {
    const headers = this.#record()
    const existing = recordKeyOf(headers, name)
    if (existing !== undefined) delete headers[existing]
    headers[name.toLowerCase()] = value
  }

  append(name: string, value: string): void {
    const headers = this.#record()
    const existing = recordKeyOf(headers, name)
    if (existing === undefined) {
      headers[name.toLowerCase()] = value
      return
    }
    const current = headers[existing]
    delete headers[existing]
    headers[name.toLowerCase()] =
      typeof current === "string" ? [current, value] : [...(current ?? []), value]
  }

  delete(name: string): void {
    const headers = this.#target.headers
    if (headers === undefined) return
    const key = recordKeyOf(headers, name)
    if (key !== undefined) delete headers[key]
  }
}

const RECORD_VIEW = Symbol("nifra.record-headers-view")

export function recordHeadersView(target: NodeResponseContext): ResponseHeadersView {
  const holder = target as NodeResponseContext & { [RECORD_VIEW]?: ResponseHeadersView }
  let view = holder[RECORD_VIEW]
  if (view === undefined) {
    view = new RecordHeadersView(target)
    holder[RECORD_VIEW] = view
  }
  return view
}

export interface NodeOutcomeRuntime {
  toOutcome(result: unknown, set: CtxSet): NodeServeOutcome
  /** Materialize a buffered outcome for a Web response hook without losing its direct-write marker. */
  toResponse(outcome: NodeServeOutcome): Response
  fromResponse(response: Response): NodeServeOutcome
  timeout(): NodeServeOutcome
  /** The `Content-Type` this runtime's json render writes implicitly. The native hook walk
   * materializes it into the hook-visible header record so a body hook's content-type checks see
   * what will actually ship (the writer's own value - the wire is unchanged). */
  readonly jsonContentType?: string
}
