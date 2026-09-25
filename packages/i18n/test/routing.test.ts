import { describe, expect, test } from "bun:test"
import { defineI18nRouting } from "../src/routing.ts"

const urls = () => defineI18nRouting({ locales: ["en", "fr", "pt-BR"], defaultLocale: "en" })

describe("defineI18nRouting", () => {
  test("rejects empty locales, unknown default, and case-clashing locales", () => {
    expect(() => defineI18nRouting({ locales: [], defaultLocale: "en" })).toThrow(
      /must not be empty/,
    )
    expect(() => defineI18nRouting({ locales: ["en"], defaultLocale: "fr" })).toThrow(
      /defaultLocale must be in locales/,
    )
    expect(() => defineI18nRouting({ locales: ["en", "EN"], defaultLocale: "en" })).toThrow(
      /differ only by case/,
    )
  })

  test("localizePathname prefixes non-default, leaves the default bare", () => {
    const r = urls()
    expect(r.localizePathname("/about", "fr")).toBe("/fr/about")
    expect(r.localizePathname("/", "fr")).toBe("/fr")
    expect(r.localizePathname("/about", "en")).toBe("/about")
    expect(r.localizePathname("/", "en")).toBe("/")
    expect(r.localizePathname("/pt-BR/pricing", "pt-BR")).toBe("/pt-BR/pricing")
    expect(() => r.localizePathname("/about", "de")).toThrow(/unsupported locale/)
  })

  test("localizePathname preserves query, hash, and trailing slash; re-prefixes", () => {
    const r = urls()
    expect(r.localizePathname("/about?x=1#y", "fr")).toBe("/fr/about?x=1#y")
    expect(r.localizePathname("/about/", "fr")).toBe("/fr/about/")
    expect(r.localizePathname("/en/about", "fr")).toBe("/fr/about")
    expect(r.localizePathname("/fr/about", "fr")).toBe("/fr/about")
    expect(r.localizePathname("/fr/about", "en")).toBe("/about")
    expect(r.localizePathname("/FR/about", "fr")).toBe("/fr/about")
  })

  test("rejects duplicate or unsafe locale path segments", () => {
    expect(() => defineI18nRouting({ locales: ["en", "en"], defaultLocale: "en" })).toThrow(
      /duplicate locale/,
    )
    expect(() => defineI18nRouting({ locales: ["en/us"], defaultLocale: "en/us" })).toThrow(
      /safe URL path segment/,
    )
    expect(() => defineI18nRouting({ locales: [""], defaultLocale: "" })).toThrow(
      /safe URL path segment/,
    )
  })

  test("prefixDefaultLocale prefixes everything including the default", () => {
    const r = defineI18nRouting({
      locales: ["en", "fr"],
      defaultLocale: "en",
      prefixDefaultLocale: true,
    })
    expect(r.localizePathname("/about", "en")).toBe("/en/about")
    expect(r.localizePathname("/", "en")).toBe("/en")
    expect(r.localizePathname("/about", "fr")).toBe("/fr/about")
    expect(r.unlocalizePathname("/en/about")).toEqual({ locale: "en", pathname: "/about" })
  })

  test("unlocalizePathname strips one segment; lookalikes are untouched", () => {
    const r = urls()
    expect(r.unlocalizePathname("/fr/about")).toEqual({ locale: "fr", pathname: "/about" })
    expect(r.unlocalizePathname("/fr")).toEqual({ locale: "fr", pathname: "/" })
    expect(r.unlocalizePathname("/fr/")).toEqual({ locale: "fr", pathname: "/" })
    expect(r.unlocalizePathname("/FR/about")).toEqual({ locale: "fr", pathname: "/about" })
    expect(r.unlocalizePathname("/frank")).toEqual({ locale: undefined, pathname: "/frank" })
    expect(r.unlocalizePathname("/about")).toEqual({ locale: undefined, pathname: "/about" })
    expect(r.unlocalizePathname("/")).toEqual({ locale: undefined, pathname: "/" })
    expect(r.unlocalizePathname("/pt-BR/a/b?x=1")).toEqual({
      locale: "pt-BR",
      pathname: "/a/b?x=1",
    })
  })

  test("getPathLocale reads the first segment only", () => {
    const r = urls()
    expect(r.getPathLocale("/fr/about")).toBe("fr")
    expect(r.getPathLocale("/pt-BR")).toBe("pt-BR")
    expect(r.getPathLocale("/about")).toBeUndefined()
    expect(r.getPathLocale("/frank/about")).toBeUndefined()
    expect(r.getPathLocale("/")).toBeUndefined()
  })

  test("hreflangLinks emits one alternate per locale plus x-default", () => {
    const r = urls()
    expect(r.hreflangLinks("/about", "https://x.com")).toEqual([
      { hreflang: "en", href: "https://x.com/about" },
      { hreflang: "fr", href: "https://x.com/fr/about" },
      { hreflang: "pt-BR", href: "https://x.com/pt-BR/about" },
      { hreflang: "x-default", href: "https://x.com/about" },
    ])
    // A prefixed input describes the same page - alternates are identical.
    expect(r.hreflangLinks("/fr/about?x=1", "https://x.com")).toEqual([
      { hreflang: "en", href: "https://x.com/about?x=1" },
      { hreflang: "fr", href: "https://x.com/fr/about?x=1" },
      { hreflang: "pt-BR", href: "https://x.com/pt-BR/about?x=1" },
      { hreflang: "x-default", href: "https://x.com/about?x=1" },
    ])
  })

  test("hreflangLinks follows prefixDefaultLocale for every entry", () => {
    const r = defineI18nRouting({
      locales: ["en", "fr"],
      defaultLocale: "en",
      prefixDefaultLocale: true,
    })
    expect(r.hreflangLinks("/", "https://x.com")).toEqual([
      { hreflang: "en", href: "https://x.com/en/" },
      { hreflang: "fr", href: "https://x.com/fr/" },
      { hreflang: "x-default", href: "https://x.com/en/" },
    ])
  })

  test("normalizes and validates hreflang origins", () => {
    const r = urls()
    expect(r.hreflangLinks("/about", "https://x.com/")[0]?.href).toBe("https://x.com/about")
    expect(() => r.hreflangLinks("/about", "https://x.com/base")).toThrow(
      /absolute http\(s\) origin/,
    )
    expect(() => r.hreflangLinks("/about", "//evil.example")).toThrow(/absolute http\(s\) origin/)
  })
})
