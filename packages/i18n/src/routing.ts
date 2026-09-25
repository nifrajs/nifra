/**
 * Locale-prefixed routing - the URL half of i18n, next to {@link negotiateLocale}'s detection
 * half. Pure + runtime-agnostic: prefix a pathname with a locale, strip a prefix back off, read
 * the locale a URL carries, and emit the absolute `hreflang` link set SEO needs. A route manifest
 * with `[[locale]]` optional segments serves the prefixed shapes; this module is what builds and
 * reads those URLs consistently on both sides (links, redirects, middleware, sitemaps).
 *
 * Prefixes match full configured tags only (`/fr/...` for `"fr"`, `/pt-BR/...` for `"pt-BR"`) and
 * case-insensitively on read, so `/frank` never reads as French. Like negotiation, matching is
 * against the allow-list - a path segment that is not a supported locale is left alone, never
 * echoed anywhere it matters. No regex runs on request input; one scan of the first segment.
 */
import type { Locale } from "./negotiate.ts"

export interface I18nRoutingOptions {
  /** The locales the app supports, e.g. `["en", "fr", "pt-BR"]`. First-segment matching is
   * case-insensitive; emitted prefixes keep the configured spelling. Two locales that differ
   * only by case are rejected - no URL could name one without naming the other. */
  readonly locales: readonly Locale[]
  /** The default locale, served unprefixed unless {@link prefixDefaultLocale} is set. */
  readonly defaultLocale: Locale
  /** Prefix the default locale too (`/en/about` instead of `/about`). Default `false`. */
  readonly prefixDefaultLocale?: boolean
}

/** A pathname with its locale prefix removed (or not, when it carries none). */
export interface UnlocalizedPath {
  /** The locale the leading segment named, or `undefined` for an unprefixed path. */
  readonly locale: Locale | undefined
  /** The path without the locale segment, always starting with `/`. */
  readonly pathname: string
}

/** One `hreflang` alternate: an absolute URL plus the tag search engines match on. */
export interface HreflangLink {
  /** The `hreflang` value - the locale tag, or `"x-default"` for the fallback entry. */
  readonly hreflang: string
  readonly href: string
}

const hasUpperAscii = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 65 && code <= 90) return true
  }
  return false
}

const lowerName = (value: string): string => (hasUpperAscii(value) ? value.toLowerCase() : value)

/** Locale names become URL path segments; reject delimiters and control characters up front. */
function isSafeLocaleSegment(value: string): boolean {
  if (value === "" || value === "." || value === ".." || value.includes("%")) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (
      code <= 0x1f ||
      code === 0x7f ||
      code === 0x20 ||
      value[i] === "/" ||
      value[i] === "\\" ||
      value[i] === "?" ||
      value[i] === "#"
    ) {
      return false
    }
  }
  return true
}

/** Normalize and validate the origin used in absolute alternate links. */
function normalizeOrigin(origin: string): string {
  if (origin.trim() !== origin) {
    throw new Error("defineI18nRouting: origin must be an absolute http(s) origin")
  }
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error("defineI18nRouting: origin must be an absolute http(s) origin")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("defineI18nRouting: origin must be an absolute http(s) origin")
  }
  return url.origin
}

/** Split `/fr/about?x=1#y` into path segments plus the untouched query/hash tail. A path
 * missing its leading slash is normalized first - request pathnames always carry one, and link
 * builders should not emit `fr/about` from a typo. */
function splitTail(path: string): {
  readonly segments: string[]
  readonly suffix: string
  readonly trailingSlash: boolean
} {
  const normalized = path.startsWith("/") ? path : `/${path}`
  let end = normalized.length
  const query = normalized.indexOf("?")
  const hash = normalized.indexOf("#")
  if (query !== -1) end = query
  if (hash !== -1 && hash < end) end = hash
  const pathname = normalized.slice(0, end)
  const segments = pathname.split("/").slice(1)
  // A trailing slash leaves a final empty segment (`/fr/` → `["fr", ""]`) - drop it so joins
  // below never emit a doubled slash; the slash itself is tracked separately.
  if (segments.length > 0 && segments[segments.length - 1] === "") segments.pop()
  return {
    segments,
    suffix: normalized.slice(end),
    trailingSlash: pathname.length > 1 && pathname.endsWith("/"),
  }
}

/** Rejoin path segments under no prefix - `[]` is `/`, never `//`. */
function joinBare(rest: readonly string[], suffix: string, trailingSlash: boolean): string {
  const base = rest.length === 0 ? "/" : `/${rest.join("/")}`
  return `${base}${trailingSlash && base !== "/" ? "/" : ""}${suffix}`
}

/** Rejoin path segments under `locale` - `[]` is `/fr`, never `/fr/`, unless it trailed. */
function joinPrefix(
  locale: Locale,
  rest: readonly string[],
  suffix: string,
  trailingSlash: boolean,
): string {
  const base = rest.length === 0 ? `/${locale}` : `/${locale}/${rest.join("/")}`
  return `${base}${trailingSlash ? "/" : ""}${suffix}`
}

