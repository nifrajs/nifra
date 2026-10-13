/**
 * `@nifrajs/i18n/check` - checks a locale registry's catalogs the way `t()` reads them, for a test or
 * `nifra i18n check`:
 *
 * - coverage: per locale, the share of the default catalog's messages that render in its own language
 *   (its catalog, or a catalog earlier in `locales.chain()` than the default), and each missing key;
 * - unused keys: messages a locale has that the default catalog does not, so no typed `t()` reads them;
 * - ICU syntax, and placeholder and rich-tag parity with the default message: a translation that drops
 *   `{name}` (or `<link>`) loses it, one that adds a placeholder renders it empty;
 * - plural and select cases: a missing `other`, and plural categories the locale's grammar uses
 *   (`Intl.PluralRules`) that a message never states;
 * - script purity: letters from a script the locale does not write in (a Telugu letter in Gujarati,
 *   a Cyrillic `а` in English), from `Intl.Locale(tag).maximize().script` and Unicode script
 *   properties, and, as a warning, words that mix Latin with the locale's script. Latin words stay
 *   allowed (brands, units, URLs);
 * - untranslated messages: identical to the default's in another language (a warning only);
 * - partly translated text: in a locale that does not write in Latin, a message whose words are mostly
 *   Latin (`latin-share`), and a long message translated to a fraction of the default's length
 *   (`volume`), which is a summary rather than a translation;
 * - the app's own rules (`rules`), reported as `custom:<code>`.
 *
 * Pure: it reads the catalogs it is given and runs no app code. Draft locales report missing keys and
 * catalogs as info, since they are not served yet.
 */
import {
  lookup,
  type MessageTree,
  type MessageValue,
  type Part,
  parseRootMessage,
} from "./format.ts"
import type { LocaleInfo, Locales } from "./locales.ts"
import { TAG_SOURCE } from "./tags.ts"

export type CatalogCheckCode =
  | "missing-catalog"
  | "unknown-locale"
  | "invalid-catalog"
  | "shape"
  | "invalid-message"
  | "missing-key"
  | "unused-key"
  | "placeholder"
  | "tag"
  | "missing-other"
  | "plural-categories"
  | "script"
  | "untranslated"
  /** A copy table `nifra i18n check` cannot read statically, so it checks nothing in it. */
  | "copy-table"
  /** Two copy tables, or a table and a catalog key, under one id. */
  | "copy-id"
  /** Mostly Latin words in a locale that does not write in Latin: English left in a translation. */
  | "latin-share"
  /** A translation far shorter than the default's message: a summary, not a translation. */
  | "volume"
  /** A finding of one of the app's {@link CatalogCheckOptions.rules}. */
  | `custom:${string}`

export type CatalogCheckSeverity = "error" | "warning" | "info"

export interface CatalogFinding {
  readonly severity: CatalogCheckSeverity
  readonly code: CatalogCheckCode
  readonly locale: string
  /** The dotted key, when the finding is about one message. */
  readonly key?: string
  readonly message: string
}

export interface LocaleCoverage {
  readonly locale: string
  readonly default: boolean
  readonly draft: boolean
  /** Messages in the default locale's catalog. */
  readonly total: number
  /** Of those, how many this locale's own catalog has. */
  readonly own: number
  /** Of those, how many render in this locale's language: its own, or from a catalog earlier in its
   * `chain()` than the default. */
  readonly translated: number
  /** `translated / total`, from 0 to 1; 1 for the default locale. */
  readonly coverage: number
  /** For a locale that does not write in Latin: the share of the words in its messages of at least
   * `minWords` words that are Latin-script and not in `latinWords`, from 0 to 1. */
  readonly latinShare?: number
}

/** What a {@link CatalogRule} is given: one message of one locale. */
export interface CatalogRuleContext {
  readonly locale: string
  /** The dotted key. */
  readonly key: string
  readonly message: string
  /** The default locale's message under the key, the same as `message` in the default locale;
   * `undefined` when the default catalog has none. */
  readonly defaultMessage: string | undefined
  readonly info: LocaleInfo
}

