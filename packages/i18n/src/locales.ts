/**
 * One locale registry the rest of i18n reads: the URL segment, the BCP-47 tag `Intl` formats with, the
 * `hreflang` value search engines match, the writing direction and the language's own name, per
 * locale. Routing, alternates, the document `lang`/`dir` and catalog fallback all take it, so a
 * locale is declared once instead of in several lists that drift apart.
 *
 * Validated once at definition (bad tags, unsafe segments, duplicates and a missing default throw
 * there), so nothing on a request path re-checks. Pure and dependency-free.
 */

/** How one locale is declared. Every field has a default derived from the URL segment. */
export interface LocaleSpec {
  /** The BCP-47 tag `Intl` formats with (`"ur-PK"`). Default: the URL segment. */
  readonly tag?: string
  /** The `hreflang` value search engines match (`"hi-IN"`, or `"ur"` for a language not tied to one
   * market). Default: the tag. */
  readonly hreflang?: string
  /** Writing direction. Default: derived from the tag (see {@link localeDirection}). */
  readonly dir?: "ltr" | "rtl"
  /** The language's name in itself, for a language switcher (`"हिन्दी"`). Default: what
   * `Intl.DisplayNames` gives in that language, or the tag where the runtime has none. */
  readonly name?: string
  /** Catalogs exist but the locale is not served yet: routing never matches it and alternates never
   * list it, so an unfinished translation cannot be indexed under its own URL. */
  readonly draft?: boolean
}

/** One locale with every field resolved. */
export interface LocaleInfo<K extends string = string> {
  /** The registry key: the URL segment, and the key catalogs are stored under. */
  readonly key: K
  /** Canonical BCP-47 tag, for `Intl` and `<html lang>`. */
  readonly tag: string
  /** Canonical `hreflang` value. */
  readonly hreflang: string
  readonly dir: "ltr" | "rtl"
  readonly name: string
  readonly draft: boolean
}

/** What {@link defineLocales} takes. */
export interface LocalesConfig<K extends string> {
  /** The default locale: served, and the last step of every fallback chain. */
  readonly default: NoInfer<K>
  /** Every locale, keyed by URL segment, in the order alternates and switchers list them. */
  readonly locales: { readonly [P in K]: LocaleSpec }
}

/** The registry {@link defineLocales} returns. */
export interface Locales<K extends string = string> {
  readonly default: K
  /** Every declared locale, in declaration order. */
  readonly all: readonly K[]
  /** The non-draft locales, in declaration order. */
  readonly served: readonly K[]
  /** Every resolved field of a declared locale. Throws for an undeclared key. */
  get(key: K): LocaleInfo<K>
  /** Whether `value` is a served locale's key, exactly as declared. */
  isServed(value: string): value is K
  /** The catalog fallback order for `key`: itself, then the declared locale of its base language
   * (`fr-CA` → `fr`), then the default, without repeats. */
  chain(key: K): readonly K[]
  /** `{ lang, dir }` for a route's `meta`, so `<html lang>` and `<html dir>` follow the locale. */
  documentMeta(key: K): { readonly lang: string; readonly dir: "ltr" | "rtl" }
}

/** Locale names become URL path segments; reject delimiters and control characters up front. */
export function isSafeLocaleSegment(value: string): boolean {
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

// Languages written right-to-left in their usual script. Checked before the likely-script lookup so
// the common cases never depend on an engine's CLDR data, which can differ between the server and
// the browser and would flip `<html dir>` during hydration.
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "ckb",
  "dv",
  "fa",
  "he",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
])
// ISO 15924 scripts written right-to-left.
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
  "Adlm",
  "Arab",
  "Hebr",
  "Mand",
  "Mend",
  "Nkoo",
  "Rohg",
  "Samr",
  "Syrc",
  "Thaa",
  "Yezi",
])

/**
 * The writing direction of a BCP-47 tag: an explicit script subtag decides (`pa-Arab` is rtl,
 * `sd-Deva` ltr), then the language (`ur`, `ar`, `he`, ...), then the script the runtime's likely-
 * subtags data gives for a rarer language. `ltr` when none of those says rtl, including for a tag
 * the runtime cannot parse.
 */
export function localeDirection(tag: string): "ltr" | "rtl" {
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(tag)
  } catch {
    return RTL_LANGUAGES.has(tag.split("-")[0]?.toLowerCase() ?? "") ? "rtl" : "ltr"
  }
  if (locale.script !== undefined) return RTL_SCRIPTS.has(locale.script) ? "rtl" : "ltr"
  if (RTL_LANGUAGES.has(locale.language)) return "rtl"
  try {
    const script = locale.maximize().script
    return script !== undefined && RTL_SCRIPTS.has(script) ? "rtl" : "ltr"
  } catch {
    return "ltr"
  }
}

function canonicalTag(value: string, field: string, key: string): string {
  let canonical: string | undefined
  try {
    canonical = Intl.getCanonicalLocales(value)[0]
  } catch {
    canonical = undefined
  }
  if (canonical === undefined) {
    throw new Error(
      `defineLocales: ${field} ${JSON.stringify(value)} of locale ${JSON.stringify(key)} is not a BCP-47 language tag`,
    )
  }
  return canonical
}