export interface LocalizedRouter {
  /** Prefix `path` with `locale` (`/about` → `/fr/about`), unless it is the unprefixed default.
   * Query string, hash, and trailing slash ride along untouched; an already-prefixed path is
   * re-prefixed (which also normalizes the segment's case); an unknown `locale` throws. */
  localizePathname(path: string, locale: Locale): string
  /** Strip a supported locale prefix (`/fr/about` → `{ locale: "fr", pathname: "/about" }`).
   * Anything else - including lookalikes like `/frank` - returns `{ locale: undefined }` with the
   * path unchanged. */
  unlocalizePathname(path: string): UnlocalizedPath
  /** The locale a path's first segment names, or `undefined` when unprefixed. */
  getPathLocale(path: string): Locale | undefined
  /** Absolute `hreflang` alternates for the URL: one per locale plus `x-default` (which points at
   * the default-locale URL). `path` may carry any locale prefix or none - it is normalized first,
   * so every alternate describes the same page; its query string and hash are preserved on each. */
  hreflangLinks(path: string, origin: string): readonly HreflangLink[]
}

/**
 * Define the app's locale-prefixed URL scheme once (validated here, so the hot path never
 * re-checks), and get the four path operations bound to it.
 *
 * ```ts
 * import { defineI18nRouting } from "@nifrajs/i18n/routing"
 *
 * const urls = defineI18nRouting({ locales: ["en", "fr"], defaultLocale: "en" })
 * urls.localizePathname("/about", "fr") // "/fr/about"
 * urls.unlocalizePathname("/fr/about") // { locale: "fr", pathname: "/about" }
 * ```
 */
export function defineI18nRouting(options: I18nRoutingOptions): LocalizedRouter {
  const { locales, defaultLocale } = options
  if (locales.length === 0) throw new Error("defineI18nRouting: locales must not be empty")
  if (!locales.includes(defaultLocale)) {
    throw new Error("defineI18nRouting: defaultLocale must be in locales")
  }
  const prefixDefault = options.prefixDefaultLocale === true
  // Lowercase tag → configured spelling, so reads are case-insensitive while emitted prefixes
  // keep the canonical form (`/FR/...` reads as `"fr"` but links are built as `/fr/...`).
  const byLower = new Map<string, Locale>()
  for (const locale of locales) {
    if (!isSafeLocaleSegment(locale)) {
      throw new Error(
        `defineI18nRouting: locale ${JSON.stringify(locale)} must be one safe URL path segment`,
      )
    }
    const lower = lowerName(locale)
    const clash = byLower.get(lower)
    if (clash !== undefined) {
      if (clash === locale) {
        throw new Error(`defineI18nRouting: duplicate locale ${JSON.stringify(locale)}`)
      }
      throw new Error(
        `defineI18nRouting: locales ${JSON.stringify(clash)} and ${JSON.stringify(locale)} differ only by case`,
      )
    }
    byLower.set(lower, locale)
  }

  const matchFirst = (segments: readonly string[]): Locale | undefined => {
    if (segments.length === 0) return undefined
    return byLower.get(lowerName(segments[0] as string))
  }

  const localizePathname = (path: string, locale: Locale): string => {
    const target = byLower.get(lowerName(locale))
    if (target === undefined) {
      throw new Error(`localizePathname: unsupported locale ${JSON.stringify(locale)}`)
    }
    const { segments, suffix, trailingSlash } = splitTail(path)
    const rest = matchFirst(segments) === undefined ? segments : segments.slice(1)
    if (target === defaultLocale && !prefixDefault) return joinBare(rest, suffix, trailingSlash)
    return joinPrefix(target, rest, suffix, trailingSlash)
  }

  const unlocalizePathname = (path: string): UnlocalizedPath => {
    const { segments, suffix, trailingSlash } = splitTail(path)
    const locale = matchFirst(segments)
    if (locale === undefined)
      return { locale: undefined, pathname: joinBare(segments, suffix, trailingSlash) }
    return { locale, pathname: joinBare(segments.slice(1), suffix, trailingSlash) }
  }

  const getPathLocale = (path: string): Locale | undefined => matchFirst(splitTail(path).segments)

  const hreflangLinks = (path: string, origin: string): readonly HreflangLink[] => {
    const normalizedOrigin = normalizeOrigin(origin)
    const { segments, suffix, trailingSlash } = splitTail(path)
    const rest = matchFirst(segments) === undefined ? segments : segments.slice(1)
    const base = joinBare(rest, "", trailingSlash)
    const links: HreflangLink[] = []
    for (const locale of locales) {
      const href =
        locale === defaultLocale && !prefixDefault
          ? `${normalizedOrigin}${base}${suffix}`
          : `${normalizedOrigin}/${locale}${base}${suffix}`
      links.push({ hreflang: locale, href })
    }
    const fallback = prefixDefault
      ? `${normalizedOrigin}/${defaultLocale}${base}${suffix}`
      : `${normalizedOrigin}${base}${suffix}`
    links.push({ hreflang: "x-default", href: fallback })
    return links
  }

  return { localizePathname, unlocalizePathname, getPathLocale, hreflangLinks }
}
