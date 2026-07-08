/** A structured API error, mirroring the server's `{ ok: false, error, issues }`. */
export interface ApiError {
  readonly error: string
  readonly issues?: ReadonlyArray<{
    readonly message: string
    readonly path?: ReadonlyArray<string>
  }>
}

/**
 * The outcome of a client call. The client never throws — inspect `ok` to branch.
 * `data` is the parsed response body, **typed by `ok`**: on success it's the route's
 * response type; on failure it's the parsed error body, typed from the route's
 * `errors` contract (`unknown` when the route declares none, `null` on a transport
 * error with no response body). `error` is always the server's normalized
 * `{ error, issues? }` summary on failure (or a transport error), `null` on success.
 */
export type Result<Data, ErrData = unknown> =
  | { readonly ok: true; readonly status: number; readonly data: Data; readonly error: null }
  | {
      readonly ok: false
      readonly status: number
      readonly data: ErrData
      readonly error: ApiError
    }
