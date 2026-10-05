import { describe, expect, test } from "bun:test"
import { defineLocales } from "../src/locales.ts"
import { defineI18nRouting } from "../src/routing.ts"

const registry = () =>
  defineLocales({
    default: "en",
    locales: {
      en: {},
      fr: {},
      "pt-BR": {},
      hi: { hreflang: "hi-IN" },
      gu: { draft: true },
    },
  })
const urls = () => defineI18nRouting(registry())
const prefixed = () => defineI18nRouting(registry(), { prefixDefaultLocale: true })

describe("localizePathname", () => {
  test("prefixes a served locale, leaves the default bare", () => {
    const r = urls()
    expect(r.localizePathname("/about", "fr")).toBe("/fr/about")
    expect(r.localizePathname("/", "fr")).toBe("/fr")
    expect(r.localizePathname("/about", "en")).toBe("/about")
    expect(r.localizePathname("/", "en")).toBe("/")
    expect(r.localizePathname("/pt-BR/pricing", "pt-BR")).toBe("/pt-BR/pricing")
    expect(r.localizePathname("about", "fr")).toBe("/fr/about")
  })

  test("a locale that is not served throws, a draft included", () => {
    const r = urls()
    expect(() => r.localizePathname("/about", "de" as "en")).toThrow(/not a served locale/)
    expect(() => r.localizePathname("/about", "gu")).toThrow(/not a served locale/)
  })

  test("keeps query, hash and trailing slash; re-prefixes; normalizes case", () => {
    const r = urls()
    expect(r.localizePathname("/about?x=1#y", "fr")).toBe("/fr/about?x=1#y")
    expect(r.localizePathname("/about/", "fr")).toBe("/fr/about/")
    expect(r.localizePathname("/en/about", "fr")).toBe("/fr/about")
    expect(r.localizePathname("/fr/about", "en")).toBe("/about")
    expect(r.localizePathname("/FR/about", "fr")).toBe("/fr/about")
    expect(r.localizePathname("/fr/", "hi")).toBe("/hi")
  })

  test("no input produces a path a browser would follow off-site", () => {
    const r = urls()
    expect(r.localizePathname("//evil.com/x", "en")).toBe("/evil.com/x")
    expect(r.localizePathname("/\\evil.com", "en")).toBe("/evil.com")
    expect(r.localizePathname("/fr//evil.com", "en")).toBe("/evil.com")
    expect(r.localizePathname("\\\\evil.com", "fr")).toBe("/fr/evil.com")
  })

  test("prefixDefaultLocale prefixes the default too", () => {
    const r = prefixed()
    expect(r.localizePathname("/about", "en")).toBe("/en/about")
    expect(r.localizePathname("/", "en")).toBe("/en")
  })
})

describe("unlocalizePathname / getPathLocale / localeOf", () => {
  test("strips one served segment; lookalikes and drafts are ordinary segments", () => {
    const r = urls()
    expect(r.unlocalizePathname("/fr/about")).toEqual({ locale: "fr", pathname: "/about" })
    expect(r.unlocalizePathname("/fr")).toEqual({ locale: "fr", pathname: "/" })
    expect(r.unlocalizePathname("/fr/")).toEqual({ locale: "fr", pathname: "/" })
    expect(r.unlocalizePathname("/FR/about")).toEqual({ locale: "fr", pathname: "/about" })
    expect(r.unlocalizePathname("/frank")).toEqual({ locale: undefined, pathname: "/frank" })
    expect(r.unlocalizePathname("/gu/about")).toEqual({ locale: undefined, pathname: "/gu/about" })
    expect(r.unlocalizePathname("/pt-BR/a/b?x=1")).toEqual({
      locale: "pt-BR",
      pathname: "/a/b?x=1",
    })
  })

  test("getPathLocale reads the first segment; localeOf falls back to the default", () => {
    const r = urls()
    expect(r.getPathLocale("/fr/about")).toBe("fr")
    expect(r.getPathLocale("/about")).toBeUndefined()
    expect(r.getPathLocale("/gu")).toBeUndefined()
    expect(r.localeOf("/hi/x")).toBe("hi")
    expect(r.localeOf("/x")).toBe("en")
  })
})