/** A finding a {@link CatalogRule} returns. */
export interface CatalogRuleFinding {
  /** Reported as `custom:<code>`, which `ignore` takes. */
  readonly code: string
  readonly message: string
  /** Default `"error"`. */
  readonly severity?: CatalogCheckSeverity | undefined
}

/** An app's own check, run on every message of every locale. */
export type CatalogRule = (
  context: CatalogRuleContext,
) => CatalogRuleFinding | readonly CatalogRuleFinding[] | undefined

export interface CatalogCheckOptions<K extends string = string> {
  readonly locales: Locales<K>
  /** Each locale's catalog, by registry key. */
  readonly catalogs: { readonly [P in K]?: MessageTree | undefined }
  /** Keys a check skips, by finding code: an exact key, a prefix ending in `.*` (`"languages.*"`), or
   * `"*"` for every key. */
  readonly ignore?: { readonly [C in CatalogCheckCode]?: readonly string[] | undefined } | undefined
  /** Latin-script words a locale that does not write in Latin may keep (brand names, `PDF`, `OK`):
   * `latin-share` does not count them. An entry with spaces allows each of its words. */
  readonly latinWords?: readonly string[] | undefined
  /** `latin-share` skips a message of fewer words, and leaves it out of the locale's share. Default 6. */
  readonly minWords?: number | undefined
  /** `latin-share` reports a message whose share of Latin words is above this. Default 0.6. */
  readonly maxLatinShare?: number | undefined
  /** `latin-share` warns about a locale whose {@link LocaleCoverage.latinShare} is above this.
   * Default 0.1. */
  readonly maxLocaleLatinShare?: number | undefined
  /** `volume` reads default messages at least this many graphemes long. Default 80. */
  readonly minVolumeGraphemes?: number | undefined
  /** `volume` reports a translation shorter than this share of the default's graphemes. Default 0.32. */
  readonly minVolumeRatio?: number | undefined
  /** The app's own checks, run on every message of every locale after the built-in ones. */
  readonly rules?: readonly CatalogRule[] | undefined
}

export interface CatalogCheckResult {
  /** No error findings. Warnings and info never fail it. */
  readonly ok: boolean
  readonly findings: readonly CatalogFinding[]
  readonly coverage: readonly LocaleCoverage[]
}

/** What one message says, for comparing a translation with the default. */
interface Shape {
  /** The message's own text: literal runs, with tags and ICU syntax replaced by spaces. */
  readonly literal: string
  readonly args: ReadonlySet<string>
  readonly tags: ReadonlySet<string>
  readonly choices: readonly {
    readonly kind: string
    readonly arg: string
    readonly cases: readonly string[]
  }[]
}

const MAX_DEPTH = 64

// Numbers a plural category is sampled at: every integer to 200, large powers of ten (French and
// Spanish 'many'), and fractions (French 'one' takes 1.5).
const SAMPLE_NUMBERS: readonly number[] = [
  ...Array.from({ length: 201 }, (_, n) => n),
  1000,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  0.1,
  0.5,
  1.1,
  1.5,
  2.1,
  2.5,
  3.5,
  5.5,
  10.5,
  21.5,
]

// ISO 15924 codes `maximize()` can return that are not one Unicode script: the scripts they combine.
const COMPOSITE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  Jpan: ["Hani", "Hira", "Kana"],
  Kore: ["Hang", "Hani"],
  Hans: ["Hani"],
  Hant: ["Hani"],
  Hanb: ["Hani", "Bopo"],
}
// Scripts tried, in order, to name the script of an unexpected letter.
const KNOWN_SCRIPTS = [
  "Latn",
  "Cyrl",
  "Grek",
  "Armn",
  "Geor",
  "Hebr",
  "Arab",
  "Syrc",
  "Thaa",
  "Nkoo",
  "Tfng",
  "Ethi",
  "Deva",
  "Beng",
  "Guru",
  "Gujr",
  "Orya",
  "Taml",
  "Telu",
  "Knda",
  "Mlym",
  "Sinh",
  "Olck",
  "Thai",
  "Laoo",
  "Tibt",
  "Mymr",
  "Khmr",
  "Mong",
  "Hang",
  "Hira",
  "Kana",
  "Bopo",
  "Hani",
  "Cher",
] as const

