/**
 * `@nifrajs/i18n/copy` - translations written next to the code that shows them, as one table per
 * string (`copy({ en: "Bicycle", hi: "साइकिल" })`) instead of one catalog per locale. Tables are typed
 * against a {@link Locales} registry, fall back through `locales.chain()`, and format ICU messages with
 * the same engine as `createFormatter`.
 *
 * A production client build by `@nifrajs/web` moves every table it can read statically out of the
 * modules into one chunk per locale, so a page downloads its own locale's copy and not every other
 * one; the server keeps every locale. Tables read the same either way.
 */

import { isRecord } from "@nifrajs/utils/record"
import { formatMessage } from "./format.ts"
import type { Locales } from "./locales.ts"

/** A copy value: a message, a list, or a nested block of either. Never a function: a message that
 * takes values is an ICU message read with {@link Copy.format}. */
export type CopyValue = string | readonly CopyValue[] | { readonly [key: string]: CopyValue }

// What a table's default value is checked against. Not `CopyValue`: TypeScript cannot infer a `const`
// type parameter bounded by a recursive union without running out of instantiation depth.
type CopyInput = string | readonly unknown[] | { readonly [key: string]: unknown }

/** The shape every locale's value must have, given the default locale's value `V`: the same lists
 * (of the same length) and blocks (with the same keys), with any message where `V` has one. */
export type CopyShape<V> = V extends string
  ? string
  : V extends readonly unknown[]
    ? { readonly [I in keyof V]: CopyShape<V[I]> }
    : { readonly [P in keyof V]: CopyShape<V[P]> }

/** What a table takes: the default locale's value, and the other declared locales' values, each
 * optional and shaped like the default's. An undeclared locale key is a type error. */
export type CopyEntries<K extends string, D extends K, V> = { readonly [P in D]: V } & {
  readonly [P in Exclude<K, D>]?: NoInfer<CopyShape<V>>
}

declare const VALUE: unique symbol

/** A table {@link Copy} made. Opaque: read it with {@link Copy.pick} or {@link Copy.format}. */
export interface CopyTable<V = CopyValue> {
  readonly [VALUE]?: V
}

/** A locale a table had no value for, reported to {@link CopyOptions.onMissing}. */
export interface CopyMissing<K extends string = string> {
  /** The locale the table was read in. */
  readonly locale: K
  /** The locale whose value was used instead: the next in `locales.chain(locale)` with one. */
  readonly fallback: K
  /** The table's id: the one passed to {@link Copy.id}, or the `file:line` a production client build
   * assigns. `undefined` for an unnamed table outside such a build. */
  readonly id: string | undefined
}

export interface CopyOptions<K extends string = string> {
  /** Called once per table and locale when a table has no value for the locale it is read in. Pass a
   * stable function: it is kept for the life of the copy definition. */
  readonly onMissing?: ((missing: CopyMissing<K>) => void) | undefined
  /**
   * The locale a URL renders in, so a production client build loads that locale's copy before it
   * renders the page, and before a client navigation renders the next one. Default: the URL's first
   * path segment when it is a served locale, else the default locale; the first page also loads the
   * locale its `<html lang>` names. Pass it when the locale comes from elsewhere (a cookie, a
   * subdomain), for example `(url) => urls.localeOf(url.pathname)`.
   */
  readonly localeOf?: ((url: URL) => K | undefined) | undefined
}

/** The copy function {@link defineCopy} returns. */
export interface Copy<K extends string = string, D extends K = K> {
  /** A table: the default locale's value is required, every other declared locale's is optional. */
  <const V extends CopyInput>(entries: CopyEntries<K, D, V>): CopyTable<CopyShape<V>>
  /** A table with an explicit id, which `nifra i18n check` and {@link CopyOptions.onMissing} report
   * instead of its `file:line`. Ids are unique per app. */
  id<const V extends CopyInput>(id: string, entries: CopyEntries<K, D, V>): CopyTable<CopyShape<V>>
  /** The table's value in `locale`, or in the first locale of `locales.chain(locale)` that has one. */
  pick<V>(table: CopyTable<V>, locale: K): V
  /** Format a message table in `locale` with ICU `vars` (`{n, plural, ...}`), as `t()` does. */
  format(table: CopyTable<string>, locale: K, vars?: Readonly<Record<string, unknown>>): string
  /**
   * Load a locale's copy in a production client build, where each locale's copy is its own chunk:
   * for a page that reads a locale other than the one it renders in (a "read this in Hindi" banner).
   * Without `locale`, the locale the current page renders in. Resolves at once on the server, in dev,
   * and once the locale is loaded.
   */
  load(locale?: K): Promise<void>
  /** The registry the tables are typed against. */
  readonly locales: Locales<K, D>
}

