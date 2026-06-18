/**
 * CSRF protection via an **Origin / Referer check** on state-changing requests — OWASP's recommended
 * defense for cookie-authenticated apps. A browser always attaches `Origin` (or at least `Referer`) to
 * a cross-origin or same-origin *unsafe* request; it must match an allowed origin, else `403`. Safe
 * methods (GET/HEAD/OPTIONS) pass. Apply with `app.use(csrf({ origins: ["https://example.com"] }))`.
 */
import type { Middleware } from "@nifrajs/core"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export interface CsrfOptions {
  /**
   * Allowed origins (e.g. `["https://example.com"]`). **Set this in production behind a proxy** — when
   * omitted, the check derives same-origin from the request URL, which is correct in dev / when the
   * proxy preserves `Host` but not when the public origin differs from the worker's.
   */
  readonly origins?: readonly string[]
}

const forbidden = (): Response =>
  Response.json({ ok: false, error: "csrf_failed" }, { status: 403 })

export function csrf(options: CsrfOptions = {}): Middleware {
  const configured = options.origins !== undefined ? new Set(options.origins) : undefined
  return {
    name: "csrf",
    onRequest(req) {
      if (SAFE_METHODS.has(req.method)) return undefined
      const allowed = configured ?? new Set([new URL(req.url).origin])

      const origin = req.headers.get("origin")
      if (origin !== null) return allowed.has(origin) ? undefined : forbidden()

      // Some same-origin requests omit `Origin` — fall back to the `Referer`'s origin.
      const referer = req.headers.get("referer")
      if (referer !== null) {
        let refererOrigin: string
        try {
          refererOrigin = new URL(referer).origin
        } catch {
          return forbidden() // malformed Referer
        }
        return allowed.has(refererOrigin) ? undefined : forbidden()
      }

      // A state-changing request with neither header → reject (fail closed; a browser always sends one).
      return forbidden()
    },
  }
}
