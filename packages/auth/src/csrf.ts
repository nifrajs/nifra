/**
 * CSRF protection via an **Origin / Referer check** on state-changing requests - OWASP's recommended
 * defense for cookie-authenticated apps. A browser always attaches `Origin` (or at least `Referer`) to
 * a cross-origin or same-origin *unsafe* request; it must match an allowed origin, else `403`. Safe
 * methods (GET/HEAD/OPTIONS) pass. Apply with `app.use(csrf({ origins: ["https://example.com"] }))`.
 */
import { isSameOriginRequest, type Middleware } from "@nifrajs/core/server"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

// A name per instance: `use()` skips a name it already applied, which would drop a second, stricter
// `csrf()` inside a `group()`.
let instances = 0

export interface CsrfOptions {
  /**
   * Allowed origins (e.g. `["https://example.com"]`). When omitted, the request must be same-origin by
   * host (an `https:` page reaching an `http:` request URL is accepted, so a TLS-terminating proxy
   * works). Set it when the proxy rewrites `Host`, so the public origin differs from the worker's.
   */
  readonly origins?: readonly string[]
}

const forbidden = (): Response =>
  Response.json({ ok: false, error: "csrf_failed" }, { status: 403 })

export function csrf(options: CsrfOptions = {}): Middleware {
  const configured = options.origins !== undefined ? new Set(options.origins) : undefined
  instances += 1
  return {
    name: `csrf#${instances}`,
    onRequest(req) {
      if (SAFE_METHODS.has(req.method)) return undefined
      // The same-origin default uses core's check, which accepts an `https:` page reaching an `http:`
      // request URL on the same host - what every TLS-terminating proxy looks like from here.
      const allowed = (candidate: string): boolean =>
        configured !== undefined ? configured.has(candidate) : isSameOriginRequest(candidate, req)

      const origin = req.headers.get("origin")
      if (origin !== null) return allowed(origin) ? undefined : forbidden()

      // Some same-origin requests omit `Origin` - fall back to the `Referer`'s origin.
      const referer = req.headers.get("referer")
      if (referer !== null) {
        let refererOrigin: string
        try {
          refererOrigin = new URL(referer).origin
        } catch {
          return forbidden() // malformed Referer
        }
        return allowed(refererOrigin) ? undefined : forbidden()
      }

      // A state-changing request with neither header → reject (fail closed; a browser always sends one).
      return forbidden()
    },
  }
}