/** A table's runtime record: its values (source tables), or the id a production client build gave it
 * in place of them (chunk tables). */
interface TableData {
  readonly values?: Readonly<Record<string, CopyValue>>
  readonly id?: string
}

/** One locale's chunk, as the client build writes it: values by table id, and for each table that
 * fell back, its readable id and the locale whose value it carries. */
interface Chunk {
  readonly v: Readonly<Record<string, CopyValue>>
  readonly f?: Readonly<Record<string, readonly [string, string]>>
}

/** A copy definition as the client entry and the server renderer see it. */
interface CopyInstance {
  localeFor(url: URL): string
  /** The locales a page at `url` whose `<html lang>` is `lang` reads its copy in. */
  pageLocales(url: URL, lang: string | undefined): readonly string[]
  load(locale?: string): Promise<void>
}

/** State shared by every copy of this module in a realm, so two instances of the package agree on
 * what is loaded. */
interface CopyRealm {
  readonly instances: Set<CopyInstance>
  readonly chunks: Map<string, Chunk>
  readonly loading: Map<string, Promise<void>>
  /** Load the copy a client navigation to `path` renders with. Called by the generated client entry. */
  prepare(path: string): Promise<void>
  /** The locales whose chunks a server-rendered page at `path` loads first, for its preload links. */
  pageLocales(path: string, lang: string | undefined): readonly string[]
}

/** Locale key -> chunk URL, from the server's page handover in a production client build. */
export const COPY_CHUNKS_GLOBAL = "__NIFRA_COPY__"
const REALM_KEY = Symbol.for("nifra.copy")
// Instances a long-lived process keeps: dev re-evaluates modules on every edit.
const MAX_INSTANCES = 32
const LOCAL_ORIGIN = "http://localhost"

const realm = (): CopyRealm => {
  const existing: unknown = Reflect.get(globalThis, REALM_KEY)
  if (isRealm(existing)) return existing
  const instances = new Set<CopyInstance>()
  const created: CopyRealm = {
    instances,
    chunks: new Map(),
    loading: new Map(),
    async prepare(path) {
      const url = new URL(path, currentHref() ?? LOCAL_ORIGIN)
      await Promise.all([...instances].map((instance) => instance.load(instance.localeFor(url))))
    },
    pageLocales(path, lang) {
      const url = new URL(path, LOCAL_ORIGIN)
      return [...new Set([...instances].flatMap((instance) => instance.pageLocales(url, lang)))]
    },
  }
  Reflect.set(globalThis, REALM_KEY, created)
  return created
}

// Another copy of this module in the realm may be an older one, with a different shape: then this one
// keeps its own.
const isRealm = (value: unknown): value is CopyRealm =>
  isRecord(value) &&
  value.instances instanceof Set &&
  value.chunks instanceof Map &&
  value.loading instanceof Map &&
  typeof value.prepare === "function" &&
  typeof value.pageLocales === "function"
const isChunk = (value: unknown): value is Chunk =>
  isRecord(value) && isRecord(value.v) && (value.f === undefined || isRecord(value.f))
const isTableData = (value: unknown): value is TableData =>
  isRecord(value) && (isRecord(value.values) || typeof value.id === "string")
const isCopyValue = (value: unknown, depth = 0): value is CopyValue => {
  if (typeof value === "string") return true
  if (depth > 32 || value === null || typeof value !== "object") return false
  return (Array.isArray(value) ? value : Object.values(value)).every((item) =>
    isCopyValue(item, depth + 1),
  )
}

// This package compiles without the DOM types, and runs where there is no document.
const currentHref = (): string | undefined => {
  const location: unknown = Reflect.get(globalThis, "location")
  const href = isRecord(location) ? location.href : undefined
  return typeof href === "string" ? href : undefined
}
const documentLang = (): string | undefined => {
  const document: unknown = Reflect.get(globalThis, "document")
  const root = isRecord(document) ? document.documentElement : undefined
  const lang = isRecord(root) ? root.lang : undefined
  return typeof lang === "string" && lang !== "" ? lang : undefined
}

