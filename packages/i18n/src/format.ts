/**
 * A tiny ICU message formatter on the platform `Intl`. Supports interpolation (`{name}`), `plural`
 * (`{n, plural, one {# item} other {# items}}`, with `=N` exact cases), `selectordinal`
 * (`{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`) and `select`
 * (`{kind, select, a {…} other {…}}`), nested arbitrarily. Inside a `plural` or `selectordinal` case,
 * `#` is the number in the locale's own format (`1,000`, or `१,०००` with `numberingSystem: "deva"`).
 * Parsed by a hand-written recursive descent (a regex can't match nested `{}`); ASTs are cached per
 * catalog entry. `Intl.MessageFormat` isn't widely available yet, so this is the portable subset.
 *
 * Catalogs may nest: values are ICU strings, lists, or blocks of either, read with dotted keys
 * (`t("home.title")`). A flat key that contains a dot is found first, so flat catalogs keep working.
 *
 * Not supported (documented non-goals): inline `{n, number}`/`{d, date}` skeletons (use `n`/`d`),
 * `offset:`, and apostrophe quoting. A key no catalog has returns the key itself and a missing var
 * renders empty. A malformed message fails soft to its raw string so one bad catalog entry does not
 * 500 SSR.
 */

/** One catalog value: an ICU message, a list (FAQ items), or a nested block of either. */
export type MessageValue = string | readonly MessageValue[] | MessageTree

/** A message catalog: ICU strings, lists and nested blocks, keyed by name. */
export interface MessageTree {
  [key: string]: MessageValue
}

/** A flat catalog of ICU strings. Any {@link MessageTree} is accepted where a catalog is taken. */
export type Messages = Record<string, string>

/**
 * The app's catalog type, declared once so every `t()` key is checked. Empty by default (keys are
 * plain strings). Augment it with the default locale's catalog:
 *
 * ```ts
 * import type en from "./messages/en.json"
 *
 * declare module "@nifrajs/i18n" {
 *   interface Register {
 *     messages: typeof en
 *   }
 * }
 * ```
 *
 * With that, `useT().t("home.titel")` is a compile error, and other locales' catalogs are checked
 * against {@link Translation}.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target - empty by design, apps fill it.
export interface Register {}

/** The catalog type {@link Register} declares, or {@link MessageTree} when it declares none. */
export type RegisteredMessages = Register extends { readonly messages: infer M extends object }
  ? M
  : MessageTree

type Defined<V> = Exclude<V, undefined>
type Keys<T> = Extract<keyof T, string | number>
// Recursion budget for the path types: ten levels of nesting, plenty for a catalog, and it keeps the
// checker away from its instantiation-depth limit.
type Next = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

type LeafPaths<T, D extends number> = [D] extends [never]
  ? never
  : T extends readonly (infer E)[]
    ? Defined<E> extends string
      ? `${number}`
      : Defined<E> extends object
        ? `${number}.${LeafPaths<Defined<E>, Next[D]>}`
        : never
    : {
        // A key that itself contains a dot is only reachable as a whole, so only its own value counts.
        [K in Keys<T>]: K extends `${string}.${string}`
          ? Defined<T[K]> extends string
            ? `${K}`
            : never
          : Defined<T[K]> extends string
            ? `${K}`
            : Defined<T[K]> extends object
              ? `${K}.${LeafPaths<Defined<T[K]>, Next[D]>}`
              : never
      }[Keys<T>]

type AllPaths<T, D extends number> = [D] extends [never]
  ? never
  : T extends readonly (infer E)[]
    ?
        | `${number}`
        | (Defined<E> extends string
            ? never
            : Defined<E> extends object
              ? `${number}.${AllPaths<Defined<E>, Next[D]>}`
              : never)
    : {
        [K in Keys<T>]: K extends `${string}.${string}`
          ? `${K}`
          :
              | `${K}`
              | (Defined<T[K]> extends string
                  ? never
                  : Defined<T[K]> extends object
                    ? `${K}.${AllPaths<Defined<T[K]>, Next[D]>}`
                    : never)
      }[Keys<T>]

/** The dotted keys of `M` whose value is a message, which is what `t()` takes. `string` for an
 * untyped catalog. */
export type MessageKey<M> = string extends keyof M ? string : LeafPaths<M, 10>

/** Every dotted key of `M`, blocks and lists included, which is what `get()` takes. */
export type MessagePath<M> = string extends keyof M ? string : AllPaths<M, 10>

