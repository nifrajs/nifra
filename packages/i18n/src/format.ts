/**
 * A tiny ICU message formatter on the platform `Intl`. Supports interpolation (`{name}`), `plural`
 * (`{n, plural, one {# item} other {# items}}`, with `=N` exact cases and `#` → the number), and
 * `select` (`{kind, select, a {…} other {…}}`), nested arbitrarily. Parsed by a hand-written recursive
 * descent (a regex can't match nested `{}`); ASTs are cached per message. `Intl.MessageFormat` isn't
 * widely available yet, so this is the portable subset.
 *
 * Not supported (documented non-goals): inline `{n, number}`/`{d, date}` skeletons (use `n`/`d`),
 * `selectordinal`, `offset:`, and apostrophe quoting. A missing key/var fails soft (returns the key /
 * empty). A malformed message fails soft to its raw string so one bad catalog entry does not 500 SSR.
 */
export type Messages = Record<string, string>

type Part = string | InterpNode | ChoiceNode
interface InterpNode {
  readonly kind: "interp"
  readonly arg: string
}
interface ChoiceNode {
  readonly kind: "plural" | "select"
  readonly arg: string
  readonly cases: ReadonlyMap<string, readonly Part[]>
}

const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch)

const skipWs = (s: string, i: number): number => {
  let j = i
  while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++
  return j
}

const readToken = (s: string, i: number): { value: string; end: number } => {
  let j = i
  // a case name may be `=N`; otherwise an identifier run
  if (s[j] === "=") j++
  while (j < s.length && isIdentChar(s[j] as string)) j++
  return { value: s.slice(i, j), end: j }
}

/** Parse a (sub-)message starting at `start`, stopping at a top-level `}` or end. */
function parseMessage(s: string, start: number): { parts: Part[]; end: number } {
  const parts: Part[] = []
  let literal = ""
  let i = start
  while (i < s.length && s[i] !== "}") {
    if (s[i] === "{") {
      if (literal !== "") {
        parts.push(literal)
        literal = ""
      }
      const placeholder = parsePlaceholder(s, i)
      parts.push(placeholder.node)
      i = placeholder.end
      continue
    }
    literal += s[i]
    i++
  }
  if (literal !== "") parts.push(literal)
  return { parts, end: i }
}

function parseRootMessage(s: string): readonly Part[] {
  const parsed = parseMessage(s, 0)
  if (parsed.end !== s.length) throw new Error(`[nifra/i18n] unexpected '}' at ${parsed.end}`)
  return parsed.parts
}

/** Parse a `{ … }` placeholder starting at the `{`. */
function parsePlaceholder(s: string, open: number): { node: Part; end: number } {
  let i = skipWs(s, open + 1)
  const arg = readToken(s, i)
  if (arg.value === "") throw new Error(`[nifra/i18n] empty argument at ${open}`)
  i = skipWs(s, arg.end)

  if (s[i] === "}") return { node: { kind: "interp", arg: arg.value }, end: i + 1 }
  if (s[i] !== ",") throw new Error(`[nifra/i18n] expected ',' or '}' at ${i}`)

  i = skipWs(s, i + 1)
  const type = readToken(s, i)
  if (type.value !== "plural" && type.value !== "select") {
    throw new Error(`[nifra/i18n] unsupported placeholder type '${type.value}' (use plural/select)`)
  }
  i = skipWs(s, type.end)
  if (s[i] !== ",") throw new Error(`[nifra/i18n] expected ',' after '${type.value}' at ${i}`)
  i = skipWs(s, i + 1)

  const cases = new Map<string, readonly Part[]>()
  while (i < s.length && s[i] !== "}") {
    const name = readToken(s, i)
    if (name.value === "") throw new Error(`[nifra/i18n] expected a case name at ${i}`)
    i = skipWs(s, name.end)
    if (s[i] !== "{")
      throw new Error(`[nifra/i18n] expected '{' after case '${name.value}' at ${i}`)
    const body = parseMessage(s, i + 1)
    if (s[body.end] !== "}") throw new Error(`[nifra/i18n] unterminated case '${name.value}'`)
    cases.set(name.value, body.parts)
    i = skipWs(s, body.end + 1)
  }
  if (s[i] !== "}") throw new Error(`[nifra/i18n] unterminated ${type.value} at ${open}`)
  return { node: { kind: type.value, arg: arg.value, cases }, end: i + 1 }
}

