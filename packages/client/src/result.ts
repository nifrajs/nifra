/** A structured API error, mirroring the server's `{ ok: false, error, issues }`. */
export interface ApiError {
  readonly error: string
  readonly issues?: ReadonlyArray<{
    readonly message: string
    readonly path?: ReadonlyArray<string>
  }>
}

/**
 * The outcome of a client call. The client never throws — inspect `ok` (or
 * `error`) to branch. On success `data` is the (JSON-shaped) response body; on
 * failure `error` carries the server's structured error or a transport error.
 */
export type Result<Data> =
  | { readonly ok: true; readonly status: number; readonly data: Data; readonly error: null }
  | { readonly ok: false; readonly status: number; readonly data: null; readonly error: ApiError }
