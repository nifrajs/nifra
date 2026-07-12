import type { Middleware } from "@nifrajs/core"
import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import { withHeaders } from "./_utils.ts"

export interface SecurityHeadersOptions {
  /** `Strict-Transport-Security`. Off by default — opt in once you're sure you're HTTPS-only. */
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
      // Mutate in place on the common (mutable-headers) response; clone only for an immutable one
      // (see withHeaders — the old always-clone was ~3% of a realistic request).
      onResponse: (res) =>
        withHeaders(res, (headers) => {
          headers.set("X-Content-Type-Options", "nosniff")
          headers.set("X-Frame-Options", frameOptions)
          headers.set("Referrer-Policy", referrerPolicy)
          if (hstsValue !== undefined) headers.set("Strict-Transport-Security", hstsValue)
          if (csp !== undefined) headers.set("Content-Security-Policy", csp)
        }),
    },
    {
      id: NIFRA_ASSURANCE.SECURITY_HEADERS,
      source: "security-headers",
      scope: "global",
    },
  )
}
