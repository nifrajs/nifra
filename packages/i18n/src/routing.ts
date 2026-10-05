/**
 * Locale-prefixed routing - the URL half of i18n, next to {@link negotiateLocale}'s detection half.
 * Pure and runtime-agnostic: prefix a pathname with a locale, strip a prefix back off, read the locale
 * a URL carries, check a `[lang]` route segment, and emit a page's canonical link and `hreflang`
 * alternates. Everything reads one {@link Locales} registry, so the URL scheme, the alternates and the
 * document language cannot disagree.
 *
 * The locale is the FIRST path segment. Prefixes match served locale keys only, case-insensitively on
 * read (`/HI/x` reads as `hi`), so `/frank` never reads as French and a draft locale's prefix reads as
 * an ordinary segment. No regex runs on request input; each operation is one scan of the path.
 */
import type { LocaleInfo, Locales } from "./locales.ts"

export interface I18nRoutingOptions {
  /** Prefix the default locale too (`/en/about` instead of `/about`). Default `false`. */
  readonly prefixDefaultLocale?: boolean
}

/** A pathname with its locale prefix removed (or not, when it carries none). */
export interface UnlocalizedPath<K extends string = string> {
  /** The served locale the leading segment named, or `undefined` for an unprefixed path. */
  readonly locale: K | undefined
  /** The path without the locale segment, always starting with `/`. */
  readonly pathname: string
}

/** One `hreflang` alternate: a URL plus the tag search engines match on. */
export interface HreflangLink {
  /** The locale's `hreflang` value, or `"x-default"` for the fallback entry. */
  readonly hreflang: string
  readonly href: string
}

/** A page's canonical URL and the alternates that point at it from each language. */
export interface Alternates {
  /** The page's own URL in the locale the path is in. */
  readonly canonical: string
  /** One link per listed locale in registry order, then `x-default` when the default is listed. */
  readonly links: readonly HreflangLink[]
}

export interface AlternatesOptions<K extends string = string> {
  /** An absolute `http(s)` origin for absolute URLs, as search engines require. Omit for
   * root-relative URLs, as a language switcher wants. */
  readonly origin?: string
  /** The locales this page exists in. Default: every served locale. Every page of one cluster must
   * pass the same set, so the alternates stay reciprocal; a locale outside the served set throws. */
  readonly locales?: readonly K[]
}

/** What a `[lang]` segment value means for the request. */
export type SegmentMatch<K extends string = string> =
  | { readonly kind: "ok"; readonly locale: K }
  /** Not a served locale (unknown, or a draft): answer 404. */
  | { readonly kind: "not-found" }
  /** A served locale under a non-canonical URL - the default's prefix when the default is served
   * unprefixed, or the wrong case. `location` is the canonical path, query kept. */
  | { readonly kind: "redirect"; readonly location: string }

/** Normalize and validate the origin used in absolute links. */
function normalizeOrigin(origin: string): string {
  if (origin.trim() !== origin) {
    throw new Error("alternates: origin must be an absolute http(s) origin")
  }
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error("alternates: origin must be an absolute http(s) origin")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("alternates: origin must be an absolute http(s) origin")
  }
  return url.origin
}

interface SplitPath {
  readonly segments: string[]
  readonly query: string
  readonly hash: string
  readonly trailingSlash: boolean
}

/**
 * Split `/fr/about?x=1#y` into its non-empty path segments plus the untouched query and hash. A
 * backslash separates segments, as URL parsing treats it, and empty segments are dropped, so no input
 * can produce an output path starting with `//` or `/\`, which a browser would follow off-site.
 */
function splitPath(path: string): SplitPath {
  let end = path.length
  const query = path.indexOf("?")
  const hash = path.indexOf("#")
  if (query !== -1) end = query
  if (hash !== -1 && hash < end) end = hash
  const pathname = path.slice(0, end)
  const segments: string[] = []
  let start = 0
  for (let i = 0; i <= pathname.length; i++) {
    const ch = pathname[i]
    if (i === pathname.length || ch === "/" || ch === "\\") {
      if (i > start) segments.push(pathname.slice(start, i))
      start = i + 1
    }
  }
  const last = pathname[pathname.length - 1]
  return {
    segments,
    query: hash === -1 ? path.slice(end) : path.slice(end, hash > end ? hash : end),
    hash: hash === -1 ? "" : path.slice(hash),
    trailingSlash: segments.length > 0 && (last === "/" || last === "\\"),
  }
}

