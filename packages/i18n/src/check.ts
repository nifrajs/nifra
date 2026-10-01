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
 *   a Cyrillic `а` in English), and words that mix Latin with the locale's script, from
 *   `Intl.Locale(tag).maximize().script` and Unicode script properties. Latin words stay allowed
 *   (brands, units, URLs);
 * - untranslated messages: identical to the default's in another language (a warning only).
 *
 * Pure: it reads the catalogs it is given and runs no app code. Draft locales report missing keys and
 * catalogs as info, since they are not served yet.
 */
import { lookup, type MessageTree, type Part, parseRootMessage } from "./format.ts"
import type { Locales } from "./locales.ts"
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
}

export interface CatalogCheckOptions<K extends string = string> {
  readonly locales: Locales<K>
  /** Each locale's catalog, by registry key. */
  readonly catalogs: { readonly [P in K]?: MessageTree | undefined }
  /** Keys a check skips, by finding code: an exact key, a prefix ending in `.*` (`"languages.*"`), or
   * `"*"` for every key. */
  readonly ignore?: { readonly [C in CatalogCheckCode]?: readonly string[] | undefined } | undefined
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

/** A function naming what in a message is outside the locale's script, or `undefined` when the
 * runtime cannot say which script the locale uses. */
function scriptChecker(tag: string): ((text: string) => string | undefined) | undefined {
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
  // A word mixing Latin and the locale's script is a lookalike bug; CJK mixes them by design (Tシャツ).
  const mixedWords = expected !== "Latn" && COMPOSITE_SCRIPTS[expected] === undefined
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
      return `contains ${chars.join(", ")}; the locale writes ${label}`
    }
    if (!mixedWords) return undefined
    for (const [word] of text.matchAll(/[\p{L}\p{M}]+/gu)) {
      if (own.test(word) && /\p{sc=Latn}/u.test(word)) {
        return `the word '${word}' mixes Latin letters with ${label}`
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

/** Check every locale's catalog in `locales` against the default locale's. */
export function checkCatalogs<K extends string>(
  options: CatalogCheckOptions<K>,
): CatalogCheckResult {
  const { locales, catalogs } = options
  const findings: CatalogFinding[] = []
  const ignore = options.ignore ?? {}
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
  for (const [key, text] of defaultMessages) {
    const shape = parsed(defaultKey, key, text)
    if (shape !== undefined) {
      defaultShapes.set(key, shape)
      checkChoices(defaultKey, defaultInfo.tag, key, shape)
    }
    const script = defaultScript?.(shape?.literal ?? text)
    if (script !== undefined) report("error", "script", defaultKey, key, `${key} ${script}`)
  }
  const total = defaultMessages.size
  const coverage: LocaleCoverage[] = []
  if (defaultCatalog !== undefined) {
    coverage.push({
      locale: defaultKey,
      default: true,
      draft: false,
      total,
      own: total,
      translated: total,
      coverage: 1,
    })
  }
  const defaultLanguage = new Intl.Locale(defaultInfo.tag).language

  for (const locale of locales.all) {
    if (locale === defaultKey) continue
    const catalog = catalogOf.get(locale)
    if (catalog === undefined || defaultCatalog === undefined) continue
    const { tag, draft } = locales.get(locale)
    const own = messagesOf(locale, catalog)
    const script = scriptChecker(tag)
    const sameLanguage = new Intl.Locale(tag).language === defaultLanguage
    for (const [key, text] of own) {
      const shape = parsed(locale, key, text)
      const scriptProblem = script?.(shape?.literal ?? text)
      if (scriptProblem !== undefined)
        report("error", "script", locale, key, `${key} ${scriptProblem}`)
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
      const baseShape = defaultShapes.get(key)
      if (baseShape !== undefined) {
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
    coverage.push({
      locale,
      default: false,
      draft,
      total,
      own: ownCount,
      translated,
      coverage: total === 0 ? 1 : translated / total,
    })
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    findings,
    coverage,
  }
}
