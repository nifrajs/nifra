/** The not-found rules (see `./not-found.ts`), shared by `notFound()` and the edge server. */
import type { Platform } from "./context.ts"
import { isRoutableMethod, plainError } from "./http.ts"
import { getNeverAbortSignal, headerOf, type ResponseResult } from "./runtime-core.ts"
import type { MaybePromise, RequestSource } from "./server.ts"

/** What a {@link NotFoundHandler} is given: the request line and headers of a request no route matched. */
export interface NotFoundInput<Env = unknown> {
  /** The request method, exactly as received. Always a token a route could be registered under. */
  readonly method: string
  /** The request URL, exactly as received. */
  readonly url: string
  /** The path the router looked up, exactly as received: NOT percent-decoded, so `/a%2Fb` stays
   * `/a%2Fb`. Escape it before writing it into a body. */
  readonly pathname: string
  /** The request headers. */
  readonly headers: Headers
  /** Read one request header (case-insensitive), or `null` when it is absent. */
  header(name: string): string | null
  /** Aborts when the server's `requestTimeoutMs` elapses before the handler settles. Never aborts
   * when no timeout is configured. */
  readonly signal: AbortSignal
  /** The platform inputs (`env`, `waitUntil`, the caller address) the serving adapter supplied. */
  readonly platform: Platform<Env> | undefined
}

/**
 * Answers a request no route matched. Return a `Response`, or `undefined` for the default `404`.
 * May be async; a thrown `Response` is treated like a returned one.
 */
export type NotFoundHandler<Env = unknown> = (
  input: NotFoundInput<Env>,
) => MaybePromise<Response | undefined>

/** @internal The read-only view a {@link NotFoundHandler} receives. `url` and `headers` stay getters
 * so a source that builds them on demand is not forced to for a handler that never reads them. */
export function notFoundInput<Env>(
  source: RequestSource,
  pathname: string,
  platform: Platform<Env> | undefined,
  signal: AbortSignal = getNeverAbortSignal(),
): NotFoundInput<Env> {
  return {
    method: source.method,
    pathname,
    signal,
    platform,
    get url() {
      return source.url
    },
    get headers() {
      return source.headers
    },
    header: (name) => headerOf(source, name),
  }
}

/**
 * @internal Run a {@link NotFoundHandler} and turn what it produced into the answer. One function
 * for every server that has a `404` site, so the rules above hold identically on each of them.
 * `wrap` lifts a response into the caller's output type; `failed` renders the fault answer.
 */
export function answerNotFound<T, Env>(
  handler: NotFoundHandler<Env>,
  input: NotFoundInput<Env>,
  wrap: (response: Response | ResponseResult) => T,
  failed: (error: unknown) => T,
): MaybePromise<T> {
  if (!isRoutableMethod(input.method)) return wrap(plainError(404, "not_found"))
  const settle = (value: unknown, thrown: boolean): T => {
    if (value instanceof Response) {
      // A status below 200 is `Response.error()`: a network-error marker, not an answer.
      if (value.bodyUsed || value.status < 200) {
        return failed(new TypeError("notFound handler answered with an unusable Response"))
      }
      // A miss is never a success. The body and headers are the handler's; the status is not.
      return wrap(
        value.status < 300
          ? new Response(value.body, { status: 404, headers: value.headers })
          : value,
      )
    }
    if (thrown) return failed(value)
    if (value === undefined) return wrap(plainError(404, "not_found"))
    return failed(new TypeError("notFound handler must return a Response or undefined"))
  }
  let result: MaybePromise<Response | undefined>
  try {
    result = handler(input)
  } catch (error) {
    return settle(error, true)
  }
  return result instanceof Promise
    ? result.then(
        (value) => settle(value, false),
        (error) => settle(error, true),
      )
    : settle(result, false)
}

/** @internal What the kernel calls at its `404` site once a handler is installed. */
export type NotFoundLane = <T>(
  host: unknown,
  source: RequestSource,
  pathname: string,
  platform: Platform<unknown> | undefined,
  wrap: (response: Response | ResponseResult) => T,
  onTimeout: () => T,
) => MaybePromise<T>
