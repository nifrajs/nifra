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
 * A safe-by-default set of response security headers, covering errors and 404s too:
 * `X-Content-Type-Options: nosniff`, `X-Frame-Options`, and `Referrer-Policy` always;
 * `Strict-Transport-Security` and `Content-Security-Policy` only when configured (both are
 * environment-/app-specific).
 *
 * Every value is fixed at construction, so these are declared statically rather than written by a
 * response hook: an app whose response middleware is only this keeps the fused native lanes. A route
 * that sets one of these names itself keeps its own value.
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

  const declared: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": frameOptions,
    "referrer-policy": referrerPolicy,
  }
  if (hstsValue !== undefined) declared["strict-transport-security"] = hstsValue
  if (csp !== undefined) declared["content-security-policy"] = csp

  return withRouteAssurance<Middleware>(
    {
      name: "security-headers",
      responseHeaders: declared,
    },
    {
      id: NIFRA_ASSURANCE.SECURITY_HEADERS,
      source: "security-headers",
      scope: "global",
    },
  )
}
