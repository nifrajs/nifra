import { describe, expect, test } from "bun:test"
import { type CatalogCheckCode, type CatalogFinding, checkCatalogs } from "../src/check.ts"
import { defineLocales, type MessageTree } from "../src/index.ts"

const locales = defineLocales({
  default: "en",
  locales: {
    en: {},
    fr: {},
    "fr-CA": {},
    gu: {},
    ru: {},
    ar: {},
    ja: {},
    "en-GB": {},
    de: { draft: true },
  },
})

const check = (
  catalogs: Record<string, MessageTree | undefined>,
  ignore?: Parameters<typeof checkCatalogs>[0]["ignore"],
) => checkCatalogs({ locales, catalogs, ignore })

const only = (findings: readonly CatalogFinding[], code: CatalogCheckCode) =>
  findings.filter((finding) => finding.code === code)

const en = {
  home: { title: "Welcome, {name}", cta: "Read the <link>terms</link>" },
  cart: "{n, plural, =0 {Empty} one {# item} other {# items}}",
  faq: [{ q: "Why?", a: "Because." }],
  brand: "nifra",
}

describe("checkCatalogs", () => {
  test("a complete, faithful set of catalogs passes with full coverage", () => {
    const fr = {
      home: { title: "Bienvenue, {name}", cta: "Lisez les <link>conditions</link>" },
      cart: "{n, plural, =0 {Vide} one {# article} many {# d'articles} other {# articles}}",
      faq: [{ q: "Pourquoi ?", a: "Parce que." }],
      brand: "nifra",
    }
    const result = check(
      { en, fr, "fr-CA": {}, gu: {}, ru: {}, ar: {}, ja: {}, "en-GB": {}, de: {} },
      {
        "missing-key": ["*"],
        untranslated: ["brand"], // the same word in every language
      },
    )
    expect(result.findings.filter((f) => f.locale === "fr" || f.locale === "en")).toEqual([])
    expect(result.coverage.find((c) => c.locale === "fr")).toEqual({
      locale: "fr",
      default: false,
      draft: false,
      total: 6,
      own: 6,
      translated: 6,
      coverage: 1,
    })
    // fr-CA inherits every message from fr through its chain.
    expect(result.coverage.find((c) => c.locale === "fr-CA")?.coverage).toBe(1)
    expect(result.coverage.find((c) => c.locale === "fr-CA")?.own).toBe(0)
    expect(result.ok).toBe(true)
  })

  test("missing and unused keys, with coverage", () => {
    const result = check({ en, ru: { home: { title: "Привет, {name}" }, stale: "Старое" } })
    const ru = result.coverage.find((c) => c.locale === "ru")
    expect(ru).toMatchObject({ total: 6, own: 1, translated: 1 })
    expect(ru?.coverage).toBeCloseTo(1 / 6)
    expect(
      only(result.findings, "missing-key")
        .filter((f) => f.locale === "ru")
        .map((f) => f.key),
    ).toEqual(["home.cta", "cart", "faq.0.q", "faq.0.a", "brand"])
    expect(only(result.findings, "unused-key")).toMatchObject([
      { locale: "ru", key: "stale", severity: "warning" },
    ])
    // Missing keys warn; only errors fail.
    expect(only(result.findings, "missing-key").every((f) => f.severity === "warning")).toBe(true)
  })

  test("a registry locale without a catalog fails unless it is a draft; an undeclared catalog warns", () => {
    const result = check({ en, xx: { a: "b" } })
    expect(only(result.findings, "missing-catalog").find((f) => f.locale === "fr")?.severity).toBe(
      "error",
    )
    expect(only(result.findings, "missing-catalog").find((f) => f.locale === "de")?.severity).toBe(
      "info",
    )
    expect(only(result.findings, "unknown-locale")).toMatchObject([
      { locale: "xx", severity: "warning" },
    ])
    expect(result.ok).toBe(false)
  })

  test("a draft locale's missing keys are info", () => {
    const result = check({ en, de: { brand: "nifra" } })
    const missing = only(result.findings, "missing-key").filter((f) => f.locale === "de")
    expect(missing.length).toBe(5)
    expect(missing.every((f) => f.severity === "info")).toBe(true)
  })

  test("ICU syntax errors name the position", () => {
    const result = check({ en, fr: { home: { title: "Bienvenue, {name" } } })
    expect(only(result.findings, "invalid-message")).toMatchObject([
      { locale: "fr", key: "home.title", severity: "error" },
    ])
    expect(only(result.findings, "invalid-message")[0]?.message).toContain(" at ")
  })

  test("placeholder parity: dropped and added arguments are errors", () => {
    const result = check({
      en,
      fr: {
        home: { title: "Bienvenue !" },
        cart: "{count, plural, one {# article} other {# articles}}",
      },
    })
    const messages = only(result.findings, "placeholder").map((f) => `${f.key}: ${f.message}`)
    expect(messages).toEqual([
      "home.title: home.title drops {name} that en's message shows",
      "cart: cart drops {n} that en's message shows",
      "cart: cart adds {count}, which en's message never takes, so it renders empty",
    ])
  })

  test("rich tag parity", () => {
    const result = check({ en, fr: { home: { cta: "Lisez les conditions <b>ici</b>" } } })
    expect(only(result.findings, "tag").map((f) => f.message)).toEqual([
      "home.cta drops the <link> tag that en's message has",
      "home.cta adds a <b> tag en's message does not have, so no handler draws it",
    ])
  })

  test("plural cases: missing other is an error, an unstated category of the locale a warning", () => {
    const result = check({
      en,
      ru: { cart: "{n, plural, one {# товар} other {# товаров}}" },
      ar: { cart: "{n, plural, one {عنصر}}" },
    })
    expect(only(result.findings, "missing-other")).toMatchObject([{ locale: "ar", key: "cart" }])
    const categories = only(result.findings, "plural-categories")
    expect(categories).toMatchObject([{ locale: "ru", key: "cart", severity: "warning" }])
    expect(categories[0]?.message).toContain("'few', 'many'")
  })

  test("an exact case that covers a category counts as stating it", () => {
    // English 'one' is exactly 1, so `=1` states it; French 'one' also takes 1.5, so `=1` does not.
    const result = check({
      en: { ...en, cart: "{n, plural, =1 {One item} other {# items}}" },
      fr: { cart: "{n, plural, =1 {Un article} many {# d'articles} other {# articles}}" },
    })
    const categories = only(result.findings, "plural-categories")
    expect(categories.map((f) => f.locale)).toEqual(["fr"])
    expect(categories[0]?.message).toContain("'one'")
  })

  test("script purity catches a lookalike letter from a neighbouring script", () => {
    const result = check({
      en: { ...en, greeting: "Hеllo" }, // Cyrillic е
      gu: {
        home: { title: "સ્વાગત છે, {name}" },
        brand: "nifra",
        cart: "{n, plural, one {# વસ્તુ} other {# વસ્તుઓ}}",
      }, // Telugu ు
      ru: { home: { title: "Привeт, {name}" } }, // Latin e inside a Cyrillic word
    })
    const scripts = only(result.findings, "script")
    expect(scripts.map((f) => `${f.locale} ${f.key}`)).toEqual([
      "en greeting",
      "gu cart",
      "ru home.title",
    ])
    expect(scripts[0]?.message).toContain("U+0435 'е' (Cyrillic)")
    expect(scripts[0]?.message).toContain("Latin (Latn)")
    expect(scripts[1]?.message).toContain("U+0C41")
    expect(scripts[1]?.message).toContain("(Telugu)")
    expect(scripts[1]?.message).toContain("Gujarati (Gujr)")
    expect(scripts[2]?.message).toContain("mixes Latin letters with Cyrillic")
    expect(result.ok).toBe(false)
  })

  test("script purity allows Latin words, placeholders, tags, punctuation and CJK's mixed words", () => {
    const result = check({
      en,
      gu: { home: { title: "{name}, nifra માં સ્વાગત છે – ₹100 😀", cta: "<link>શરતો</link> વાંચો" } },
      ar: { brand: "nifra «مرحبا» ١٢٣" },
      ja: { home: { title: "Tシャツ、ようこそ{name}さん、日本語" } },
    })
    expect(only(result.findings, "script")).toEqual([])
  })

  test("an ignore pattern skips one check for matching keys", () => {
    const result = check(
      { en: { ...en, languages: { hi: "Hindi (हिन्दी)" } } },
      { script: ["languages.*"] },
    )
    expect(only(result.findings, "script")).toEqual([])
    const flagged = check({ en: { ...en, languages: { hi: "Hindi (हिन्दी)" } } })
    expect(only(flagged.findings, "script").map((f) => f.key)).toEqual(["languages.hi"])
  })

  test("untranslated: identical to the default in another language warns, a regional variant does not", () => {
    const result = check({
      en,
      fr: { home: { title: "Welcome, {name}" }, brand: "nifra" },
      "en-GB": { home: { title: "Welcome, {name}" } },
      ja: { cart: "{n, plural, other {#}}" },
    })
    const untranslated = only(result.findings, "untranslated")
    expect(untranslated.map((f) => `${f.locale} ${f.key}`)).toEqual(["fr home.title", "fr brand"])
    expect(untranslated.every((f) => f.severity === "warning")).toBe(true)
  })

  test("shape: a message where the default has a block, values that are not messages, a cycle", () => {
    const cyclic: Record<string, unknown> = { a: "x" }
    cyclic.self = cyclic
    const result = check({
      en,
      fr: { home: "Accueil", faq: { q: "x" }, brand: 3 as unknown as string },
      ru: cyclic as MessageTree,
    })
    const shapes = only(result.findings, "shape").map((f) => `${f.locale} ${f.key}`)
    expect(shapes).toContain("fr home")
    expect(shapes).toContain("fr brand")
    expect(shapes).toContain("ru self")
    expect(result.ok).toBe(false)
  })

  test("a flat key that shadows a nested message is reported", () => {
    const result = check({ en: { ...en, "a.b": "flat", a: { b: "nested" } } })
    expect(only(result.findings, "shape")).toMatchObject([
      { locale: "en", key: "a.b", severity: "warning" },
    ])
  })
})