function evaluate(
  parts: readonly Part[],
  vars: Readonly<Record<string, unknown>>,
  plural: Intl.PluralRules,
  pound: number | undefined,
): string {
  let out = ""
  for (const part of parts) {
    if (typeof part === "string") {
      out += pound === undefined ? part : part.replace(/#/g, String(pound))
    } else if (part.kind === "interp") {
      const value = vars[part.arg]
      out += value === undefined || value === null ? "" : String(value)
    } else if (part.kind === "plural") {
      const n = Number(vars[part.arg])
      const exact = `=${n}`
      const cat = part.cases.has(exact) ? exact : plural.select(n)
      out += evaluate(part.cases.get(cat) ?? part.cases.get("other") ?? [], vars, plural, n)
    } else {
      const cat = String(vars[part.arg])
      out += evaluate(part.cases.get(cat) ?? part.cases.get("other") ?? [], vars, plural, pound)
    }
  }
  return out
}

export interface Formatter {
  readonly locale: string
  /** Format `messages[key]` (an ICU string) with `vars`; a missing key returns the key itself. */
  t(key: string, vars?: Readonly<Record<string, unknown>>): string
  /** Locale number formatting (memoized `Intl.NumberFormat`). */
  n(value: number, options?: Intl.NumberFormatOptions): string
  /** Locale date/time formatting (memoized `Intl.DateTimeFormat`). */
  d(value: Date | number, options?: Intl.DateTimeFormatOptions): string
}

/**
 * A formatter is pure-after-build — its message-AST and `Intl.*` caches are deterministic memoization
 * — so a given `(messages, locale)` pair can safely share ONE instance across requests/renders. This
 * cache (keyed by the message-catalog object's identity, so a GC'd catalog takes its formatters with
 * it) makes per-request creation cheap: without it, an SSR app that calls `createFormatter` per render
 * re-parses every ICU message and reconstructs the heavy `Intl.NumberFormat`/`DateTimeFormat` objects
 * on every request.
 */
const FORMATTER_CACHE = new WeakMap<Messages, Map<string, Formatter>>()

/**
 * Build (or reuse) a {@link Formatter} bound to a locale + its message catalog. Cheap to call per
 * request/render — instances are cached per `(messages, locale)`, and parsed ASTs + `Intl.*` are
 * memoized inside each. The catalog is the app's (import a JSON file); this only negotiates (see
 * `negotiateLocale`) and formats.
 */
export function createFormatter(locale: string, messages: Messages): Formatter {
  let byLocale = FORMATTER_CACHE.get(messages)
  if (byLocale === undefined) {
    byLocale = new Map()
    FORMATTER_CACHE.set(messages, byLocale)
  }
  const cached = byLocale.get(locale)
  if (cached !== undefined) return cached
  const formatter = buildFormatter(locale, messages)
  byLocale.set(locale, formatter)
  return formatter
}

function buildFormatter(locale: string, messages: Messages): Formatter {
  const plural = new Intl.PluralRules(locale)
  const astCache = new Map<string, readonly Part[]>()
  const numberFmts = new Map<string, Intl.NumberFormat>()
  const dateFmts = new Map<string, Intl.DateTimeFormat>()
  // Memoize the cache-key string per options OBJECT (by identity), so formatting a large table/grid
  // that reuses one options object doesn't re-`JSON.stringify` it on every cell.
  const keyCache = new WeakMap<object, string>()
  const optionsKey = (options: object | undefined): string => {
    if (options === undefined) return ""
    let k = keyCache.get(options)
    if (k === undefined) {
      k = JSON.stringify(options)
      keyCache.set(options, k)
    }
    return k
  }

  return {
    locale,
    t(key, vars = {}) {
      const raw = messages[key]
      if (raw === undefined) return key // missing key → the key (dev-visible), never throws
      let ast = astCache.get(key)
      if (ast === undefined) {
        try {
          ast = parseRootMessage(raw)
        } catch {
          ast = [raw]
        }
        astCache.set(key, ast)
      }
      return evaluate(ast, vars, plural, undefined)
    },
    n(value, options) {
      const cacheKey = optionsKey(options)
      let fmt = numberFmts.get(cacheKey)
      if (fmt === undefined) {
        fmt = new Intl.NumberFormat(locale, options)
        numberFmts.set(cacheKey, fmt)
      }
      return fmt.format(value)
    },
    d(value, options) {
      const cacheKey = optionsKey(options)
      let fmt = dateFmts.get(cacheKey)
      if (fmt === undefined) {
        fmt = new Intl.DateTimeFormat(locale, options)
        dateFmts.set(cacheKey, fmt)
      }
      return fmt.format(value)
    },
  }
}