const scriptName = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "script" }).of(code) ?? code
  } catch {
    return code
  }
}

const scriptPatterns = new Map<string, RegExp>()
const scriptOf = (char: string): string | undefined => {
  for (const code of KNOWN_SCRIPTS) {
    let pattern = scriptPatterns.get(code)
    if (pattern === undefined) {
      pattern = new RegExp(`\\p{sc=${code}}`, "u")
      scriptPatterns.set(code, pattern)
    }
    if (pattern.test(char)) return code
  }
  return undefined
}

const codePoint = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`

interface ScriptProblem {
  readonly severity: "error" | "warning"
  readonly message: string
}

// Scripts written without spaces between words: a Latin brand runs straight into the next word.
const UNSPACED_SCRIPTS: ReadonlySet<string> = new Set(["Thai", "Laoo", "Khmr", "Mymr", "Tibt"])

/** A function naming what in a message is outside the locale's script, or `undefined` when the
 * runtime cannot say which script the locale uses. A letter from another script is an error; a word
 * mixing Latin with the locale's script is a warning - a lookalike in Cyrillic, but Gujarati attaches
 * suffixes to Latin loanwords (`Googleમાં`). */
function scriptChecker(tag: string): ((text: string) => ScriptProblem | undefined) | undefined {
  let expected: string | undefined
  try {
    expected = new Intl.Locale(tag).maximize().script
  } catch {
    return undefined
  }
  if (expected === undefined) return undefined
  const scripts = COMPOSITE_SCRIPTS[expected] ?? [expected]
  let foreign: RegExp
  let own: RegExp
  try {
    const allowed = scripts.map((code) => `\\p{scx=${code}}`).join("")
    foreign = new RegExp(`[^${allowed}\\p{sc=Zyyy}\\p{sc=Zinh}\\p{sc=Latn}]`, "gu")
    own = new RegExp(`[${allowed}]`, "u")
  } catch {
    return undefined // a script this engine's Unicode tables do not know
  }
  const label = `${scriptName(expected)} (${expected})`
  // CJK mixes scripts inside words by design (Tシャツ), and unspaced scripts have no words to split.
  const mixedWords =
    expected !== "Latn" &&
    COMPOSITE_SCRIPTS[expected] === undefined &&
    !UNSPACED_SCRIPTS.has(expected)
  return (text) => {
    // Catalogs are mostly printable ASCII: skip the regexes when there is nothing else to look at.
    if (!/[^ -~]/.test(text)) return undefined
    const seen = new Set<string>()
    for (const match of text.matchAll(foreign)) {
      seen.add(match[0])
      if (seen.size === 3) break
    }
    if (seen.size > 0) {
      const chars = [...seen].map((char) => {
        const script = scriptOf(char)
        return `${codePoint(char)} '${char}'${script === undefined ? "" : ` (${scriptName(script)})`}`
      })
      return {
        severity: "error",
        message: `contains ${chars.join(", ")}; the locale writes ${label}`,
      }
    }
    if (!mixedWords) return undefined
    for (const [word] of text.matchAll(/[\p{L}\p{M}]+/gu)) {
      if (own.test(word) && /\p{sc=Latn}/u.test(word)) {
        return {
          severity: "warning",
          message: `the word '${word}' mixes Latin letters with ${label} - a lookalike letter, or a Latin word with a suffix`,
        }
      }
    }
    return undefined
  }
}

/** The arguments, rich tags and choices of a parsed message. */
function shapeOf(parts: readonly Part[]): Shape {
  const args = new Set<string>()
  const tags = new Set<string>()
  const choices: { kind: string; arg: string; cases: string[] }[] = []
  const tag = new RegExp(TAG_SOURCE, "g")
  let literal = ""
  const visit = (nodes: readonly Part[]): void => {
    for (const node of nodes) {
      if (typeof node === "string") {
        for (const match of node.matchAll(tag)) tags.add(match[2] as string)
        literal += ` ${node.replace(tag, " ")}`
      } else if (node.kind === "interp") {
        args.add(node.arg)
      } else if (node.kind !== "pound") {
        args.add(node.arg)
        choices.push({ kind: node.kind, arg: node.arg, cases: [...node.cases.keys()] })
        for (const body of node.cases.values()) visit(body)
      }
    }
  }
  visit(parts)
  return { literal, args, tags, choices }
}

const describeSet = (values: Iterable<string>, wrap: (value: string) => string): string =>
  [...values].map(wrap).join(", ")

const percentOf = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`