function loadChunk(locale: string): Promise<void> {
  const { chunks, loading } = realm()
  if (chunks.has(locale)) return Promise.resolve()
  const pending = loading.get(locale)
  if (pending !== undefined) return pending
  const urls: unknown = Reflect.get(globalThis, COPY_CHUNKS_GLOBAL)
  const url = isRecord(urls) ? urls[locale] : undefined
  if (typeof url !== "string") {
    return Promise.reject(
      new Error(
        `[nifra/i18n] no copy chunk for locale ${JSON.stringify(locale)} in this page. A production client build moves copy tables into one chunk per locale, and the server lists them in the page; a hand-written server entry passes \`copyChunks\` from the server manifest to createWebApp.`,
      ),
    )
  }
  const load = import(/* @vite-ignore */ url).then((mod: { readonly default?: unknown }) => {
    const chunk = mod.default
    if (!isChunk(chunk)) throw new Error(`[nifra/i18n] ${url} is not a copy chunk`)
    chunks.set(locale, chunk)
  })
  loading.set(locale, load)
  // A failed load may be retried by the next navigation.
  load.catch(() => loading.delete(locale))
  return load
}

/**
 * The table id a production client build emits in place of a table's values. Build output only:
 * apps write {@link Copy} calls.
 */
export function copyRef(id: string): CopyTable {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a CopyTable is the opaque face of a table record, and pick() reads it back through isTableData.
  return Object.freeze({ id }) as CopyTable
}

/**
 * Bind copy tables to a locale registry.
 *
 * ```ts
 * // shared/i18n.ts
 * import { defineLocales } from "@nifrajs/i18n"
 * import { defineCopy } from "@nifrajs/i18n/copy"
 *
 * export const locales = defineLocales({ default: "en", locales: { en: {}, hi: {}, ur: { tag: "ur-PK" } } })
 * export const copy = defineCopy(locales)
 *
 * // routes/[[lang]]/index.tsx
 * const TITLE = copy({ en: "Bicycle", hi: "साइकिल", ur: "سائیکل" })
 * const FOUND = copy({ en: "{n, plural, one {# result} other {# results}}", hi: "{n} परिणाम" })
 * copy.pick(TITLE, locale)
 * copy.format(FOUND, locale, { n: 3 })
 * ```
 */
