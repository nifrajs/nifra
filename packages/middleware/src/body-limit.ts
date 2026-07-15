import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import { METHODS, type Middleware } from "@nifrajs/core/server"
import { jsonError, SAFE_METHODS } from "./_utils.ts"

export interface BodyLimitOptions {
  /** Maximum raw request-body bytes accepted. */
  readonly maxBytes: number
  /** Methods to inspect. Default: every method except GET/HEAD/OPTIONS/TRACE. */
  readonly methods?: readonly string[]
  /** Response error name for over-limit bodies. Default `"payload_too_large"`. */
  readonly error?: string
  /** Allow bodies without Content-Length. Default false (fail closed with 411). */
  readonly allowLengthless?: boolean
}

function parseContentLength(value: string | null): number | undefined | null {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : Infinity
}

/**
 * Enforce a raw byte cap for request bodies before routing. This middleware is intentionally
 * Content-Length based: reading a cloned Web body is not transparent on every runtime. Lengthless
 * bodies fail closed by default; use route-level `c.boundedBody()` / schema validation for endpoints
 * that intentionally accept streamed bodies.
 */
export function bodyLimit(options: BodyLimitOptions): Middleware {
  const { maxBytes } = options
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("bodyLimit: maxBytes must be a non-negative safe integer")
  }
  const methods =
    options.methods !== undefined ? new Set(options.methods.map((m) => m.toUpperCase())) : undefined
  const error = options.error ?? "payload_too_large"
  const allowLengthless = options.allowLengthless === true

  const middleware: Middleware = {
    name: "body-limit",
    onRequest(req) {
      if (methods !== undefined ? !methods.has(req.method) : SAFE_METHODS.has(req.method)) {
        return undefined
      }
      const contentLength = parseContentLength(req.headers.get("content-length"))
      if (contentLength === null) return jsonError(400, "invalid_content_length")
      if (contentLength === undefined && req.body !== null && !allowLengthless) {
        return jsonError(411, "length_required")
      }
      if (contentLength !== undefined && contentLength > maxBytes) return jsonError(413, error)
      return undefined
    },
  }
  // Lengthless bodies are deliberately allowed in this mode, so claiming BODY_BOUNDED for the
  // whole route would be false. The middleware still enforces declared Content-Length at runtime.
  if (allowLengthless) return middleware
  return withRouteAssurance(middleware, {
    id: NIFRA_ASSURANCE.BODY_BOUNDED,
    source: "body-limit",
    scope: "global",
    methods:
      options.methods === undefined
        ? ["POST", "PUT", "PATCH", "DELETE"]
        : METHODS.filter((method) => methods?.has(method)),
  })
}
