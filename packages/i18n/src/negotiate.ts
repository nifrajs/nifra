/**
 * Locale negotiation - pick the best supported locale for a request, from (in priority order) an
 * explicit query parameter, then a cookie, then the `Accept-Language` header (quality-ranked, with
 * a base-tag fallback so `fr-CA` matches a supported `fr`). Pure + runtime-agnostic. The result is
 * always a member of the configured `locales` allow-list (or `defaultLocale`): request input is
 * *matched against* the list, never echoed back - so a hostile `?lang=` or header value cannot
 * reach the response. Parsing is split-based and linear; no regex runs on request input.
 */
export type Locale = string

export interface NegotiateOptions {
  /** The locales the app supports, e.g. `["en", "fr", "de"]`. Matched case-insensitively. */
  readonly locales: readonly Locale[]
  /** Returned when nothing matches. */
  readonly defaultLocale: Locale
  /** A query parameter whose value (if a supported locale) wins over everything - a link carrying
   * `?lang=fr` is an explicit ask. Omit to skip the query string. */
  readonly queryParam?: string
  /** A cookie name whose value (if a supported locale) wins over `Accept-Language` (a user's explicit
   * choice). Omit to skip the cookie. */
  readonly cookie?: string
}

/** Which source produced the locale, in priority order. */
export type LocaleSource = "query" | "cookie" | "header" | "default"

export interface ResolvedLocale {
  /** Always a member of `locales` (or `defaultLocale`) - never raw request input. */
  readonly locale: Locale
  readonly source: LocaleSource
  /** The supported locale the request's cookie currently resolves to, when
   * {@link NegotiateOptions.cookie} is configured and the cookie holds a valid value. Lets a caller
   * persist a new choice only when it actually differs. */
  readonly cookie?: Locale
}

/**
 * The slice of a request the negotiation reads. Pass a `Request`, or this structural shape where no
 * `Request` object exists (e.g. inside an `onResponseHeaders` hook, which sees only `url` +
 * `header`). `query`/`url` are consulted only when `queryParam` is configured; an already-parsed
 * `query` is preferred over slicing `url`.
 */
export interface LocaleParts {
  readonly header: (name: string) => string | null
  readonly url?: string
  readonly query?: URLSearchParams
}

const parseCookie = (header: string | null, name: string): string | undefined => {
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Find a supported locale matching `tag` (exact, case-insensitive) or its base subtag (`fr-CA`→`fr`). */
const matchLocale = (tag: string, locales: readonly Locale[]): Locale | undefined => {
  const lower = tag.toLowerCase()
  const exact = locales.find((l) => l.toLowerCase() === lower)
  if (exact !== undefined) return exact
  const base = lower.split("-")[0]
  return locales.find((l) => l.toLowerCase() === base || l.toLowerCase().split("-")[0] === base)
}

/** The raw query string of `url` (no leading `?`), without a full URL parse. */
const searchSlice = (url: string): string => {
  const q = url.indexOf("?")
  if (q === -1) return ""
  const hash = url.indexOf("#", q)
  return url.slice(q + 1, hash === -1 ? url.length : hash)
}

/**
 * Negotiate the request's locale and report which source chose it. Order: a valid
 * {@link NegotiateOptions.queryParam} value → a valid {@link NegotiateOptions.cookie} value →
 * `Accept-Language` (each `q`-ranked tag, exact then base-subtag) → `defaultLocale`.
 */
export function resolveLocale(
  request: Request | LocaleParts,
  options: NegotiateOptions,
): ResolvedLocale {
  const { locales, defaultLocale } = options
  const parts: LocaleParts =
    request instanceof Request
      ? { header: (name) => request.headers.get(name), url: request.url }
      : request

  let cookieLocale: Locale | undefined
  if (options.cookie !== undefined) {
    const raw = parseCookie(parts.header("cookie"), options.cookie)
    if (raw !== undefined) cookieLocale = matchLocale(raw, locales)
  }
  const resolved = (locale: Locale, source: LocaleSource): ResolvedLocale =>
    cookieLocale !== undefined ? { locale, source, cookie: cookieLocale } : { locale, source }

  if (options.queryParam !== undefined) {
    const params =
      parts.query ??
      (parts.url !== undefined ? new URLSearchParams(searchSlice(parts.url)) : undefined)
    const raw = params?.get(options.queryParam)
    if (raw !== undefined && raw !== null) {
      const matched = matchLocale(raw, locales)
      if (matched !== undefined) return resolved(matched, "query")
    }
  }

  if (cookieLocale !== undefined) return resolved(cookieLocale, "cookie")

  const header = parts.header("accept-language")
  if (header !== null) {
    const ranked = header
      .split(",")
      .map((part) => {
        // `split(";")` always yields ≥1 element; default `""` satisfies noUncheckedIndexedAccess.
        const [tag = "", ...params] = part.trim().split(";")
        const q = params.find((p) => p.trim().startsWith("q="))
        const quality = q !== undefined ? Number.parseFloat(q.trim().slice(2)) : 1
        return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0 }
      })
      .filter((entry) => entry.tag !== "" && entry.quality > 0)
      .sort((a, b) => b.quality - a.quality)
    for (const { tag } of ranked) {
      if (tag === "*") return resolved(locales[0] ?? defaultLocale, "header")
      const matched = matchLocale(tag, locales)
      if (matched !== undefined) return resolved(matched, "header")
    }
  }

  return resolved(defaultLocale, "default")
}

/**
 * Negotiate the request's locale. Order: a valid {@link NegotiateOptions.queryParam} value → a
 * valid {@link NegotiateOptions.cookie} value → `Accept-Language` (each `q`-ranked tag, exact then
 * base-subtag) → `defaultLocale`. {@link resolveLocale} additionally reports the winning source.
 */
export function negotiateLocale(request: Request | LocaleParts, options: NegotiateOptions): Locale {
  return resolveLocale(request, options).locale
}