const localeScript = (tag: string): string | undefined => {
  try {
    return new Intl.Locale(tag).maximize().script
  } catch {
    return undefined
  }
}

// Han alone writes a sentence in about a quarter of the graphemes an alphabet takes, below any ratio
// `volume` holds other scripts to.
const HAN_SCRIPTS: ReadonlySet<string> = new Set(["Hans", "Hant", "Hanb"])

const LATIN_WORD = /^\p{sc=Latn}[\p{sc=Latn}\p{M}]*$/u

/** The words of a text by the locale's own word breaks (Japanese has no spaces): each word-like
 * segment's letters and marks, when there is more than one. */
function wordsOf(segmenter: Intl.Segmenter, text: string): string[] {
  const words: string[] = []
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike !== true) continue
    const word = segment.replace(/[^\p{L}\p{M}]/gu, "")
    // Code points, not letters: `है` is one letter and one combining mark.
    if ([...word].length > 1) words.push(word)
  }
  return words
}

let graphemeSegmenter: Intl.Segmenter | undefined
/** The visible length of a message's own text, in graphemes: what a reader counts as one character,
 * which a script with combining marks writes as several code points. */
function visibleLength(shape: Shape): number {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })
  let length = 0
  for (const _ of graphemeSegmenter.segment(shape.literal.replace(/\s+/g, " ").trim())) length++
  return length
}

const asFindings = (
  out: CatalogRuleFinding | readonly CatalogRuleFinding[],
): readonly CatalogRuleFinding[] => ("code" in out ? [out] : out)

const withLatinShare = (row: LocaleCoverage, share: number | undefined): LocaleCoverage =>
  share === undefined ? row : { ...row, latinShare: share }