/** The type of the value at dotted key `P` in `M`, resolved the way the formatter looks it up: the
 * whole key first, then segment by segment. */
export type MessageAt<M, P extends string> = string extends keyof M
  ? MessageValue
  : M extends readonly (infer E)[]
    ? P extends `${number}`
      ? E
      : P extends `${infer H}.${infer R}`
        ? H extends `${number}`
          ? MessageAt<Defined<E>, R>
          : never
        : never
    : P extends keyof M
      ? M[P]
      : P extends `${infer H}.${infer R}`
        ? H extends keyof M
          ? MessageAt<Defined<M[H]>, R>
          : never
        : never

type PartialValue<V> = V extends string
  ? string
  : V extends readonly (infer E)[]
    ? readonly PartialValue<E>[]
    : V extends object
      ? PartialMessages<V>
      : V

/** Another locale's catalog for `M`: every key optional at every level, and any string where `M`
 * has one. A key it lacks falls back through the formatter's `fallback` catalogs. */
export type PartialMessages<M> = string extends keyof M
  ? M
  : { readonly [K in keyof M]?: PartialValue<M[K]> }

/** A catalog `createFormatter` accepts for `M`. */
type CatalogFor<M> = string extends keyof M ? MessageTree : PartialMessages<M>

/** Any locale's catalog for the {@link Register}ed type ({@link MessageTree} when none is declared). */
export type Translation = CatalogFor<RegisteredMessages>

export interface FormatterOptions<M extends object = RegisteredMessages> {
  /** Catalogs to try, in order, for a key `messages` lacks: typically the base language's, then the
   * default locale's (`locales.chain(key)` gives that order). The formatter's locale still formats a
   * fallback message's numbers, dates and plurals. */
  readonly fallback?: readonly CatalogFor<M>[] | undefined
  /** Called with a key no catalog has, once per key per formatter, before the key is returned. Pass a
   * stable function (module scope): formatters are cached per handler, so a new function on every
   * render builds a new formatter every render. */
  readonly onMissing?: ((key: string, locale: string) => void) | undefined
  /** Default `timeZone` for `d()`. An invalid zone throws here, like `Intl.DateTimeFormat`. */
  readonly timeZone?: string | undefined
  /** Default `numberingSystem` (`"deva"`, `"arab"`, ...) for `n()`, `d()` and plural `#`. */
  readonly numberingSystem?: string | undefined
}

export interface Formatter<M extends object = RegisteredMessages> {
  readonly locale: string
  /** Format the ICU message at `key` with `vars`, trying `fallback` catalogs in order. A key no
   * catalog has calls `onMissing` and returns the key itself. */
  t(key: MessageKey<M>, vars?: Readonly<Record<string, unknown>>): string
  /** The raw value at `key` (a message, list or block) from the first catalog that has it, without
   * merging catalogs. `undefined`, after `onMissing`, when none has it. */
  get<P extends MessagePath<M>>(key: P): MessageAt<M, P> | undefined
  /** Locale number formatting (memoized `Intl.NumberFormat`). */
  n(value: number | bigint, options?: Intl.NumberFormatOptions): string
  /** Locale date/time formatting (memoized `Intl.DateTimeFormat`). */
  d(value: Date | number, options?: Intl.DateTimeFormatOptions): string
}

/** A parsed message node. Internal: shared with `./rich.ts`, never exported from the package root. */
export type Part = string | InterpNode | PoundNode | ChoiceNode
interface InterpNode {
  readonly kind: "interp"
  readonly arg: string
}
interface PoundNode {
  readonly kind: "pound"
}
interface ChoiceNode {
  readonly kind: "plural" | "selectordinal" | "select"
  readonly arg: string
  readonly cases: ReadonlyMap<string, readonly Part[]>
  /** Whether any case is an exact `=N` match, so the others skip building the `=N` key. */
  readonly exact: boolean
}

const POUND: PoundNode = Object.freeze({ kind: "pound" })

const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch)

const skipWs = (s: string, i: number): number => {
  let j = i
  while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++
  return j
}

// Parse errors never escape `t()` (a malformed message renders raw); they carry a position so a
// catalog check can point at the problem.
function fail(what: string, at: number): never {
  throw new SyntaxError(`[nifra/i18n] ${what} at ${at}`)
}