describe("alternates", () => {
  test("canonical plus one link per served locale and x-default, built like localizePathname", () => {
    expect(urls().alternates("/fr/about", { origin: "https://x.com" })).toEqual({
      canonical: "https://x.com/fr/about",
      links: [
        { hreflang: "en", href: "https://x.com/about" },
        { hreflang: "fr", href: "https://x.com/fr/about" },
        { hreflang: "pt-BR", href: "https://x.com/pt-BR/about" },
        { hreflang: "hi-IN", href: "https://x.com/hi/about" },
        { hreflang: "x-default", href: "https://x.com/about" },
      ],
    })
  })

  test("the root of a locale is the same URL localizePathname builds", () => {
    const r = urls()
    const alt = r.alternates("/hi", { origin: "https://x.com" })
    expect(alt.canonical).toBe(`https://x.com${r.localizePathname("/", "hi")}`)
    expect(alt.links.find((link) => link.hreflang === "fr")?.href).toBe("https://x.com/fr")
    const p = prefixed().alternates("/", { origin: "https://x.com" })
    expect(p.canonical).toBe("https://x.com/en")
    expect(p.links.at(-1)).toEqual({ hreflang: "x-default", href: "https://x.com/en" })
  })

  test("without an origin the URLs are root-relative, for a language switcher", () => {
    expect(urls().alternates("/about").links[1]).toEqual({ hreflang: "fr", href: "/fr/about" })
  })

  test("keeps the query, drops the hash", () => {
    const alt = urls().alternates("/about?page=2#top")
    expect(alt.canonical).toBe("/about?page=2")
    expect(alt.links[1]?.href).toBe("/fr/about?page=2")
  })

  test("a page in a subset lists only that subset, in registry order, the same from every page", () => {
    const r = urls()
    const fromEn = r.alternates("/kundli", { locales: ["hi", "en"] })
    const fromHi = r.alternates("/hi/kundli", { locales: ["en", "hi"] })
    expect(fromEn.links).toEqual(fromHi.links)
    expect(fromEn.links.map((link) => link.hreflang)).toEqual(["en", "hi-IN", "x-default"])
  })

  test("x-default only when the default is listed", () => {
    const alt = urls().alternates("/fr/blog", { locales: ["fr", "pt-BR"] })
    expect(alt.links.map((link) => link.hreflang)).toEqual(["fr", "pt-BR"])
  })

  test("a subset missing the page's own locale, or naming an unserved locale, throws", () => {
    const r = urls()
    expect(() => r.alternates("/fr/x", { locales: ["en"] })).toThrow(/not in locales/)
    expect(() => r.alternates("/x", { locales: ["en", "gu"] })).toThrow(/not a served locale/)
  })

  test("validates the origin", () => {
    const r = urls()
    expect(r.alternates("/about", { origin: "https://x.com/" }).canonical).toBe(
      "https://x.com/about",
    )
    for (const origin of [
      "https://x.com/base",
      "//evil.example",
      "javascript:alert(1)",
      " https://x.com",
    ]) {
      expect(() => r.alternates("/about", { origin })).toThrow(/absolute http\(s\) origin/)
    }
  })
})

describe("matchSegment", () => {
  test("a served locale is ok; unknown and draft values are not found", () => {
    const r = urls()
    expect(r.matchSegment("fr", "/fr/about")).toEqual({ kind: "ok", locale: "fr" })
    expect(r.matchSegment("nonsense", "/nonsense/about")).toEqual({ kind: "not-found" })
    expect(r.matchSegment("gu", "/gu/about")).toEqual({ kind: "not-found" })
    expect(r.matchSegment("", "/")).toEqual({ kind: "not-found" })
  })

  test("the default's prefix redirects to the unprefixed URL, query kept", () => {
    expect(urls().matchSegment("en", "/en/about?x=1")).toEqual({
      kind: "redirect",
      location: "/about?x=1",
    })
    expect(urls().matchSegment("en", "/en")).toEqual({ kind: "redirect", location: "/" })
  })

  test("a wrong-case or percent-encoded segment redirects to the declared spelling", () => {
    expect(urls().matchSegment("FR", "/FR/about/")).toEqual({
      kind: "redirect",
      location: "/fr/about/",
    })
    expect(urls().matchSegment("hi", "/h%69/x")).toEqual({ kind: "redirect", location: "/hi/x" })
    expect(urls().matchSegment("EN", "/EN/x")).toEqual({ kind: "redirect", location: "/x" })
  })

  test("an absent optional segment is the default, or a redirect when the default is prefixed", () => {
    expect(urls().matchSegment(undefined, "/about")).toEqual({ kind: "ok", locale: "en" })
    expect(prefixed().matchSegment(undefined, "/about?x")).toEqual({
      kind: "redirect",
      location: "/en/about?x",
    })
    expect(prefixed().matchSegment("en", "/en/about")).toEqual({ kind: "ok", locale: "en" })
  })

  test("a redirect never leaves the site", () => {
    const r = urls()
    for (const path of ["/EN//evil.com", "/EN/\\evil.com", "/en//evil.com/x", "/en/\\\\evil.com"]) {
      const match = r.matchSegment(path.split("/")[1], path)
      expect(match.kind).toBe("redirect")
      if (match.kind === "redirect") expect(match.location).toMatch(/^\/(?![/\\])/)
    }
  })

  test("a value that is not the path's first segment is not found, never a guessed redirect", () => {
    expect(urls().matchSegment("fr", "/docs/fr/x")).toEqual({ kind: "not-found" })
    expect(urls().matchSegment("fr", "/%E0%A4/x")).toEqual({ kind: "not-found" })
  })
})