/** Check every locale's catalog in `locales` against the default locale's. */
export function checkCatalogs<K extends string>(
  options: CatalogCheckOptions<K>,
): CatalogCheckResult {
  const { locales, catalogs } = options
  const findings: CatalogFinding[] = []
  const ignore = options.ignore ?? {}
  const latinWords = new Set((options.latinWords ?? []).flatMap((entry) => entry.split(/\s+/)))
  const minWords = options.minWords ?? 6
  const maxLatinShare = options.maxLatinShare ?? 0.6
  const maxLocaleLatinShare = options.maxLocaleLatinShare ?? 0.1
  const minVolumeGraphemes = options.minVolumeGraphemes ?? 80
  const minVolumeRatio = options.minVolumeRatio ?? 0.32
  const rules = options.rules ?? []
  const skipped = (code: CatalogCheckCode, key: string): boolean => {
    const patterns = ignore[code]
    if (patterns === undefined) return false
    for (const pattern of patterns) {
      if (pattern === "*" || pattern === key) return true
      if (pattern.endsWith(".*") && key.startsWith(pattern.slice(0, -1))) return true
    }
    return false
  }
  const report = (
    severity: CatalogCheckSeverity,
    code: CatalogCheckCode,
    locale: string,
    key: string | undefined,
    message: string,
  ): void => {
    if (key !== undefined && skipped(code, key)) return
    findings.push(
      key === undefined
        ? { severity, code, locale, message }
        : { severity, code, locale, key, message },
    )
  }

  // Every message a catalog holds, by the dotted key `t()` reads it with.
  const messagesOf = (locale: string, catalog: object): Map<string, string> => {
    const out = new Map<string, string>()
    const ancestors = new Set<object>()
    const walk = (node: object, prefix: string, depth: number): void => {
      if (depth > MAX_DEPTH) {
        report("error", "shape", locale, prefix, `${prefix} nests deeper than ${MAX_DEPTH} levels`)
        return
      }
      ancestors.add(node)
      for (const name of Object.keys(node)) {
        const key = prefix === "" ? name : `${prefix}.${name}`
        const value = (node as Record<string, unknown>)[name]
        if (typeof value === "string") {
          // A flat key containing a dot is read first, so a nested message it shadows is unreachable.
          if (lookup(catalog, key) !== value) {
            report(
              "warning",
              "shape",
              locale,
              key,
              `${key} is shadowed by a flat key of the same name, so t("${key}") never reads it`,
            )
          } else {
            out.set(key, value)
          }
        } else if (value !== null && typeof value === "object") {
          if (ancestors.has(value)) {
            report("error", "shape", locale, key, `${key} contains itself`)
          } else {
            walk(value, key, depth + 1)
          }
        } else {
          report(
            "error",
            "shape",
            locale,
            key,
            `${key} is ${value === null ? "null" : typeof value}; a catalog value must be a message, a list or a block`,
          )
        }
      }
      ancestors.delete(node)
    }
    walk(catalog, "", 0)
    return out
  }

  const parsed = (locale: string, key: string, text: string): Shape | undefined => {
    try {
      return shapeOf(parseRootMessage(text))
    } catch (error) {
      report(
        "error",
        "invalid-message",
        locale,
        key,
        `${key}: ${(error as Error).message.replace("[nifra/i18n] ", "")} - t() renders it raw`,
      )
      return undefined
    }
  }

  // Each category's members among sample numbers, per locale and plural type: a category whose every
  // sampled member has an exact `=N` case (`=1` for English 'one') is stated even without its name.
  const samples = new Map<
    string,
    { readonly needed: readonly string[]; readonly members: ReadonlyMap<string, readonly number[]> }
  >()
  const pluralInfo = (tag: string, type: "cardinal" | "ordinal") => {
    const cacheKey = `${type}:${tag}`
    let info = samples.get(cacheKey)
    if (info === undefined) {
      const rules = new Intl.PluralRules(tag, { type })
      const members = new Map<string, number[]>()
      for (const n of SAMPLE_NUMBERS) {
        const category = rules.select(n)
        const list = members.get(category)
        if (list === undefined) members.set(category, [n])
        else list.push(n)
      }
      info = { needed: rules.resolvedOptions().pluralCategories, members }
      samples.set(cacheKey, info)
    }
    return info
  }
  const checkChoices = (locale: string, tag: string, key: string, shape: Shape): void => {
    for (const choice of shape.choices) {
      if (!choice.cases.includes("other")) {
        report(
          "error",
          "missing-other",
          locale,
          key,
          `${key}: the ${choice.kind} on {${choice.arg}} has no 'other' case, so a value matching no case renders nothing`,
        )
      }
      if (choice.kind === "select") continue
      const { needed, members } = pluralInfo(tag, choice.kind === "plural" ? "cardinal" : "ordinal")
      const lacking = needed.filter((category) => {
        if (choice.cases.includes(category)) return false
        const sampled = members.get(category) ?? []
        return !(sampled.length > 0 && sampled.every((n) => choice.cases.includes(`=${n}`)))
      })
      if (lacking.length > 0 && choice.cases.includes("other")) {
        report(
          "warning",
          "plural-categories",
          locale,
          key,
          `${key}: the ${choice.kind} on {${choice.arg}} has no ${describeSet(lacking, (c) => `'${c}'`)} case${lacking.length === 1 ? "" : "s"}, which ${tag} uses; those numbers render the 'other' text`,
        )
      }
    }
  }

  /** Counts the Latin words of a locale that does not write in Latin, reporting each message made
   * mostly of them; `undefined` for a Latin locale, or one whose script the runtime cannot name. */
  const latinCounter = (locale: string, tag: string) => {
    const script = localeScript(tag)
    if (script === undefined || script === "Latn") return undefined
    const segmenter = new Intl.Segmenter(tag, { granularity: "word" })
    let words = 0
    let latin = 0
    return {
      count(key: string, shape: Shape): void {
        if (skipped("latin-share", key)) return
        const all = wordsOf(segmenter, shape.literal)
        // Labels are where Latin belongs (a brand, `PDF`): short messages count toward nothing.
        if (all.length < minWords) return
        const found = all.filter((word) => LATIN_WORD.test(word) && !latinWords.has(word)).length
        words += all.length
        latin += found
        if (found / all.length <= maxLatinShare) return
        report(
          "error",
          "latin-share",
          locale,
          key,
          `${key} is ${percentOf(found, all.length)} Latin-script words (${found} of ${all.length}): text left in another language, not a translation`,
        )
      },
      /** The locale's share, warning when it is above `maxLocaleLatinShare`. */
      share(): number {
        const share = words === 0 ? 0 : latin / words
        if (share > maxLocaleLatinShare) {
          report(
            "warning",
            "latin-share",
            locale,
            undefined,
            `${percentOf(latin, words)} of ${locale}'s words are Latin-script (${latin} of ${words}), where a translation keeps names and units at most; list those in latinWords`,
          )
        }
        return share
      },
    }
  }

  const runRules = (locale: string, info: LocaleInfo, key: string, message: string): void => {
    for (const [index, rule] of rules.entries()) {
      let out: ReturnType<CatalogRule>
      try {
        out = rule({ locale, key, message, defaultMessage: defaultMessages.get(key), info })
      } catch (error) {
        throw new Error(
          `[nifra/i18n] checkCatalogs: rules[${index}] threw on ${locale} ${key}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      if (out === undefined) continue
      for (const finding of asFindings(out)) {
        if (finding.code === "") {
          throw new Error(
            `[nifra/i18n] checkCatalogs: rules[${index}] returned a finding with no code on ${locale} ${key}`,
          )
        }
        report(
          finding.severity ?? "error",
          `custom:${finding.code}`,
          locale,
          key,
          `${key}: ${finding.message}`,
        )
      }
    }
  }

  const declared = new Set<string>(locales.all)
  for (const key of Object.keys(catalogs)) {
    if (!declared.has(key) && catalogs[key as K] !== undefined) {
      report(
        "warning",
        "unknown-locale",
        key,
        undefined,
        `a catalog is given for ${key}, which the locale registry does not declare`,
      )
    }
  }

  const catalogOf = new Map<string, object>()
  for (const key of locales.all) {
    const catalog = catalogs[key]
    const { draft } = locales.get(key)
    if (catalog === undefined) {
      report(draft ? "info" : "error", "missing-catalog", key, undefined, `${key} has no catalog`)
    } else if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
      report(
        "error",
        "invalid-catalog",
        key,
        undefined,
        `${key}'s catalog must be an object of messages`,
      )
    } else {
      catalogOf.set(key, catalog)
    }
  }

  const defaultKey = locales.default
  const defaultInfo = locales.get(defaultKey)
  const defaultCatalog = catalogOf.get(defaultKey)
  const defaultMessages =
    defaultCatalog === undefined
      ? new Map<string, string>()
      : messagesOf(defaultKey, defaultCatalog)
  const defaultShapes = new Map<string, Shape>()
  const defaultScript = scriptChecker(defaultInfo.tag)
  const defaultLatin = latinCounter(defaultKey, defaultInfo.tag)
  for (const [key, text] of defaultMessages) {
    const shape = parsed(defaultKey, key, text)
    if (shape !== undefined) {
      defaultShapes.set(key, shape)
      checkChoices(defaultKey, defaultInfo.tag, key, shape)
      defaultLatin?.count(key, shape)
    }
    const script = defaultScript?.(shape?.literal ?? text)
    if (script !== undefined) {
      report(script.severity, "script", defaultKey, key, `${key} ${script.message}`)
    }
    runRules(defaultKey, defaultInfo, key, text)
  }
  const total = defaultMessages.size
  const coverage: LocaleCoverage[] = []
  if (defaultCatalog !== undefined) {
    coverage.push(
      withLatinShare(
        {
          locale: defaultKey,
          default: true,
          draft: false,
          total,
          own: total,
          translated: total,
          coverage: 1,
        },
        defaultLatin?.share(),
      ),
    )
  }
  const defaultLanguage = new Intl.Locale(defaultInfo.tag).language
  const defaultHan = HAN_SCRIPTS.has(localeScript(defaultInfo.tag) ?? "")
  const defaultLengths = new Map<string, number>()

  for (const locale of locales.all) {
    if (locale === defaultKey) continue
    const catalog = catalogOf.get(locale)
    if (catalog === undefined || defaultCatalog === undefined) continue
    const info = locales.get(locale)
    const { tag, draft } = info
    const own = messagesOf(locale, catalog)
    const script = scriptChecker(tag)
    const latin = latinCounter(locale, tag)
    const sameLanguage = new Intl.Locale(tag).language === defaultLanguage
    const volume = defaultHan || !HAN_SCRIPTS.has(localeScript(tag) ?? "")
    for (const [key, text] of own) {
      const shape = parsed(locale, key, text)
      const scriptProblem = script?.(shape?.literal ?? text)
      if (scriptProblem !== undefined) {
        report(scriptProblem.severity, "script", locale, key, `${key} ${scriptProblem.message}`)
      }
      runRules(locale, info, key, text)
      const base = defaultMessages.get(key)
      if (base === undefined) {
        const at = lookup(defaultCatalog, key)
        if (at !== undefined && typeof at !== "string") {
          report(
            "error",
            "shape",
            locale,
            key,
            `${key} is a message here but a ${Array.isArray(at) ? "list" : "block"} in ${defaultKey}`,
          )
        } else {
          report(
            "warning",
            "unused-key",
            locale,
            key,
            `${key} is not in ${defaultKey}'s catalog, so no typed t() reads it`,
          )
        }
        continue
      }
      if (shape === undefined) continue
      checkChoices(locale, tag, key, shape)
      latin?.count(key, shape)
      const baseShape = defaultShapes.get(key)
      if (baseShape !== undefined) {
        let baseLength = defaultLengths.get(key)
        if (baseLength === undefined) {
          baseLength = visibleLength(baseShape)
          defaultLengths.set(key, baseLength)
        }
        const length =
          volume && baseLength >= minVolumeGraphemes ? visibleLength(shape) : baseLength
        if (length / baseLength < minVolumeRatio) {
          report(
            "error",
            "volume",
            locale,
            key,
            `${key} is ${percentOf(length, baseLength)} of ${defaultKey}'s length (${length} of ${baseLength} graphemes): a summary, not a translation`,
          )
        }
        const dropped = [...baseShape.args].filter((arg) => !shape.args.has(arg))
        const added = [...shape.args].filter((arg) => !baseShape.args.has(arg))
        if (dropped.length > 0) {
          report(
            "error",
            "placeholder",
            locale,
            key,
            `${key} drops ${describeSet(dropped, (a) => `{${a}}`)} that ${defaultKey}'s message shows`,
          )
        }
        if (added.length > 0) {
          report(
            "error",
            "placeholder",
            locale,
            key,
            `${key} adds ${describeSet(added, (a) => `{${a}}`)}, which ${defaultKey}'s message never takes, so it renders empty`,
          )
        }
        const lostTags = [...baseShape.tags].filter((name) => !shape.tags.has(name))
        const newTags = [...shape.tags].filter((name) => !baseShape.tags.has(name))
        if (lostTags.length > 0) {
          report(
            "error",
            "tag",
            locale,
            key,
            `${key} drops the ${describeSet(lostTags, (n) => `<${n}>`)} tag that ${defaultKey}'s message has`,
          )
        }
        if (newTags.length > 0) {
          report(
            "error",
            "tag",
            locale,
            key,
            `${key} adds a ${describeSet(newTags, (n) => `<${n}>`)} tag ${defaultKey}'s message does not have, so no handler draws it`,
          )
        }
      }
      if (
        !sameLanguage &&
        text === base &&
        baseShape !== undefined &&
        /\p{L}/u.test(baseShape.literal)
      ) {
        report(
          "warning",
          "untranslated",
          locale,
          key,
          `${key} is identical to ${defaultKey}'s message`,
        )
      }
    }

    const chain = locales.chain(locale).filter((key) => key !== locale && key !== defaultKey)
    let ownCount = 0
    let translated = 0
    for (const key of defaultMessages.keys()) {
      if (own.has(key)) {
        ownCount++
        translated++
        continue
      }
      const at = lookup(catalog, key)
      if (at !== undefined && typeof at !== "string") {
        report(
          "error",
          "shape",
          locale,
          key,
          `${key} is a ${Array.isArray(at) ? "list" : "block"} here but a message in ${defaultKey}`,
        )
        continue
      }
      const inherited = chain.some((other) => {
        const parent = catalogOf.get(other)
        return parent !== undefined && typeof lookup(parent, key) === "string"
      })
      if (inherited) translated++
      else
        report(
          draft ? "info" : "warning",
          "missing-key",
          locale,
          key,
          `${key} is missing, so it renders ${defaultKey}'s message`,
        )
    }
    coverage.push(
      withLatinShare(
        {
          locale,
          default: false,
          draft,
          total,
          own: ownCount,
          translated,
          coverage: total === 0 ? 1 : translated / total,
        },
        latin?.share(),
      ),
    )
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    findings,
    coverage,
  }
}

const isBlock = (value: MessageValue | undefined): value is MessageTree =>
  value !== undefined && typeof value === "object" && !Array.isArray(value)

/** A copy table, as {@link tablesToCatalogs} takes it: its id and its values by locale key. */
export interface CopyTableEntry {
  readonly id: string
  readonly values: Readonly<Record<string, MessageValue>>
}

/** Copy tables as one catalog per locale, for {@link checkCatalogs}. */
export interface TableCatalogs {
  /** Each locale's catalog: every table under its id, whose dots nest, so a finding's key reads as the
   * table's id (`routes/index.tsx:12`, or `shop.faq.0` for a list item). Every locale `locales`
   * declares has one, empty when no table has a value for it. */
  readonly catalogs: Readonly<Record<string, MessageTree>>
  /** Ids that collide with another table's (`home` beside `home.title`); those tables are left out. */
  readonly conflicts: readonly string[]
}

/**
 * Transpose copy tables (`@nifrajs/i18n/copy`) into per-locale catalogs, so every check here runs on
 * copy written next to the code as it does on a catalog per locale. Pure.
 *
 * ```ts
 * const { catalogs } = tablesToCatalogs(tables, locales)
 * checkCatalogs({ locales, catalogs })
 * ```
 */
export function tablesToCatalogs(
  tables: Iterable<CopyTableEntry>,
  locales?: Locales,
): TableCatalogs {
  const catalogs: Record<string, MessageTree> = {}
  for (const locale of locales?.all ?? []) catalogs[locale] = {}
  const placed = new Set<string>()
  // Every proper prefix of a placed id, so a table above another is found without a scan.
  const above = new Set<string>()
  const conflicts: string[] = []
  for (const { id, values } of tables) {
    const path = id.split(".")
    const leaf = path[path.length - 1] ?? id
    const prefixes = path.slice(0, -1).map((_, end) => path.slice(0, end + 1).join("."))
    // A table may sit only where no other table does, at, above or below it.
    if (placed.has(id) || above.has(id) || prefixes.some((prefix) => placed.has(prefix))) {
      conflicts.push(id)
      continue
    }
    placed.add(id)
    for (const prefix of prefixes) above.add(prefix)
    for (const [locale, value] of Object.entries(values)) {
      let node = catalogs[locale]
      if (node === undefined) {
        node = {}
        catalogs[locale] = node
      }
      for (const segment of path.slice(0, -1)) {
        const next: MessageValue | undefined = node[segment]
        if (isBlock(next)) {
          node = next
        } else {
          const block: MessageTree = {}
          node[segment] = block
          node = block
        }
      }
      node[leaf] = value
    }
  }
  return { catalogs, conflicts }
}
