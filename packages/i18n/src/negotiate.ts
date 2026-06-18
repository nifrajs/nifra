/**
 * Locale negotiation — pick the best supported locale for a request, from (in priority order) an
 * explicit cookie, then the `Accept-Language` header (quality-ranked, with a base-tag fallback so
 * `fr-CA` matches a supported `fr`). Pure + runtime-agnostic.
 */
export type Locale = string

export interface NegotiateOptions {
  /** The locales the app supports, e.g. `["en", "fr", "de"]`. Matched case-insensitively. */
  readonly locales: readonly Locale[]
  /** Returned when nothing matches. */
  readonly defaultLocale: Locale
  /** A cookie name whose value (if a supported locale) wins over `Accept-Language` (a user's explicit
   * choice). Omit to skip the cookie. */
  readonly cookie?: string
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

/**
 * Negotiate the request's locale. Order: a valid {@link NegotiateOptions.cookie} value →
 * `Accept-Language` (each `q`-ranked tag, exact then base-subtag) → `defaultLocale`.
 */
export function negotiateLocale(request: Request, options: NegotiateOptions): Locale {
  const { locales, defaultLocale } = options

  if (options.cookie !== undefined) {
    const fromCookie = parseCookie(request.headers.get("cookie"), options.cookie)
    if (fromCookie !== undefined) {
      const matched = matchLocale(fromCookie, locales)
      if (matched !== undefined) return matched
    }
  }

  const header = request.headers.get("accept-language")
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
      if (tag === "*") return locales[0] ?? defaultLocale
      const matched = matchLocale(tag, locales)
      if (matched !== undefined) return matched
    }
  }

  return defaultLocale
}
