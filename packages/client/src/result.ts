/** A structured API error, mirroring the server's `{ ok: false, error, issues }`. */
export interface ApiError {
  readonly error: string
  readonly issues?: ReadonlyArray<{
    readonly message: string
    readonly path?: ReadonlyArray<string>
  }>
}

/**
 * The failure statuses a call can carry (the IANA registry's 3xx/4xx/5xx set). Finite on purpose:
 * the undeclared-status fallback arm of {@link Result} is `Exclude<ErrorStatus, declared>` - with a
 * bare `number` there instead, `status === 404` could not narrow `data` to the declared 404 body,
 * because 404 would still inhabit the fallback arm.
 */
export type ErrorStatus =
  | 300
  | 301
  | 302
  | 303
  | 304
  | 305
  | 306
  | 307
  | 308
  | 400
  | 401
  | 402
  | 403
  | 404
  | 405
  | 406
  | 407
  | 408
  | 409
  | 410
  | 411
  | 412
  | 413
  | 414
  | 415
  | 416
  | 417
  | 418
  | 421
  | 422
  | 423
  | 424
  | 425
  | 426
  | 428
  | 429
  | 431
  | 451
  | 500
  | 501
  | 502
  | 503
  | 504
  | 505
  | 506
  | 507
  | 508
  | 510
  | 511

/** One failure arm per declared error status: `status` is the literal, `data` its declared body. */
type DeclaredFailures<Errors extends Record<number, unknown>> = {
  [K in Extract<keyof Errors, number>]: {
    readonly ok: false
    readonly status: K
    readonly data: Errors[K]
    readonly error: ApiError
  }
}[Extract<keyof Errors, number>]

/**
 * The outcome of a client call. The client never throws - inspect `ok` to branch.
 *
 * On success, `data` is the route's response type. On failure the union is DISCRIMINATED BY
 * `status` when the route declares an `errors` record: `status === 404` narrows `data` to the
 * declared 404 body; every undeclared status (plus `0` for a transport error with no response)
 * falls into a fallback arm whose `data` is `unknown`. A route with no `errors` contract keeps a
 * single failure arm with `data: Errors` (`unknown`). `error` is always the server's normalized
 * `{ error, issues? }` summary on failure, `null` on success.
 */
export type Result<Data, Errors = unknown> =
  | { readonly ok: true; readonly status: number; readonly data: Data; readonly error: null }
  | ([Errors] extends [Record<number, unknown>]
      ?
          | DeclaredFailures<Errors>
          | {
              readonly ok: false
              readonly status: Exclude<ErrorStatus, Extract<keyof Errors, number>> | 0
              readonly data: unknown
              readonly error: ApiError
            }
      : {
          readonly ok: false
          readonly status: number
          readonly data: Errors
          readonly error: ApiError
        })