const readToken = (s: string, i: number): { value: string; end: number } => {
  let j = i
  // a case name may be `=N`; otherwise an identifier run
  if (s[j] === "=") j++
  while (j < s.length && isIdentChar(s[j] as string)) j++
  return { value: s.slice(i, j), end: j }
}

/** Parse a (sub-)message starting at `start`, stopping at a top-level `}` or end. Inside a plural
 * case `#` becomes a number node; elsewhere it is literal text. */
function parseMessage(s: string, start: number, pound: boolean): { parts: Part[]; end: number } {
  const parts: Part[] = []
  let literal = ""
  let i = start
  while (i < s.length && s[i] !== "}") {
    const ch = s[i] as string
    if (ch === "{" || (pound && ch === "#")) {
      if (literal !== "") {
        parts.push(literal)
        literal = ""
      }
      if (ch === "#") {
        parts.push(POUND)
        i++
        continue
      }
      const placeholder = parsePlaceholder(s, i, pound)
      parts.push(placeholder.node)
      i = placeholder.end
      continue
    }
    literal += ch
    i++
  }
  if (literal !== "") parts.push(literal)
  return { parts, end: i }
}

function parseRootMessage(s: string): readonly Part[] {
  const parsed = parseMessage(s, 0, false)
  if (parsed.end !== s.length) fail("unexpected '}'", parsed.end)
  return parsed.parts
}

/** Parse a `{ … }` placeholder starting at the `{`. */
function parsePlaceholder(s: string, open: number, pound: boolean): { node: Part; end: number } {
  let i = skipWs(s, open + 1)
  const arg = readToken(s, i)
  if (arg.value === "") fail("empty argument", open)
  i = skipWs(s, arg.end)

  if (s[i] === "}") return { node: { kind: "interp", arg: arg.value }, end: i + 1 }
  if (s[i] !== ",") fail("expected ',' or '}'", i)

  i = skipWs(s, i + 1)
  const type = readToken(s, i)
  const kind = type.value
  if (kind !== "plural" && kind !== "selectordinal" && kind !== "select") {
    fail(`unsupported type '${kind}'`, type.end)
  }
  i = skipWs(s, type.end)
  if (s[i] !== ",") fail("expected ','", i)
  i = skipWs(s, i + 1)

  // `#` means this placeholder's number inside its own cases, and the enclosing plural's inside a
  // select's cases.
  const casePound = kind === "select" ? pound : true
  const cases = new Map<string, readonly Part[]>()
  let exact = false
  while (i < s.length && s[i] !== "}") {
    const name = readToken(s, i)
    if (name.value === "") fail("expected a case name", i)
    i = skipWs(s, name.end)
    if (s[i] !== "{") fail("expected '{'", i)
    const body = parseMessage(s, i + 1, casePound)
    if (s[body.end] !== "}") fail(`unterminated case '${name.value}'`, i)
    cases.set(name.value, body.parts)
    if (name.value[0] === "=") exact = true
    i = skipWs(s, body.end + 1)
  }
  if (s[i] !== "}") fail(`unterminated ${kind}`, open)
  return { node: { kind, arg: arg.value, cases, exact }, end: i + 1 }
}

/** What `evaluate` formats plural categories and `#` with; the `Intl` objects it may never need are
 * built on first use. */
export interface Runtime {
  category(kind: "plural" | "selectordinal", value: number): string
  number(value: number): string
}

// An argument named like an `Object.prototype` member (`{constructor}`, `{toString}`) must not render
// the inherited function when the caller did not pass it: catalogs may come from translators or
// machine translation, and vars are usually plain objects.
const INHERITED: Readonly<Record<string, unknown>> = {}
export const readVar = (vars: Readonly<Record<string, unknown>>, arg: string): unknown => {
  const value = vars[arg]
  // Every inherited member is a function except `__proto__`, so a string or number var pays one typeof.
  if (typeof value !== "function" && value !== Object.prototype) return value
  return value === INHERITED[arg] ? undefined : value
}

function evaluate(
  parts: readonly Part[],
  vars: Readonly<Record<string, unknown>>,
  rt: Runtime,
  pound: number | undefined,
): string {
  let out = ""
  for (const part of parts) {
    if (typeof part === "string") {
      out += part
    } else if (part.kind === "interp") {
      const value = readVar(vars, part.arg)
      out += value === undefined || value === null ? "" : String(value)
    } else if (part.kind === "pound") {
      out += pound === undefined ? "#" : rt.number(pound)
    } else if (part.kind === "select") {
      const cat = String(readVar(vars, part.arg))
      out += evaluate(part.cases.get(cat) ?? part.cases.get("other") ?? [], vars, rt, pound)
    } else {
      const n = Number(readVar(vars, part.arg))
      let cat = part.exact ? `=${n}` : ""
      if (!part.cases.has(cat)) cat = rt.category(part.kind, n)
      out += evaluate(part.cases.get(cat) ?? part.cases.get("other") ?? [], vars, rt, n)
    }
  }
  return out
}

