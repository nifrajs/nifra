import { definePlugin } from "@nifrajs/core"

export interface CacheControlOptions {
  /** Methods whose responses get the header. Default `["GET", "HEAD"]`. */
  readonly methods?: readonly string[]
  /** Predicate over the response status. Default: 2xx only. */
  readonly status?: (status: number) => boolean
  /** When `true` (default), don't overwrite a `Cache-Control` the handler already set. */
  readonly respectExisting?: boolean
}

/**
 * Set a `Cache-Control` header on matching responses. `value` is either a fixed directive string or a
 * function of the request (return `undefined` to leave a response untouched — e.g. cache by path).
 * Defaults to `GET`/`HEAD` + 2xx, and never clobbers a `Cache-Control` the handler set itself.
 *
 * ```ts
 * app.use(cacheControl("public, max-age=3600, stale-while-revalidate=60"))
 * // or per-path:
 * app.use(cacheControl((req) =>
 *   new URL(req.url).pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : undefined,
 * ))
 * ```
 */
export function cacheControl(
  value: string | ((request: Request) => string | undefined),
  options: CacheControlOptions = {},
) {
  const methods = new Set((options.methods ?? ["GET", "HEAD"]).map((m) => m.toUpperCase()))
  const statusOk = options.status ?? ((status: number) => status >= 200 && status < 300)
  const respectExisting = options.respectExisting !== false
  const resolve = typeof value === "function" ? value : () => value
  return definePlugin("cacheControl", (app) =>
    app.onResponse((res, req) => {
      if (!methods.has(req.method)) return res
      if (!statusOk(res.status)) return res
      if (respectExisting && res.headers.has("cache-control")) return res
      const directive = resolve(req)
      if (directive === undefined) return res
      const headers = new Headers(res.headers)
      headers.set("cache-control", directive)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }),
  )
}