/** Join path segments under an optional prefix - `[]` is `/` (or `/fr`), never `//` or `/fr/`, unless
 * the input trailed. */
function joinPath(
  prefix: string | undefined,
  rest: readonly string[],
  trailingSlash: boolean,
): string {
  const parts = prefix === undefined ? rest : [prefix, ...rest]
  if (parts.length === 0) return "/"
  return `/${parts.join("/")}${trailingSlash && rest.length > 0 ? "/" : ""}`
}

/** Whether a raw path segment, percent-decoded, equals `value` ignoring ASCII case. */
function segmentEquals(segment: string, value: string): boolean {
  let decoded = segment
  if (segment.includes("%")) {
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
  }
  return decoded.toLowerCase() === value.toLowerCase()
}

export interface LocalizedRouter<K extends string = string> {
  /** The registry this router reads. */
  readonly locales: Locales<K>
  /** Prefix `path` with `locale` (`/about` → `/fr/about`), unless it is the unprefixed default.
   * The query and trailing slash ride along, the hash too; an already-prefixed path is re-prefixed.
   * A locale that is not served throws. */
  localizePathname(path: string, locale: K): string
  /** Strip a served locale prefix (`/fr/about` → `{ locale: "fr", pathname: "/about" }`). Anything
   * else - `/frank`, a draft's prefix - returns `{ locale: undefined }` with the path unchanged. */
  unlocalizePathname(path: string): UnlocalizedPath<K>
  /** The served locale a path's first segment names, or `undefined` when unprefixed. */
  getPathLocale(path: string): K | undefined
  /** The locale a path is in: its prefix, or the default for an unprefixed path. */
  localeOf(path: string): K
  /** The page's canonical URL and its `hreflang` alternates. `path` may carry any served prefix or
   * none (it decides the canonical's locale); its query is kept and its hash dropped. */
  alternates(path: string, options?: AlternatesOptions<K>): Alternates
  /**
   * Check the value of a `[lang]` / `[[lang]]` route segment that is the path's first segment.
   * `pathname` is the request's path (query allowed), used to build a redirect.
   *
   * ```ts
   * // routes/[lang]/_layout.backend.ts
   * import { notFound, type RouteMiddleware, redirect } from "@nifrajs/web"
   * import { urls } from "../../shared/i18n"
   *
   * export const middleware: RouteMiddleware = (ctx) => {
   *   const { pathname, search } = new URL(ctx.request.url)
   *   const match = urls.matchSegment(ctx.params.lang, pathname + search)
   *   if (match.kind === "not-found") notFound()
   *   if (match.kind === "redirect") return redirect(match.location, { status: 308 })
   * }
   * ```
   */
  matchSegment(value: string | undefined, pathname: string): SegmentMatch<K>
}

/**
 * Bind the app's locale-prefixed URL scheme to a {@link Locales} registry.
 *
 * ```ts
 * import { defineLocales } from "@nifrajs/i18n"
 * import { defineI18nRouting } from "@nifrajs/i18n/routing"
 *
 * const locales = defineLocales({ default: "en", locales: { en: {}, fr: {} } })
 * export const urls = defineI18nRouting(locales)
 * urls.localizePathname("/about", "fr") // "/fr/about"
 * urls.alternates("/fr/about", { origin: "https://example.com" }).canonical // "https://example.com/fr/about"
 * ```
 */