/**
 * The value at a dotted key, resolved the way {@link MessageAt} types it: the whole remaining key as
 * an own property first, then its first segment. Own properties only, so `t("constructor")` never
 * reads `Object.prototype`.
 */
function lookup(catalog: object, key: string): unknown {
  let node: unknown = catalog
  let rest = key
  for (;;) {
    if (node === null || typeof node !== "object") return undefined
    if (Object.hasOwn(node, rest)) return (node as Record<string, unknown>)[rest]
    const dot = rest.indexOf(".")
    if (dot === -1) return undefined
    const head = rest.slice(0, dot)
    if (!Object.hasOwn(node, head)) return undefined
    node = (node as Record<string, unknown>)[head]
    rest = rest.slice(dot + 1)
  }
}

// Parsed messages per catalog object, keyed by dotted key: every formatter over one catalog (each
// locale, time zone or fallback set) shares them, and a collected catalog takes them with it. Only
// keys the catalog holds a string for are stored, so the map is bounded by the catalog itself.
const PARSED = new WeakMap<object, Map<string, readonly Part[]>>()
const parsedMessages = (catalog: object): Map<string, readonly Part[]> => {
  let parsed = PARSED.get(catalog)
  if (parsed === undefined) {
    parsed = new Map()
    PARSED.set(catalog, parsed)
  }
  return parsed
}

// Bounds on what one long-lived formatter (or one catalog's formatters) may accumulate, so values an
// app forwards from a request (a locale, a time zone, formatting options, a dynamic key) cannot grow
// memory without limit. Real apps stay far below them; past one, the oldest entry is dropped.
const MAX_FORMATTERS = 128
const MAX_INTL = 256
const MAX_REPORTED = 1024

/** `compute`, remembered for the counts most messages see: non-negative integers below 256, except -0
 * (which formats as "-0"). A plain array read by index. */
const memoizeCounts = (compute: (n: number) => string): ((n: number) => string) => {
  const memo: string[] = []
  return (n) => {
    if (!(n >= 0 && n < 256 && Number.isInteger(n) && 1 / n > 0)) return compute(n)
    let hit = memo[n]
    if (hit === undefined) {
      hit = compute(n)
      memo[n] = hit
    }
    return hit
  }
}

const remember = <V>(map: Map<string, V>, key: string, value: V, max: number): void => {
  if (map.size >= max) {
    const oldest = map.keys().next()
    if (oldest.done !== true) map.delete(oldest.value)
  }
  map.set(key, value)
}

interface CachedFormatters {
  /** Formatters without options, by locale. */
  readonly plain: Map<string, Formatter<MessageTree>>
  /** Formatters with options, by an unambiguous key of locale and options. */
  readonly configured: Map<string, Formatter<MessageTree>>
}

/**
 * A formatter is pure-after-build - its message-AST and `Intl.*` caches are deterministic memoization
 * - so a given `(messages, locale, options)` can safely share ONE instance across requests/renders.
 * This cache (keyed by the message-catalog object's identity, so a GC'd catalog takes its formatters
 * with it) makes per-request creation cheap: without it, an SSR app that calls `createFormatter` per
 * render re-parses every ICU message and reconstructs the heavy `Intl.NumberFormat`/`DateTimeFormat`
 * objects on every request.
 */
const FORMATTERS = new WeakMap<object, CachedFormatters>()

/** What `@nifrajs/i18n/rich` reads from a formatter: a key's parsed message through the fallback chain
 * (reporting a miss exactly as `t()` does), and the runtime that formats plural categories and `#`.
 * Keyed by the formatter object, so a value that only looks like one has no entry. */
export interface FormatterInternals {
  resolve(key: string): readonly Part[] | undefined
  readonly runtime: Runtime
}
export const FORMATTER_INTERNALS = new WeakMap<object, FormatterInternals>()

