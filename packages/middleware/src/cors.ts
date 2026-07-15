import type { Middleware } from "@nifrajs/core/server"
import { withHeaders } from "./_utils.ts"

export interface CorsOptions {
  /** Allowed origin(s): `"*"`, an exact origin, a list, or a predicate. Default `"*"`. */
  readonly origin?: string | ReadonlyArray<string> | ((origin: string) => boolean)
  /** Methods advertised in the preflight response. Default the common verbs. */
  readonly methods?: ReadonlyArray<string>
  /** Headers allowed on the actual request. Default: reflect the preflight's requested headers. */
  readonly allowedHeaders?: ReadonlyArray<string>
  /** Response headers exposed to the browser. */
  readonly exposedHeaders?: ReadonlyArray<string>
  /** Allow credentials (cookies / `Authorization`). Cannot be combined with `origin: "*"`. Default false. */
  readonly credentials?: boolean
  /** Preflight cache duration, in seconds. */
  readonly maxAge?: number
}

const DEFAULT_METHODS: ReadonlyArray<string> = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]

/** Resolve the `Access-Control-Allow-Origin` value for a request, or `null` to omit it. */
function resolveAllowOrigin(
  option: NonNullable<CorsOptions["origin"]>,
  requestOrigin: string | null,
): string | null {
  if (option === "*") return "*"
  if (requestOrigin === null) return null
  if (typeof option === "function") return option(requestOrigin) ? requestOrigin : null
  if (Array.isArray(option)) return option.includes(requestOrigin) ? requestOrigin : null
  return option === requestOrigin ? requestOrigin : null
}

/**
 * CORS as a {@link Middleware}. Preflight (`OPTIONS` + `Access-Control-Request-Method`)
 * short-circuits to `204` via `onRequest`; the origin/credentials headers are added in
 * `onResponse`, so they also land on errors, 404s, and the preflight itself.
 *
 * Throws at construction if `credentials: true` is paired with `origin: "*"` — the
 * browser rejects that combination, so we fail loud instead of shipping dead CORS.
 */
export function cors(options: CorsOptions = {}): Middleware {
  const origin = options.origin ?? "*"
  const credentials = options.credentials ?? false
  if (credentials && origin === "*") {
    throw new Error(
      'cors: `credentials: true` cannot be combined with `origin: "*"` — list explicit origin(s).',
    )
  }
  const methods = (options.methods ?? DEFAULT_METHODS).join(", ")
  const allowedHeaders = options.allowedHeaders?.join(", ")
  const exposedHeaders = options.exposedHeaders?.join(", ")
  const maxAge = options.maxAge

  return {
    name: "cors",
    onRequest(req) {
      const isPreflight =
        req.method === "OPTIONS" && req.headers.has("access-control-request-method")
      if (!isPreflight) return undefined
      const headers = new Headers()
      headers.set("Access-Control-Allow-Methods", methods)
      const requested = allowedHeaders ?? req.headers.get("access-control-request-headers")
      if (requested) headers.set("Access-Control-Allow-Headers", requested)
      if (maxAge !== undefined) headers.set("Access-Control-Max-Age", String(maxAge))
      // Allow-Origin / Allow-Credentials are added by onResponse (runs on every response).
      return new Response(null, { status: 204, headers })
    },
    onResponse(res, req) {
      const allowOrigin = resolveAllowOrigin(origin, req.headers.get("origin"))
      if (allowOrigin === null) return res
      // Mutate in place on the common (mutable-headers) response; clone only for an immutable one.
      return withHeaders(res, (headers) => {
        headers.set("Access-Control-Allow-Origin", allowOrigin)
        if (allowOrigin !== "*") headers.append("Vary", "Origin")
        if (credentials) headers.set("Access-Control-Allow-Credentials", "true")
        if (exposedHeaders !== undefined) {
          headers.set("Access-Control-Expose-Headers", exposedHeaders)
        }
      })
    },
  }
}
