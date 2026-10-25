/**
 * CSRF protection via an **Origin / Referer check** on state-changing requests - OWASP's recommended
 * defense for cookie-authenticated apps. A browser always attaches `Origin` (or at least `Referer`) to
 * a cross-origin or same-origin *unsafe* request; it must match an allowed origin, else `403`. Safe
 * methods (GET/HEAD/OPTIONS) pass, as do routes listed in `exempt`. Apply with
 * `app.use(csrf({ origins: ["https://example.com"] }))`.
 */
import { expandOptionalParams } from "@nifrajs/core/pattern"
import { Router } from "@nifrajs/core/router"
import { isSameOriginRequest, type Middleware, pathnameOf } from "@nifrajs/core/server"

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
  /**
   * Route patterns whose requests skip the check, for a route no browser calls that proves its sender
   * another way - a signed payment webhook arrives with no `Origin` at all. Written as routes are
   * (`/inbound/:vendor`) and matched against the path this server routes, so a different path to
   * the same handler is still checked. Exempt nothing that acts on a session cookie: a cross-site page
   * can post to it.
   */
  readonly exempt?: readonly string[]
}

const forbidden = (): Response =>
  Response.json({ ok: false, error: "csrf_failed" }, { status: 403 })

function exemptionOf(patterns: readonly string[]): ((path: string) => boolean) | undefined {
  if (patterns.length === 0) return undefined
  const forms = new Set(patterns.flatMap((pattern) => expandOptionalParams(pattern)))
  const router = new Router<true>()
  // An exemption names a path whatever the method, so every form sits under one method key.
  for (const form of forms) router.add("POST", form, true)
  return (path) => router.find("POST", path).found
}

export function csrf(options: CsrfOptions = {}): Middleware {
  const configured = options.origins !== undefined ? new Set(options.origins) : undefined
  const exempt = exemptionOf(options.exempt ?? [])
  instances += 1
  return {
    name: `csrf#${instances}`,
    onRequest(req) {
      if (SAFE_METHODS.has(req.method)) return undefined
      if (exempt?.(pathnameOf(req.url)) === true) return undefined
      // The same-origin default uses core's check, which accepts an `https:` page reaching an `http:`
      // request URL on the same host - what every TLS-terminating proxy looks like from here.
      const allowed = (candidate: string): boolean =>
        configured !== undefined ? configured.has(candidate) : isSameOriginRequest(candidate, req)

      const origin = req.headers.get("origin")
      // Under `Referrer-Policy: no-referrer` a browser sends a same-origin form POST with
      // `Origin: null`; its own `Sec-Fetch-Site` still says same-origin, and script can set neither.
      if (origin === "null" && configured === undefined)
        return req.headers.get("sec-fetch-site") === "same-origin" ? undefined : forbidden()
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