// Stable numeric identities for the objects an options key names (fallback catalogs, `onMissing`).
const IDS = new WeakMap<object, number>()
let nextId = 0
const idOf = (value: object): number => {
  let id = IDS.get(value)
  if (id === undefined) {
    id = nextId++
    IDS.set(value, id)
  }
  return id
}

const isCatalog = (value: unknown): value is object => value !== null && typeof value === "object"
function invalid(name: string, expected: string): never {
  throw new TypeError(`createFormatter: ${name} must be ${expected}`)
}

/** The cache key for `options`, or `undefined` when they change nothing. Throws on a malformed
 * fallback or handler, before anything is cached. */
function optionsCacheKey(
  locale: string,
  options: FormatterOptions<MessageTree> | undefined,
): string | undefined {
  if (options === undefined) return undefined
  const { fallback, onMissing, timeZone, numberingSystem } = options
  if (onMissing !== undefined && typeof onMissing !== "function") invalid("onMissing", "a function")
  const fallbackIds: number[] = []
  if (fallback !== undefined) {
    if (!Array.isArray(fallback)) invalid("fallback", "an array of catalogs")
    for (const catalog of fallback) {
      if (!isCatalog(catalog)) invalid("fallback", "an array of catalogs")
      fallbackIds.push(idOf(catalog))
    }
  }
  if (
    fallbackIds.length === 0 &&
    onMissing === undefined &&
    timeZone === undefined &&
    numberingSystem === undefined
  ) {
    return undefined
  }
  return JSON.stringify([
    locale,
    timeZone ?? null,
    numberingSystem ?? null,
    fallbackIds,
    onMissing === undefined ? null : idOf(onMissing),
  ])
}

/**
 * Build (or reuse) a {@link Formatter} bound to a locale + its message catalog. Cheap to call per
 * request/render - instances are cached per `(messages, locale, options)`, and parsed ASTs + `Intl.*`
 * are memoized. The catalog is the app's (import a JSON file); this only negotiates (see
 * `negotiateLocale`) and formats.
 *
 * ```ts
 * const t = createFormatter("fr-CA", catalogs["fr-CA"], {
 *   fallback: [catalogs.fr, catalogs.en],
 *   timeZone: user.timeZone,
 *   onMissing: reportMissingKey,
 * })
 * ```
 *
 * Throws, like `Intl`, for an invalid locale, `timeZone` or `numberingSystem`.
 */
export function createFormatter<M extends object = RegisteredMessages>(
  locale: string,
  messages: NoInfer<CatalogFor<M>>,
  options?: NoInfer<FormatterOptions<M>>,
): Formatter<M> {
  if (!isCatalog(messages)) invalid("messages", "a catalog object")
  const configured = optionsCacheKey(
    locale,
    options as unknown as FormatterOptions<MessageTree> | undefined,
  )
  let cached = FORMATTERS.get(messages)
  if (cached === undefined) {
    cached = { plain: new Map(), configured: new Map() }
    FORMATTERS.set(messages, cached)
  }
  const map = configured === undefined ? cached.plain : cached.configured
  const key = configured ?? locale
  const hit = map.get(key)
  if (hit !== undefined) return hit as unknown as Formatter<M>
  const formatter = buildFormatter(
    locale,
    messages,
    configured === undefined ? undefined : (options as unknown as FormatterOptions<MessageTree>),
  )
  remember(map, key, formatter, MAX_FORMATTERS)
  return formatter as unknown as Formatter<M>
}

