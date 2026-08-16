/**
 * `localeDetector()` - a nifra plugin over {@link resolveLocale}: derives `c.locale` (+
 * `c.localeSource`) from query parameter → cookie → `Accept-Language` → default, emits
 * `Content-Language`, and can persist an explicit `?lang=` choice into the locale cookie.
 *
 * Lives at `@nifrajs/i18n/detector` so the package root stays dependency-free; this module needs
 * `@nifrajs/core` (an optional peer dependency). `@nifrajs/middleware`'s `language()` is the
 * header-only sibling (`Accept-Language` → `c.language`); use one or the other, not both.
 *
 * **Persistence.** With `persist: true`, a `Set-Cookie` is written ONLY when the locale was chosen
 * by the **query parameter** and differs from what the cookie already resolves to: a `?lang=fr`
 * link is an explicit ask worth pinning, while a header-derived guess is not - persisting it would
 * put `Set-Cookie` on every first response (uncacheable) and freeze a guess the user never made.
 * The cookie is written `Path=/; SameSite=Lax; Max-Age=...`, without `HttpOnly` (client-side
 * language switchers may read it) and without `Secure` (plain-http dev works). That is safe for
 * this cookie because its value is never trusted on read beyond allow-list matching - tampering
 * can only select one of the app's own supported locales. A `__Secure-`/`__Host-` cookie name
 * opts into the prefix contract, and `Secure` is applied automatically.
 */

import { withResponseObserver } from "@nifrajs/core/response-observer"
import {
  cookieNamePrefix,
  defineContextPlugin,
  type Middleware,
  serializeCookie,
} from "@nifrajs/core/server"
import {
  type Locale,
  type LocaleSource,
  type NegotiateOptions,
  resolveLocale,
} from "./negotiate.ts"

export interface LocaleDetectorOptions extends NegotiateOptions {
  /** Persist a `queryParam` choice into the locale cookie when it differs from the cookie's current
   * value. Requires both `queryParam` and `cookie`. Default `false`. */
  readonly persist?: boolean
  /** `Max-Age` (seconds) of the persisted cookie. Default one year. */
  readonly cookieMaxAge?: number
  /** Emit `Content-Language` (kept if already set by the handler). Default `true`. */
  readonly header?: boolean
}

/** Context added by {@link localeDetector}. */
export interface LocaleContext {
  /** The negotiated locale - always one of the configured `locales`. */
  readonly locale: Locale
  readonly localeSource: LocaleSource
}

/**
 * Detect the request's locale and expose it as `c.locale` / `c.localeSource`.
 *
 * ```ts
 * import { localeDetector } from "@nifrajs/i18n/detector"
 *
 * app.use(
 *   localeDetector({
 *     locales: ["en", "fr", "de"],
 *     defaultLocale: "en",
 *     queryParam: "lang",
 *     cookie: "locale",
 *     persist: true,
 *   }),
 * ).get("/", (c) => c.json({ locale: c.locale }))
 * ```
 */
export function localeDetector(options: LocaleDetectorOptions) {
  const { locales, defaultLocale } = options
  if (locales.length === 0) throw new Error("localeDetector: locales must not be empty")
  if (!locales.includes(defaultLocale)) {
    throw new Error("localeDetector: defaultLocale must be in locales")
  }
  const cookieName = options.cookie
  if (options.persist === true && (cookieName === undefined || options.queryParam === undefined)) {
    throw new Error("localeDetector: persist requires both cookie and queryParam")
  }
  const persistCookie = options.persist === true ? cookieName : undefined
  const cookieAttrs = {
    path: "/",
    sameSite: "lax",
    maxAge: options.cookieMaxAge ?? 31_536_000,
    // A `__Secure-`/`__Host-` cookie name opts into the prefix contract: apply `Secure` (Path is
    // already `/`, no Domain is set) so the persisting Set-Cookie satisfies it instead of throwing.
    ...(persistCookie !== undefined && cookieNamePrefix(persistCookie) !== undefined
      ? { secure: true }
      : undefined),
  } as const
  // Fail a bad cookie name or Max-Age at construction, not on the first persisting response.
  if (persistCookie !== undefined) serializeCookie(persistCookie, defaultLocale, cookieAttrs)
  const emitHeader = options.header !== false

  return defineContextPlugin<LocaleContext>("localeDetector", (app) =>
    app
      .derive((c) => {
        // At derive time `c.query` is the raw `URLSearchParams` (validation hasn't replaced it);
        // the guard keeps this correct even if a validated value ever lands there first.
        const resolved = resolveLocale(
          {
            header: (name) => c.header(name),
            ...(c.query instanceof URLSearchParams ? { query: c.query } : { url: c.req.url }),
          },
          options,
        )
        return { locale: resolved.locale, localeSource: resolved.source }
      })
      .use(
        withResponseObserver<Middleware>({
          onResponseHeaders(headers, req) {
            // Pure recompute from (url, request headers) - the same trick as middleware's
            // `language()`: no WeakMap pairing, so the Node direct-writer lane stays available.
            const resolved = resolveLocale(
              { header: (name) => req.header(name), url: req.url },
              options,
            )
            if (emitHeader && !headers.has("content-language")) {
              headers.set("content-language", resolved.locale)
            }
            if (persistCookie === undefined) return
            if (resolved.source !== "query") return
            if (resolved.cookie === resolved.locale) return
            headers.append(
              "set-cookie",
              serializeCookie(persistCookie, resolved.locale, cookieAttrs),
            )
          },
        }),
      ),
  )
}
