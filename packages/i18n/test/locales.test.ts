import { describe, expect, test } from "bun:test"
import { defineLocales, localeDirection } from "../src/index.ts"

describe("defineLocales", () => {
  const locales = defineLocales({
    default: "en",
    locales: {
      en: { hreflang: "en-IN" },
      hi: { hreflang: "hi-in", name: "हिन्दी" },
      ur: { tag: "ur-pk", hreflang: "ur" },
      "fr-CA": {},
      fr: {},
      gu: { draft: true },
    },
  })

  test("resolves every field from the segment, canonicalizing tags", () => {
    expect(locales.get("en")).toEqual({
      key: "en",
      tag: "en",
      hreflang: "en-IN",
      dir: "ltr",
      draft: false,
      name: locales.get("en").name,
    })
    expect(locales.get("hi").hreflang).toBe("hi-IN")
    expect(locales.get("hi").name).toBe("हिन्दी")
    expect(locales.get("ur")).toMatchObject({ tag: "ur-PK", hreflang: "ur", dir: "rtl" })
    expect(locales.get("fr-CA").tag).toBe("fr-CA")
  })

  test("served is declaration order without drafts; all keeps them", () => {
    expect(locales.all).toEqual(["en", "hi", "ur", "fr-CA", "fr", "gu"])
    expect(locales.served).toEqual(["en", "hi", "ur", "fr-CA", "fr"])
    expect(locales.isServed("hi")).toBe(true)
    expect(locales.isServed("gu")).toBe(false)
    expect(locales.isServed("HI")).toBe(false)
    expect(locales.isServed("de")).toBe(false)
  })

  test("the native name defaults to the language's own name", () => {
    const name = locales.get("en").name
    expect(typeof name).toBe("string")
    expect(name.length).toBeGreaterThan(0)
  })

  test("chain falls back to the base language's locale, then the default", () => {
    expect(locales.chain("fr-CA")).toEqual(["fr-CA", "fr", "en"])
    expect(locales.chain("fr")).toEqual(["fr", "en"])
    expect(locales.chain("en")).toEqual(["en"])
    expect(locales.chain("gu")).toEqual(["gu", "en"])
  })

  test("documentMeta gives <html lang> and <html dir>", () => {
    expect(locales.documentMeta("ur")).toEqual({ lang: "ur-PK", dir: "rtl" })
    expect(locales.documentMeta("hi")).toEqual({ lang: "hi", dir: "ltr" })
  })

  test("an undeclared key throws on get", () => {
    expect(() => locales.get("de" as "en")).toThrow(/not declared/)
  })

  test("refuses what would break URLs, Intl or hreflang", () => {
    expect(() => defineLocales({ default: "en", locales: {} as { en: object } })).toThrow(
      /must not be empty/,
    )
    expect(() => defineLocales({ default: "fr" as "en", locales: { en: {} } })).toThrow(
      /not in locales/,
    )
    expect(() => defineLocales({ default: "en", locales: { en: { draft: true } } })).toThrow(
      /cannot be a draft/,
    )
    expect(() => defineLocales({ default: "en", locales: { en: {}, EN: {} } })).toThrow(
      /differ only by case/,
    )
    expect(() => defineLocales({ default: "en", locales: { en: {}, "en/us": {} } })).toThrow(
      /safe URL path segment/,
    )
    expect(() =>
      defineLocales({ default: "en", locales: { en: {}, x: { tag: "not a tag" } } }),
    ).toThrow(/not a BCP-47 language tag/)
    expect(() =>
      defineLocales({ default: "en", locales: { en: {}, gb: { hreflang: "EN" } } }),
    ).toThrow(/share hreflang/)
    expect(() => defineLocales({ default: "en", locales: { en: { dir: "up" as "ltr" } } })).toThrow(
      /must be "ltr" or "rtl"/,
    )
  })

  test("a draft may share an hreflang with a served locale", () => {
    expect(() =>
      defineLocales({ default: "en", locales: { en: {}, "en-next": { tag: "en", draft: true } } }),
    ).not.toThrow()
  })
})

describe("localeDirection", () => {
  test("rtl languages, explicit scripts, and likely scripts", () => {
    for (const tag of [
      "ar",
      "he",
      "fa",
      "ur",
      "ps",
      "sd",
      "ug",
      "yi",
      "dv",
      "ckb",
      "ar-EG",
      "pa-Arab",
    ]) {
      expect(localeDirection(tag)).toBe("rtl")
    }
    for (const tag of ["en", "hi", "pa", "sd-Deva", "ta", "zh-Hant", "az-Latn"]) {
      expect(localeDirection(tag)).toBe("ltr")
    }
  })

  test("an unparseable tag falls back to its language subtag", () => {
    expect(localeDirection("ar_bad tag")).toBe("ltr")
    expect(localeDirection("not a tag")).toBe("ltr")
  })
})
