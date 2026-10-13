import { describe, expect, test } from "bun:test"
import {
  type CatalogCheckCode,
  type CatalogFinding,
  checkCatalogs,
  tablesToCatalogs,
} from "../src/check.ts"
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
    expect(scripts.map((f) => f.severity)).toEqual(["error", "error", "warning"])
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
    // Thai has no spaces between words, so a brand next to Thai text is not a mixed word.
    const thai = checkCatalogs({
      locales: defineLocales({ default: "en", locales: { en: {}, th: {} } }),
      catalogs: { en: { brand: "Buy an iPhone" }, th: { brand: "ซื้อiPhoneรุ่นใหม่" } },
    })
    expect(only(thai.findings, "script")).toEqual([])
  })

  test("a Latin loanword with a native suffix is a warning, not an error", () => {
    const result = check({ en, gu: { brand: "Googleમાં" } })
    expect(only(result.findings, "script")).toMatchObject([
      { locale: "gu", key: "brand", severity: "warning" },
    ])
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

describe("tablesToCatalogs", () => {
  const registry = defineLocales({ default: "en", locales: { en: {}, hi: {}, ta: {} } })
  test("nests each table under its id, so findings read as the id", () => {
    const { catalogs, conflicts } = tablesToCatalogs(
      [
        { id: "routes/index.tsx:3", values: { en: "Saddle for {name}", hi: "काठी" } },
        { id: "shop.faq", values: { en: ["Brakes?"], hi: ["ब्रेक?"] } },
        { id: "shop", values: { en: "clashes with shop.faq" } },
        { id: "shop.faq.more", values: { en: "clashes too" } },
      ],
      registry,
    )
    expect(conflicts).toEqual(["shop", "shop.faq.more"])
    expect(catalogs.ta).toEqual({})
    const result = checkCatalogs({ locales: registry, catalogs })
    expect(result.findings.map((f) => `${f.locale} ${f.code} ${f.key}`)).toEqual([
      "hi placeholder routes/index.tsx:3",
      "ta missing-key routes/index.tsx:3",
      "ta missing-key shop.faq.0",
    ])
  })
})

describe("partly translated text", () => {
  const scripts = defineLocales({
    default: "en",
    locales: { en: {}, ru: {}, ja: {}, "zh-Hans": {}, fr: {} },
  })
  const run = (
    catalogs: Record<string, MessageTree | undefined>,
    options: Omit<Parameters<typeof checkCatalogs>[0], "locales" | "catalogs"> = {},
  ) =>
    checkCatalogs({
      locales: scripts,
      catalogs: { en: {}, ru: {}, ja: {}, "zh-Hans": {}, fr: {}, ...catalogs },
      ignore: { "missing-key": ["*"], "unused-key": ["*"] },
      ...options,
    })
  const messageFindings = (findings: readonly CatalogFinding[], code: CatalogCheckCode) =>
    only(findings, code).filter((finding) => finding.key !== undefined)
  const shareOf = (result: ReturnType<typeof run>, locale: string) =>
    result.coverage.find((row) => row.locale === locale)?.latinShare

  test("an English sentence with two words swapped in is a latin-share error", () => {
    const result = run({
      en: { ride: "Check the saddle and the brakes before every ride" },
      ru: { ride: "Please check the седло and the тормоза before every ride" },
    })
    expect(messageFindings(result.findings, "latin-share")).toEqual([
      {
        severity: "error",
        code: "latin-share",
        locale: "ru",
        key: "ride",
        message:
          "ride is 80% Latin-script words (8 of 10): text left in another language, not a translation",
      },
    ])
    expect(shareOf(result, "ru")).toBe(0.8)
    expect(only(result.findings, "latin-share").at(-1)).toMatchObject({
      severity: "warning",
      locale: "ru",
    })
    expect(result.ok).toBe(false)
  })

  test("a translation passes, and a Latin locale is never counted", () => {
    const result = run({
      en: { ride: "Check the saddle and the brakes before every ride" },
      ru: { ride: "Перед каждой поездкой проверьте седло и тормоза" },
      fr: { ride: "Check the saddle and the brakes before every ride" },
    })
    expect(only(result.findings, "latin-share")).toEqual([])
    expect(shareOf(result, "ru")).toBe(0)
    expect(shareOf(result, "fr")).toBeUndefined()
    expect(shareOf(result, "en")).toBeUndefined()
  })

  test("a message of fewer than minWords words is skipped", () => {
    const result = run({ en: { get: "Download the PDF" }, ru: { get: "Download the PDF" } })
    expect(messageFindings(result.findings, "latin-share")).toEqual([])
    const fewer = run(
      { en: { get: "Download the PDF" }, ru: { get: "Download the PDF" } },
      { minWords: 3 },
    )
    expect(messageFindings(fewer.findings, "latin-share")).toHaveLength(1)
  })

  test("latinWords are not counted, an entry with spaces allows each word", () => {
    const catalogs = {
      en: { shop: "Velora Cycle Works repairs brakes and gears" },
      ru: { shop: "Velora Cycle Works чинит тормоза и передачи" },
    }
    const counted = run(catalogs)
    expect(shareOf(counted, "ru")).toBe(0.5)
    expect(only(counted.findings, "latin-share")).toEqual([
      {
        severity: "warning",
        code: "latin-share",
        locale: "ru",
        message:
          "50% of ru's words are Latin-script (3 of 6), where a translation keeps names and units at most; list those in latinWords",
      },
    ])
    const allowed = run(catalogs, { latinWords: ["Velora Cycle Works"] })
    expect(shareOf(allowed, "ru")).toBe(0)
    expect(only(allowed.findings, "latin-share")).toEqual([])
  })

  test("an ignored key is left out of the locale's share", () => {
    const result = run(
      {
        en: { shop: "Velora Cycle Works repairs brakes and gears" },
        ru: { shop: "Velora Cycle Works чинит тормоза и передачи" },
      },
      { ignore: { "latin-share": ["shop"], "missing-key": ["*"] } },
    )
    expect(shareOf(result, "ru")).toBe(0)
    expect(only(result.findings, "latin-share")).toEqual([])
  })

  test("Japanese, written without spaces, splits into its words", () => {
    const result = run({
      en: {
        parts: "Pedals, saddle, brakes, gears and pump: check them",
        ride: "Check the saddle and the brakes before every ride",
      },
      ja: {
        parts: "Pedals、Saddle、Brakes、Gears、Pumpを確認",
        ride: "毎回の走行前にサドルとブレーキを点検してください",
      },
    })
    expect(messageFindings(result.findings, "latin-share").map((finding) => finding.key)).toEqual([
      "parts",
    ])
  })

  const paragraph =
    "Bring your bicycle to the workshop before noon. We adjust the brakes and the gears, true both wheels, pump the tyres, oil the chain and send you a message as soon as it is ready to ride again."

  test("a long message translated to a fraction of its length is a volume error", () => {
    const result = run({
      en: { service: paragraph, short: "Bring your bicycle before noon" },
      ru: {
        service: "Привезите велосипед до полудня.",
        short: "До полудня",
      },
    })
    expect(only(result.findings, "volume")).toEqual([
      {
        severity: "error",
        code: "volume",
        locale: "ru",
        key: "service",
        message: `service is 16% of en's length (31 of ${[...new Intl.Segmenter().segment(paragraph)].length} graphemes): a summary, not a translation`,
      },
    ])
  })

  test("a faithful translation, and a Han script's shorter one, pass volume", () => {
    const result = run({
      en: { service: paragraph },
      ru: {
        service:
          "Привезите велосипед в мастерскую до полудня. Мы отрегулируем тормоза и передачи, выправим оба колеса, накачаем шины, смажем цепь и напишем вам, как только он будет готов к поездке.",
      },
      "zh-Hans": {
        service:
          "中午前把自行车送到车间。我们调整刹车和变速，校正车轮，给轮胎打气，给链条上油，好了就通知你。",
      },
    })
    expect(only(result.findings, "volume")).toEqual([])
    expect(
      only(
        run(
          { en: { service: paragraph }, ru: { service: "Привезите велосипед." } },
          {
            minVolumeRatio: 0.05,
          },
        ).findings,
        "volume",
      ),
    ).toEqual([])
  })

  const dash = String.fromCharCode(0x2014)
  const noDash = ({ message }: { readonly message: string }) =>
    message.includes(dash) ? { code: "no-dash", message: "contains an em dash" } : undefined

  test("custom rules run on every locale's messages as custom:<code>, and ignore applies", () => {
    const seen: string[] = []
    const result = run(
      {
        en: { ride: `Ride ${dash} then rest`, legal: `Terms ${dash} read them` },
        ru: { ride: `Едем ${dash} потом отдых`, legal: "Условия" },
      },
      {
        ignore: { "custom:no-dash": ["legal"], "missing-key": ["*"] },
        rules: [
          noDash,
          (context) => {
            seen.push(`${context.info.tag} ${context.key} ${context.defaultMessage ?? "-"}`)
            return context.locale === "ru" && context.key === "legal"
              ? [
                  { code: "short", message: "is one word", severity: "warning" },
                  { code: "short", message: "is still one word", severity: "info" },
                ]
              : undefined
          },
        ],
      },
    )
    expect(only(result.findings, "custom:no-dash")).toEqual([
      {
        severity: "error",
        code: "custom:no-dash",
        locale: "en",
        key: "ride",
        message: "ride: contains an em dash",
      },
      {
        severity: "error",
        code: "custom:no-dash",
        locale: "ru",
        key: "ride",
        message: "ride: contains an em dash",
      },
    ])
    expect(only(result.findings, "custom:short").map((finding) => finding.severity)).toEqual([
      "warning",
      "info",
    ])
    expect(seen).toContain(`ru legal Terms ${dash} read them`)
    expect(seen).toContain(`en ride Ride ${dash} then rest`)
  })

  test("a rule that throws, or names no code, fails the check loudly", () => {
    expect(() =>
      run(
        { en: { ride: "Ride" } },
        {
          rules: [
            () => {
              throw new Error("bad rule")
            },
          ],
        },
      ),
    ).toThrow("checkCatalogs: rules[0] threw on en ride: bad rule")
    expect(() =>
      run({ en: { ride: "Ride" } }, { rules: [() => ({ code: "", message: "?" })] }),
    ).toThrow("rules[0] returned a finding with no code on en ride")
    expect(() =>
      run(
        { en: { ride: "Ride" } },
        {
          rules: [
            () => {
              throw "not an error"
            },
          ],
        },
      ),
    ).toThrow("threw on en ride: not an error")
  })
})
