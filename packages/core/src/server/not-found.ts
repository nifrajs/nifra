/**
 * The `notFound()` handler's rules:
 * - Only for a `404`: a wrong method stays a `405`, a malformed path a `400`, a mount's `404` its own.
 * - It sees the request line and headers, never the body: an unrouted request has no body limit.
 * - A method token no route could take gets the default `404`, as it skips `onRequest` hooks.
 * - A `2xx` is sent as a `404`; a `3xx`, `410` or other error status is sent as built.
 * - Fails closed: a throw or an unsendable value is logged and answered with the plain `500`.
 */
import { type ErrorLogDetail, emitRequestErrorLog } from "./bare-error-lane.ts"
import type { Platform } from "./context.ts"
import { plainError } from "./http.ts"
import { INSTALL_NOT_FOUND } from "./install.ts"
import type { Logger } from "./logger.ts"
import {
  answerNotFound,
  type NotFoundHandler,
  type NotFoundLane,
  notFoundInput,
} from "./not-found-answer.ts"
import type { IdentityPlugin } from "./plugin.ts"
import type { ResponseResult } from "./runtime-core.ts"
import type { AnyServer, MaybePromise, RequestSource } from "./server.ts"

export type { NotFoundHandler, NotFoundInput } from "./not-found-answer.ts"

/** The kernel state the lane reads. Fixed at construction, so reading it per miss is three loads. */
interface NotFoundHost {
  readonly requestTimeoutMs: number
  readonly logger: Logger
  readonly errorLogDetail: ErrorLogDetail
}

/** The install seam a server exposes so the `notFound()` plugin can hand it the lane. */
interface NotFoundInstallable {
  [INSTALL_NOT_FOUND](lane: NotFoundLane): void
  readonly notFoundLane?: NotFoundLane
  readonly routePrefix: string
}

/**
 * Answer requests no route matched with a handler of your own: `app.use(notFound(handler))`.
 *
 * ```ts
 * import { notFound } from "@nifrajs/core/not-found"
 *
 * const app = server().use(
 *   notFound(({ pathname }) => Response.json({ ok: false, error: "no_such_route", pathname })),
 * )
 * ```
 *
 * The answer is a `404` whatever `2xx` status the handler gives it; see the module notes for the
 * full rules. The server's `requestTimeoutMs` bounds an async handler and aborts `input.signal`.
 *
 * A server takes one handler, and it belongs to the server that listens: applying `notFound()` a
 * second time throws, and so does applying it inside a `group()` (a miss has no prefix to scope it
 * to). A server composed into another with `merge()` does not carry its handler along.
 */
export function notFound<Env = unknown>(handler: NotFoundHandler<Env>): IdentityPlugin {
  if (typeof handler !== "function") throw new TypeError("notFound() needs a handler function")
  const lane: NotFoundLane = <T>(
    host: unknown,
    source: RequestSource,
    pathname: string,
    platform: Platform<unknown> | undefined,
    wrap: (response: Response | ResponseResult) => T,
    onTimeout: () => T,
  ): MaybePromise<T> => {
    const { requestTimeoutMs, logger, errorLogDetail } = host as NotFoundHost
    const env = platform as Platform<Env> | undefined
    const failed = (error: unknown): T => {
      // A logger that throws must not decide the answer: the fault is still the plain `500`.
      try {
        emitRequestErrorLog(logger, errorLogDetail, error, { req: source })
      } catch {}
      return wrap(plainError(500, "internal_error"))
    }
    if (requestTimeoutMs === 0) {
      return answerNotFound(handler, notFoundInput(source, pathname, env), wrap, failed)
    }
    const controller = new AbortController()
    const answer = answerNotFound(
      handler,
      notFoundInput(source, pathname, env, controller.signal),
      wrap,
      failed,
    )
    if (!(answer instanceof Promise)) return answer
    // The same bound a matched route gets: abort the signal, answer the timeout, discard the late
    // result. Both arms are attached, so a handler that settles after the deadline is still observed.
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        resolve(onTimeout())
      }, requestTimeoutMs)
      answer.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
  const apply = <S extends AnyServer>(app: S): S => {
    const host = app as unknown as NotFoundInstallable
    if (host.notFoundLane !== undefined) {
      throw new TypeError("notFound() is already applied to this server")
    }
    if (host.routePrefix !== "") {
      throw new TypeError(
        "notFound() inside a group answers nothing - apply it to the parent server",
      )
    }
    host[INSTALL_NOT_FOUND](lane)
    return app
  }
  return apply as IdentityPlugin
}