export function defineI18nRouting<K extends string>(
  locales: Locales<K>,
  options: I18nRoutingOptions = {},
): LocalizedRouter<K> {
  const prefixDefault = options.prefixDefaultLocale === true
  const defaultLocale = locales.default
  // Lowercase key → served key, so reads are case-insensitive while emitted prefixes keep the declared
  // spelling. Drafts are absent: their prefix reads as an ordinary segment.
  const servedByLower = new Map<string, K>()
  for (const key of locales.served) servedByLower.set(key.toLowerCase(), key)
  const infos = new Map<string, LocaleInfo<K>>()
  const order = new Map<string, number>()
  for (const key of locales.served) {
    infos.set(key, locales.get(key))
    order.set(key, order.size)
  }

  const matchFirst = (segments: readonly string[]): K | undefined => {
    const first = segments[0]
    return first === undefined ? undefined : servedByLower.get(first.toLowerCase())
  }

  const prefixFor = (locale: K): string | undefined =>
    locale === defaultLocale && !prefixDefault ? undefined : locale

  const servedOrThrow = (locale: K, where: string): K => {
    if (!infos.has(locale)) {
      throw new Error(`${where}: ${JSON.stringify(locale)} is not a served locale`)
    }
    return locale
  }

  const localizePathname = (path: string, locale: K): string => {
    const target = servedOrThrow(locale, "localizePathname")
    const { segments, query, hash, trailingSlash } = splitPath(path)
    const rest = matchFirst(segments) === undefined ? segments : segments.slice(1)
    return `${joinPath(prefixFor(target), rest, trailingSlash)}${query}${hash}`
  }

  const unlocalizePathname = (path: string): UnlocalizedPath<K> => {
    const { segments, query, hash, trailingSlash } = splitPath(path)
    const locale = matchFirst(segments)
    const rest = locale === undefined ? segments : segments.slice(1)
    return { locale, pathname: `${joinPath(undefined, rest, trailingSlash)}${query}${hash}` }
  }

  const getPathLocale = (path: string): K | undefined => matchFirst(splitPath(path).segments)

  const localeOf = (path: string): K => getPathLocale(path) ?? defaultLocale

  const alternates = (path: string, opts: AlternatesOptions<K> = {}): Alternates => {
    const base = opts.origin === undefined ? "" : normalizeOrigin(opts.origin)
    const { segments, query, trailingSlash } = splitPath(path)
    const current = matchFirst(segments)
    const rest = current === undefined ? segments : segments.slice(1)
    const pageLocale = current ?? defaultLocale
    let listed: readonly K[] = locales.served
    if (opts.locales !== undefined) {
      const wanted = new Set<string>()
      for (const locale of opts.locales) wanted.add(servedOrThrow(locale, "alternates"))
      if (!wanted.has(pageLocale)) {
        throw new Error(
          `alternates: the page is in ${JSON.stringify(pageLocale)}, which is not in locales - a page cannot be an alternate of a cluster it is missing from`,
        )
      }
      // Registry order, not caller order, so every page of the cluster emits the same list.
      listed = [...wanted].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) as K[]
    }
    const urlFor = (locale: K): string =>
      `${base}${joinPath(prefixFor(locale), rest, trailingSlash)}${query}`
    const links: HreflangLink[] = []
    let hasDefault = false
    for (const locale of listed) {
      links.push({ hreflang: (infos.get(locale) as LocaleInfo<K>).hreflang, href: urlFor(locale) })
      if (locale === defaultLocale) hasDefault = true
    }
    if (hasDefault) links.push({ hreflang: "x-default", href: urlFor(defaultLocale) })
    return { canonical: urlFor(pageLocale), links }
  }

  const matchSegment = (value: string | undefined, pathname: string): SegmentMatch<K> => {
    const { segments, query, trailingSlash } = splitPath(pathname)
    if (value === undefined) {
      // An absent optional segment is the default locale's unprefixed URL.
      if (!prefixDefault) return { kind: "ok", locale: defaultLocale }
      return {
        kind: "redirect",
        location: `${joinPath(defaultLocale, segments, trailingSlash)}${query}`,
      }
    }
    const locale = servedByLower.get(value.toLowerCase())
    if (locale === undefined) return { kind: "not-found" }
    const first = segments[0]
    // The segment must be the one in the path: anything else is a router setup this helper cannot
    // build a redirect for, and a 404 is the safe answer to it.
    if (first === undefined || !segmentEquals(first, value)) return { kind: "not-found" }
    const canonicalPrefix = prefixFor(locale)
    if (canonicalPrefix === first) return { kind: "ok", locale }
    return {
      kind: "redirect",
      location: `${joinPath(canonicalPrefix, segments.slice(1), trailingSlash)}${query}`,
    }
  }

  return {
    locales,
    localizePathname,
    unlocalizePathname,
    getPathLocale,
    localeOf,
    alternates,
    matchSegment,
  }
}