function nativeName(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag
  } catch {
    return tag
  }
}

/**
 * Declare the app's locales once.
 *
 * ```ts
 * import { defineLocales } from "@nifrajs/i18n"
 *
 * export const locales = defineLocales({
 *   default: "en",
 *   locales: {
 *     en: { hreflang: "en-IN" },
 *     hi: { hreflang: "hi-IN" },
 *     ur: { tag: "ur-PK", hreflang: "ur" }, // dir: "rtl", derived
 *     gu: { draft: true }, // catalogs in progress, not served
 *   },
 * })
 * ```
 */
export function defineLocales<const K extends string>(config: LocalesConfig<K>): Locales<K> {
  const all = Object.keys(config.locales) as K[]
  if (all.length === 0) throw new Error("defineLocales: locales must not be empty")
  const specs = config.locales as Readonly<Record<string, LocaleSpec | undefined>>
  const defaultKey = config.default
  if (!Object.hasOwn(specs, defaultKey)) {
    throw new Error(`defineLocales: default ${JSON.stringify(defaultKey)} is not in locales`)
  }
  if (specs[defaultKey]?.draft === true) {
    throw new Error(`defineLocales: default ${JSON.stringify(defaultKey)} cannot be a draft`)
  }

  const byLower = new Map<string, string>()
  const byHreflang = new Map<string, string>()
  const resolved = new Map<string, Omit<LocaleInfo<K>, "name"> & { readonly name?: string }>()
  for (const key of all) {
    if (!isSafeLocaleSegment(key)) {
      throw new Error(
        `defineLocales: locale ${JSON.stringify(key)} must be one safe URL path segment`,
      )
    }
    const lower = key.toLowerCase()
    const clash = byLower.get(lower)
    if (clash !== undefined) {
      throw new Error(
        `defineLocales: locales ${JSON.stringify(clash)} and ${JSON.stringify(key)} differ only by case`,
      )
    }
    byLower.set(lower, key)
    const spec = specs[key] ?? {}
    if (spec.dir !== undefined && spec.dir !== "ltr" && spec.dir !== "rtl") {
      throw new Error(`defineLocales: dir of locale ${JSON.stringify(key)} must be "ltr" or "rtl"`)
    }
    const tag = canonicalTag(spec.tag ?? key, "tag", key)
    const hreflang = canonicalTag(spec.hreflang ?? tag, "hreflang", key)
    const draft = spec.draft === true
    if (!draft) {
      const other = byHreflang.get(hreflang.toLowerCase())
      if (other !== undefined) {
        throw new Error(
          `defineLocales: locales ${JSON.stringify(other)} and ${JSON.stringify(key)} share hreflang ${JSON.stringify(hreflang)}, so search engines could not tell their pages apart`,
        )
      }
      byHreflang.set(hreflang.toLowerCase(), key)
    }
    resolved.set(key, {
      key,
      tag,
      hreflang,
      dir: spec.dir ?? localeDirection(tag),
      draft,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
    })
  }

  // Arrays stay unfrozen (typed readonly): a frozen array reads several times slower on JSC and V8,
  // and alternates and switchers iterate these on every render.
  const served: readonly K[] = all.filter((key) => resolved.get(key)?.draft !== true)
  const servedSet: ReadonlySet<string> = new Set(served)
  // A default name is resolved on first read of `name`: `Intl.DisplayNames` is the one costly default,
  // and an app that never renders a switcher never pays it.
  const infos = new Map<string, LocaleInfo<K>>()
  for (const [key, entry] of resolved) {
    let name = entry.name
    const info = { ...entry } as { -readonly [F in keyof LocaleInfo<K>]: LocaleInfo<K>[F] }
    Object.defineProperty(info, "name", {
      enumerable: true,
      get: () => {
        if (name === undefined) name = nativeName(entry.tag)
        return name
      },
    })
    infos.set(key, Object.freeze(info))
  }
  const get = (key: K): LocaleInfo<K> => {
    const info = infos.get(key)
    if (info === undefined) throw new Error(`locales.get: ${JSON.stringify(key)} is not declared`)
    return info
  }

  const chains = new Map<string, readonly K[]>()
  const chain = (key: K): readonly K[] => {
    const cached = chains.get(key)
    if (cached !== undefined) return cached
    const { tag } = get(key)
    const order: K[] = [key]
    const language = tag.split("-")[0] as string
    const base = all.find((other) => resolved.get(other)?.tag === language)
    if (base !== undefined && !order.includes(base)) order.push(base)
    if (!order.includes(defaultKey)) order.push(defaultKey)
    chains.set(key, order)
    return order
  }

  return Object.freeze({
    default: defaultKey,
    all: [...all] as readonly K[],
    served,
    get,
    isServed: (value: string): value is K => servedSet.has(value),
    chain,
    documentMeta: (key: K) => {
      const { tag, dir } = get(key)
      return Object.freeze({ lang: tag, dir })
    },
  })
}