function buildFormatter(
  locale: string,
  messages: object,
  options: FormatterOptions<MessageTree> | undefined,
): Formatter<MessageTree> {
  const cardinal = new Intl.PluralRules(locale) // validates the locale up front
  const { onMissing, timeZone, numberingSystem } = options ?? {}
  const catalogs: object[] = [messages]
  for (const catalog of options?.fallback ?? []) {
    if (!catalogs.includes(catalog)) catalogs.push(catalog)
  }
  // With no fallback, a key's resolution is the catalog's own parse cache; with one, keys resolved
  // through the chain are remembered here (still bounded by what the catalogs hold).
  const resolved =
    catalogs.length === 1 ? parsedMessages(messages) : new Map<string, readonly Part[]>()
  const numberFmts = new Map<string, Intl.NumberFormat>()
  const dateFmts = new Map<string, Intl.DateTimeFormat>()
  // Memoize the cache-key string per options OBJECT (by identity), so formatting a large table/grid
  // that reuses one options object doesn't re-`JSON.stringify` it on every cell.
  const keyCache = new WeakMap<object, string>()
  const optionsKey = (opts: object | undefined): string => {
    if (opts === undefined) return ""
    let k = keyCache.get(opts)
    if (k === undefined) {
      k = JSON.stringify(opts)
      keyCache.set(opts, k)
    }
    return k
  }
  const numberFormat = (opts: Intl.NumberFormatOptions | undefined): Intl.NumberFormat => {
    const cacheKey = optionsKey(opts)
    let fmt = numberFmts.get(cacheKey)
    if (fmt === undefined) {
      fmt = new Intl.NumberFormat(
        locale,
        numberingSystem === undefined || opts?.numberingSystem !== undefined
          ? opts
          : { ...opts, numberingSystem },
      )
      remember(numberFmts, cacheKey, fmt, MAX_INTL)
    }
    return fmt
  }
  const dateFormat = (opts: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormat => {
    const cacheKey = optionsKey(opts)
    let fmt = dateFmts.get(cacheKey)
    if (fmt === undefined) {
      let merged = opts
      if (timeZone !== undefined && opts?.timeZone === undefined) merged = { ...merged, timeZone }
      if (numberingSystem !== undefined && opts?.numberingSystem === undefined) {
        merged = { ...merged, numberingSystem }
      }
      fmt = new Intl.DateTimeFormat(locale, merged)
      remember(dateFmts, cacheKey, fmt, MAX_INTL)
    }
    return fmt
  }
  // Fail an invalid default here rather than on the first `d()` or `#` in a render.
  if (timeZone !== undefined) dateFormat(undefined)
  if (numberingSystem !== undefined) numberFormat(undefined)

  // `PluralRules#select` and `NumberFormat#format` cost a few hundred ns each, and counts are mostly
  // small, so their answers for 0..255 are kept per formatter.
  let ordinal: Intl.PluralRules | undefined
  const cardinalOf = memoizeCounts((n) => cardinal.select(n))
  const ordinalOf = memoizeCounts((n) => {
    ordinal ??= new Intl.PluralRules(locale, { type: "ordinal" })
    return ordinal.select(n)
  })
  const rt: Runtime = {
    category: (kind, value) => (kind === "plural" ? cardinalOf : ordinalOf)(value),
    number: memoizeCounts((n) => numberFormat(undefined).format(n)),
  }

  const reported = onMissing === undefined ? undefined : new Set<string>()
  const missing = (key: string): void => {
    if (onMissing === undefined || reported === undefined || reported.has(key)) return
    // Remember before calling, so a handler that throws (a test failing on any missing key) reports
    // each key once. Past the cap, keys are reported but no longer remembered.
    if (reported.size < MAX_REPORTED) reported.add(key)
    onMissing(key, locale)
  }

  const resolve = (key: string): readonly Part[] | undefined => {
    for (const catalog of catalogs) {
      const raw = lookup(catalog, key)
      if (typeof raw !== "string") continue
      const parsed = parsedMessages(catalog)
      let ast = parsed.get(key)
      if (ast === undefined) {
        try {
          ast = parseRootMessage(raw)
        } catch {
          ast = [raw]
        }
        parsed.set(key, ast)
      }
      if (resolved !== parsed) resolved.set(key, ast)
      return ast
    }
    return undefined
  }

  const EMPTY: Readonly<Record<string, unknown>> = {}
  const formatter = Object.freeze({
    locale,
    t(key: string, vars: Readonly<Record<string, unknown>> = EMPTY): string {
      const ast = resolved.get(key) ?? resolve(String(key))
      if (ast === undefined) {
        missing(String(key))
        return String(key) // missing key → the key (dev-visible), never throws
      }
      return evaluate(ast, vars, rt, undefined)
    },
    get(key: string) {
      const path = String(key)
      for (const catalog of catalogs) {
        const value = lookup(catalog, path)
        if (value !== undefined) return value as MessageValue
      }
      missing(path)
      return undefined
    },
    n(value: number | bigint, opts?: Intl.NumberFormatOptions): string {
      return numberFormat(opts).format(value)
    },
    d(value: Date | number, opts?: Intl.DateTimeFormatOptions): string {
      return dateFormat(opts).format(value)
    },
  })
  FORMATTER_INTERNALS.set(formatter, {
    resolve(key) {
      const ast = resolved.get(key) ?? resolve(key)
      if (ast === undefined) missing(key)
      return ast
    },
    runtime: rt,
  })
  return formatter
}
