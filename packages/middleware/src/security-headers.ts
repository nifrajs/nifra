import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import type { Middleware } from "@nifrajs/core/server"

export interface SecurityHeadersOptions {
  /** `Strict-Transport-Security`. Off by default - opt in once you're sure you're HTTPS-only. */
  readonly hsts?: {
    readonly maxAge: number
    readonly includeSubDomains?: boolean
    readonly preload?: boolean
  }
  /** `Content-Security-Policy` value. Off by default (app-specific). */
  readonly contentSecurityPolicy?: string
  /** `X-Frame-Options`. Default `"DENY"`. */
  readonly frameOptions?: "DENY" | "SAMEORIGIN"
  /** `Referrer-Policy`. Default `"no-referrer"`. */
  readonly referrerPolicy?: string
}

/**
 * A safe-by-default set of response security headers (`onResponse`, so they cover
 * errors and 404s too): `X-Content-Type-Options: nosniff`, `X-Frame-Options`, and
 * `Referrer-Policy` always; `Strict-Transport-Security` and `Content-Security-Policy`
 * only when configured (both are environment-/app-specific).
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  const frameOptions = options.frameOptions ?? "DENY"
  const referrerPolicy = options.referrerPolicy ?? "no-referrer"
  const csp = options.contentSecurityPolicy

  let hstsValue: string | undefined
  if (options.hsts !== undefined) {
    const parts = [`max-age=${options.hsts.maxAge}`]
    if (options.hsts.includeSubDomains) parts.push("includeSubDomains")
    if (options.hsts.preload) parts.push("preload")
    hstsValue = parts.join("; ")
  }

  return withRouteAssurance<Middleware>(
    {
      name: "security-headers",
      // One portable header hook: runs against the response's own Headers on Web runtimes and the
      // outcome record on the Node direct writer - no clone, no per-runtime twin.
      onResponseHeaders: (headers) => {
        headers.set("x-content-type-options", "nosniff")
        headers.set("x-frame-options", frameOptions)
        headers.set("referrer-policy", referrerPolicy)
        if (hstsValue !== undefined) headers.set("strict-transport-security", hstsValue)
        if (csp !== undefined) headers.set("content-security-policy", csp)
      },
    },
    {
      id: NIFRA_ASSURANCE.SECURITY_HEADERS,
      source: "security-headers",
      scope: "global",
    },
  )
}
