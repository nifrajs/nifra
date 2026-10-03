/**
 * The bare lane's ERROR rendering, as free functions the kernel delegates to.
 *
 * ## Why this is a lane module and not methods on `Server`
 *
 * These are the cold half of the bare request lane: what happens when a handler (or a `derive`)
 * throws, rather than returns. The success half stays on the class - it reads request-lifecycle
 * state and is the async-frame-skip hot path - but the error half needs none of that class state:
 * `renderBareError` is pure control-flow routing, and `emitRequestErrorLog` needs only the logger
 * and the detail policy, both of which are config fixed at construction. Passing those two in keeps
 * this file free of any runtime dependency back on `server.ts`, so there is no import cycle: the
 * `RawContext`/`CtxSet` imports are type-only and erased (the same shape `edge.ts` already relies on).
 *
 * A single source of truth for the thrown-value contract matters because it is a security surface:
 * an unhandled throw must render as a 500 with no caller-controlled body, and the amount of the
 * error's own text that reaches the log sink is the app's `errorLogDetail` call, not an accident of
 * which lane caught it. Both the generic bare lane and the fused body runner route here, so that
 * decision lives in exactly one place.
 */
import { pathnameOf } from "./http.ts"
import type { Logger } from "./logger.ts"
import { isResponseResult } from "./runtime-core.ts"
import type { CtxSet, RawContext } from "./server.ts"

/** How much of a thrown error's own text reaches the log sink. Mirrors `Server`'s option. */
export type ErrorLogDetail = "full" | "message" | "none"

/**
 * Render a value thrown on the bare lane. Two shapes, in the order the lane means them:
 *   - a `Response` or a `status(...)` is control flow - the app answering directly, or plain data.
 *     Either renders through the same `finalize` a RETURNED one takes, with the request's `c.set`,
 *     so a thrown one means what the return means: a `Response` ships as built, plus the cookies the
 *     request queued (the set-session-then-`throw redirect()` pattern);
 *   - anything else is a real fault: logged once, then a bodyless 500 (never the caller's error text).
 *
 * `responseSet` and `logError` are injected rather than imported so this file keeps no runtime edge
 * back to `server.ts` (`responseSet` reaches into the context's set symbol; `logError` closes over the
 * server's logger). Both run only on the throw path, so the closures cost nothing on the hot lane.
 */
export function renderBareError<T>(
  err: unknown,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx: RawContext) => T,
  responseSet: (ctx: RawContext) => CtxSet,
  logError: (err: unknown, ctx: RawContext) => void,
  internalError: () => T,
): T {
  if (err instanceof Response || isResponseResult(err)) return finalize(err, responseSet(ctx), ctx)
  logError(err, ctx)
  return internalError()
}

/**
 * Write an unhandled request error to the log. An error's own text can quote the input that produced
 * it, so how much of it reaches the sink is the app's call (`detail`). The default keeps it: a 500
 * with no message and no stack is an incident nobody can diagnose, and the framework already ships
 * the narrower instrument for the leak - a redacting logger with `valuePatterns`. `"none"` is there
 * for an untrusted sink.
 */
export function emitRequestErrorLog(
  logger: Logger,
  detail: ErrorLogDetail,
  err: unknown,
  // Only the request line is read, so a lane with no context yet (a request no route matched) can
  // log through the same policy.
  // Absent for a failure the runtime reports without its request (Bun's serve `error` callback).
  ctx: { readonly req: { readonly method: string; readonly url: string } } | undefined,
): void {
  logger.error("unhandled request error", {
    ...(ctx === undefined ? {} : { method: ctx.req.method, path: pathnameOf(ctx.req.url) }),
    name: err instanceof Error ? err.name : "Error",
    // `detail`, not `message`: the logger uses `message` for its own first argument, so a field of
    // that name is silently overwritten and the thrown error's own text never reaches the sink. It
    // survived only incidentally inside `stack`, and was lost outright for a non-Error throw.
    ...(detail === "none" ? {} : { detail: err instanceof Error ? err.message : String(err) }),
    ...(detail === "full" && err instanceof Error ? { stack: err.stack } : {}),
  })
}
