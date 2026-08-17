/**
 * Edge kit - the moat-neutral free functions a compact fetch-handler server needs to enforce the
 * SAME request trust boundary the full `Server` does, without pulling in the full builder.
 *
 * A minimal edge entrypoint (`@nifrajs/edge`) is not allowed to re-derive the body lane: the assembly
 * order of the content-type dispatch, the bounded read, the Content-Length pre-reject, and the
 * prototype-poisoning guard is a security contract, and a second copy of it would drift. This subpath
 * exposes the one lane the fused body runner already calls, so a compact server reuses it verbatim:
 *
 *   - {@link readBodyFramed}   read + cap + proto-guard + content-type framing (JSON / urlencoded / 415)
 *   - {@link toResponse}       render a {@link ResponseResult} (e.g. a 413 / 415 rejection) to a `Response`
 *   - {@link plainError}       the structured rejection envelope the lane returns
 *   - {@link queryObjectOf} / {@link searchOf}   query parse without a full WHATWG URL construction
 *
 * Everything here carries only structure - bytes, guards, and envelopes - never routing, lifecycle,
 * or app state. It is the interface, not the framework.
 */

export { plainError } from "./server/http.ts"
export type { ProtoPoisoning } from "./server/proto-guard.ts"
export { type QueryValue, queryObjectOf, searchOf } from "./server/query.ts"
export { readBodyFramed } from "./server/request-context.ts"
export { toResponse } from "./server/respond.ts"
export type { ResponseResult } from "./server/runtime-core.ts"
export { EMPTY_RESPONSE_CONTROLS } from "./server/runtime-core.ts"
export type { CtxSet, MaybePromise, RequestSource } from "./server/server.ts"