export function defineCopy<K extends string, D extends K>(
  locales: Locales<K, D>,
  options: CopyOptions<K> = {},
): Copy<K, D> {
  const { onMissing, localeOf } = options
  if (onMissing !== undefined && typeof onMissing !== "function") {
    throw new TypeError("defineCopy: onMissing must be a function")
  }
  if (localeOf !== undefined && typeof localeOf !== "function") {
    throw new TypeError("defineCopy: localeOf must be a function")
  }
  const declared: ReadonlySet<string> = new Set(locales.all)
  const isLocale = (key: string): key is K => declared.has(key)
  const shared = realm()

  const table = (entries: unknown, id: string | undefined): TableData => {
    if (!isRecord(entries))
      throw new TypeError("copy: a table must be an object of values by locale")
    if (!Object.hasOwn(entries, locales.default) || entries[locales.default] === undefined) {
      throw new TypeError(
        `copy: a table must have a value for the default locale ${JSON.stringify(locales.default)}`,
      )
    }
    const values: Record<string, CopyValue> = {}
    for (const [key, value] of Object.entries(entries)) {
      if (!declared.has(key)) {
        throw new TypeError(`copy: ${JSON.stringify(key)} is not a declared locale`)
      }
      if (typeof value === "function") {
        throw new TypeError(`copy: the ${key} value is a function; use an ICU message and format()`)
      }
      if (value === undefined) continue
      if (!isCopyValue(value)) {
        throw new TypeError(`copy: the ${key} value is not a message, or a list or block of them`)
      }
      values[key] = value
    }
    return Object.freeze(id === undefined ? { values } : { values, id })
  }

  // Each table and locale is reported once: source tables by identity, chunk tables by id.
  const reportedTables = new WeakMap<object, Set<string>>()
  const reportedIds = new Map<string, Set<string>>()
  const report = (data: TableData, missing: CopyMissing<K>, byId: boolean): void => {
    if (onMissing === undefined) return
    let seen = byId ? reportedIds.get(data.id ?? "") : reportedTables.get(data)
    if (seen === undefined) {
      seen = new Set()
      if (byId) reportedIds.set(data.id ?? "", seen)
      else reportedTables.set(data, seen)
    }
    if (seen.has(missing.locale)) return
    seen.add(missing.locale)
    onMissing(missing)
  }

  let warned = false
  const fromChunk = (data: TableData, id: string, locale: K): CopyValue => {
    const chunk = shared.chunks.get(locale)
    if (chunk !== undefined) {
      const value = chunk.v[id]
      if (value === undefined) {
        throw new Error(
          `[nifra/i18n] copy table ${id} is not in the ${locale} chunk; the page and its client build disagree`,
        )
      }
      const fell = chunk.f?.[id]
      if (fell !== undefined) {
        if (isLocale(fell[1])) report(data, { locale, fallback: fell[1], id: fell[0] }, true)
      }
      return value
    }
    if (Reflect.get(globalThis, COPY_CHUNKS_GLOBAL) === undefined) {
      throw new Error(
        `[nifra/i18n] copy table ${id} comes from a production client build, and this page lists no copy chunks; a hand-written server entry passes \`copyChunks\` from the server manifest to createWebApp`,
      )
    }
    // Read before its chunk loaded: load it for next time, and show the closest locale on hand.
    loadChunk(locale).catch(() => {})
    if (!warned) {
      warned = true
      console.error(
        `[nifra/i18n] copy for ${JSON.stringify(locale)} was read before it loaded. Pass defineCopy a \`localeOf\` that names the locale each URL renders in, or await copy.load(${JSON.stringify(locale)}) before reading it.`,
      )
    }
    for (const key of locales.chain(locale)) {
      const value = shared.chunks.get(key)?.v[id]
      if (value !== undefined) return value
    }
    for (const other of shared.chunks.values()) {
      const value = other.v[id]
      if (value !== undefined) return value
    }
    throw new Error(`[nifra/i18n] no copy is loaded, so table ${id} cannot be read`)
  }

  const pick = (handle: CopyTable<unknown>, locale: K): CopyValue => {
    const data: unknown = handle
    if (!isTableData(data)) throw new TypeError("copy.pick: not a copy table")
    const values = data.values
    if (values === undefined) {
      if (typeof data.id !== "string") throw new TypeError("copy.pick: not a copy table")
      return fromChunk(data, data.id, locale)
    }
    for (const key of locales.chain(locale)) {
      const value = values[key]
      if (value === undefined) continue
      if (key !== locale) report(data, { locale, fallback: key, id: data.id }, false)
      return value
    }
    throw new TypeError(`copy.pick: the table has no ${locales.default} value`)
  }

  const firstSegment = (url: URL): K | undefined => {
    const end = url.pathname.indexOf("/", 1)
    const segment = url.pathname.slice(1, end === -1 ? undefined : end)
    return locales.isServed(segment) ? segment : undefined
  }
  const localeFor = (url: URL): K => localeOf?.(url) ?? firstSegment(url) ?? locales.default
  // The locale `<html lang>` names, matched by tag, then by language.
  const documentLocale = (lang: string | undefined): K | undefined => {
    if (lang === undefined) return undefined
    const lower = lang.toLowerCase()
    const language = lower.split("-")[0]
    let byLanguage: K | undefined
    for (const key of locales.all) {
      const tag = locales.get(key).tag.toLowerCase()
      if (tag === lower) return key
      if (byLanguage === undefined && tag.split("-")[0] === language) byLanguage = key
    }
    return byLanguage
  }

  // Both the URL's locale and the one `<html lang>` names: a page that never sets `lang` still
  // renders `lang="en"`, so neither alone is proof of what the server rendered.
  const pageLocales = (url: URL, lang: string | undefined): readonly K[] => {
    const fromUrl = localeFor(url)
    const named = documentLocale(lang)
    return named === undefined || named === fromUrl ? [fromUrl] : [fromUrl, named]
  }
  const instance: CopyInstance = {
    localeFor,
    pageLocales,
    load: async (locale) => {
      // Nothing to load where tables keep their values: the server, dev, and unsplit builds.
      if (Reflect.get(globalThis, COPY_CHUNKS_GLOBAL) === undefined) return
      if (locale !== undefined) return loadChunk(locale)
      const url = new URL(currentHref() ?? "/", LOCAL_ORIGIN)
      await Promise.all(pageLocales(url, documentLang()).map(loadChunk))
    },
  }
  shared.instances.add(instance)
  if (shared.instances.size > MAX_INSTANCES) {
    const oldest = shared.instances.values().next()
    if (oldest.done !== true) shared.instances.delete(oldest.value)
  }

  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: table() checks at run time what Copy's generic signature types, and a CopyTable is a table record's opaque face.
  const copy = ((entries: unknown) => table(entries, undefined)) as Copy<K, D>
  return Object.freeze(
    Object.assign(copy, {
      id: (id: string, entries: unknown) => {
        if (typeof id !== "string" || id === "") {
          throw new TypeError("copy.id: the id must be a non-empty string")
        }
        return table(entries, id)
      },
      pick,
      format: (
        handle: CopyTable<string>,
        locale: K,
        vars: Readonly<Record<string, unknown>> = {},
      ): string => {
        const message = pick(handle, locale)
        if (typeof message !== "string") {
          throw new TypeError("copy.format: the table's value is not a message")
        }
        return formatMessage(locales.get(locale).tag, message, vars)
      },
      load: (locale?: K) => instance.load(locale),
      locales,
    }),
  )
}
