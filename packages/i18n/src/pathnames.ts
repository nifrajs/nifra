import type { Locales } from "./locales.ts"

type Pathnames<K extends string> = Readonly<Record<string, Partial<Record<K, string | undefined>>>>

interface Entry<K extends string> {
  readonly key: string
  readonly canonical: readonly string[]
  readonly translations: ReadonlyMap<K, readonly string[]>
}

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/** Extra decodes allowed after the first; a legitimate path never nests encodings this deep. */
const MAX_NESTED_DECODES = 2

/** Decode each segment separately: a separator must never become part of another segment. */
function normalizedSegments(segments: readonly string[]): string[] | undefined {
  try {
    return segments.map((segment) => {
      const decoded = decodeURIComponent(segment)
      // Reject nested encoding tricks too, without mistaking a literal percent sign for an escape.
      // A request controls the nesting depth, so the passes are capped: each one is a full scan.
      let check = decoded
      for (let layer = 0; ; layer++) {
        if (
          check === "." ||
          check === ".." ||
          hasControl(check) ||
          /[/\\?#:*[\]{}()]/.test(check)
        ) {
          throw new Error("unsafe segment")
        }
        if (!/%[\da-f]{2}/i.test(check)) break
        if (layer === MAX_NESTED_DECODES) throw new Error("unsafe segment")
        const next = decodeURIComponent(check)
        if (next === check) break
        check = next
      }
      return encodeURIComponent(decoded)
    })
  } catch {
    return undefined
  }
}

const pathnameOf = (segments: readonly string[]): string => `/${segments.join("/")}`

function configuredSegments(pathname: unknown): readonly string[] {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.includes("//") ||
    hasControl(pathname) ||
    /[\\?#]/.test(pathname)
  ) {
    throw new Error(
      `pathnames: ${JSON.stringify(pathname)} must be a root-relative static pathname`,
    )
  }
  const parts = pathname === "/" ? [] : pathname.slice(1).replace(/\/$/, "").split("/")
  const normalized = normalizedSegments(parts)
  if (normalized === undefined) {
    throw new Error(
      `pathnames: ${JSON.stringify(pathname)} must be a safe static pathname (no patterns, dot segments or encoded separators)`,
    )
  }
  return normalized
}

/** Internal, immutable snapshot. No request parsing or platform-specific routing belongs here. */
export function compilePathnames<K extends string>(locales: Locales<K>, config?: Pathnames<K>) {
  if (config === undefined) return undefined
  const canonical = new Map<string, Entry<K>>()
  const publicByLocale = new Map<K, Map<string, Entry<K>>>()
  const declared = new Map<string, K>(locales.all.map((locale) => [locale, locale]))
  const prefixes = new Set(locales.served.map((key) => key.toLowerCase()))
  const validate = (pathname: unknown): readonly string[] => {
    const segments = configuredSegments(pathname)
    if (segments[0] !== undefined && prefixes.has(decodeURIComponent(segments[0]).toLowerCase())) {
      throw new Error(
        `pathnames: ${JSON.stringify(pathname)} must be unprefixed (its first segment is a served locale)`,
      )
    }
    return segments
  }
  for (const [key, values] of Object.entries(config)) {
    const segments = validate(key)
    const normalized = pathnameOf(segments)
    if (canonical.has(normalized)) {
      throw new Error(`pathnames: duplicate canonical pathname ${JSON.stringify(key)}`)
    }
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`pathnames: translations for ${JSON.stringify(key)} must be an object`)
    }
    const translations = new Map<K, readonly string[]>()
    for (const [locale, value] of Object.entries(values)) {
      const localeKey = declared.get(locale)
      if (localeKey === undefined) {
        throw new Error(
          `pathnames: unknown locale ${JSON.stringify(locale)} for ${JSON.stringify(key)}`,
        )
      }
      // An optional property explicitly set to undefined is still a missing translation.
      if (value !== undefined) translations.set(localeKey, validate(value))
    }
    canonical.set(normalized, {
      key: key === "/" ? "/" : key.replace(/\/$/, ""),
      canonical: segments,
      translations,
    })
  }
  for (const entry of canonical.values()) {
    for (const translated of entry.translations.values()) {
      const shadowed = canonical.get(pathnameOf(translated))
      if (shadowed !== undefined && shadowed !== entry) {
        throw new Error(
          `pathnames: translation of ${JSON.stringify(entry.key)} shadows canonical pathname ${JSON.stringify(shadowed.key)}`,
        )
      }
    }
  }
  for (const locale of locales.served) {
    const paths = new Map<string, Entry<K>>()
    for (const entry of canonical.values()) {
      const path = pathnameOf(entry.translations.get(locale) ?? entry.canonical)
      const other = paths.get(path)
      if (other !== undefined) {
        throw new Error(
          `pathnames: duplicate public pathname ${JSON.stringify(path)} for locale ${JSON.stringify(locale)} (${JSON.stringify(other.key)} and ${JSON.stringify(entry.key)})`,
        )
      }
      paths.set(path, entry)
    }
    publicByLocale.set(locale, paths)
  }
  const lookupKey = (segments: readonly string[]): string | undefined => {
    const normalized = normalizedSegments(segments)
    return normalized === undefined ? undefined : pathnameOf(normalized)
  }
  const entryFor = (segments: readonly string[]): Entry<K> | undefined => {
    const key = lookupKey(segments)
    return key === undefined ? undefined : canonical.get(key)
  }
  return {
    canonical(segments: readonly string[], locale: K): readonly string[] {
      const key = lookupKey(segments)
      const entry =
        key === undefined ? undefined : (canonical.get(key) ?? publicByLocale.get(locale)?.get(key))
      return entry?.canonical ?? segments
    },
    localized(segments: readonly string[], locale: K): readonly string[] {
      const entry = entryFor(segments)
      return entry?.translations.get(locale) ?? entry?.canonical ?? segments
    },
    pageKey(segments: readonly string[]): string {
      return entryFor(segments)?.key ?? pathnameOf(segments)
    },
    // A new array keeps callers from mutating the compiled table.
    canonicalPaths(): readonly (readonly string[])[] {
      return [...canonical.values()].map((entry) => entry.canonical)
    },
  }
}
