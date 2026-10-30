import { describe, expect, test } from "bun:test"
import { defineLocales } from "../src/locales.ts"
import { defineI18nRouting, type I18nRoutingOptions } from "../src/routing.ts"

const locales = defineLocales({
  default: "en",
  locales: { en: {}, fr: {}, de: {}, ja: {}, gu: { draft: true } },
})
type Key = (typeof locales.all)[number]
const pathnames = {
  "/about": { fr: "/a-propos", de: "/ueber-uns", gu: "/draft-about" },
  "/contact": { en: "/get-in-touch", fr: "/contactez-nous" },
  "/": { fr: "/accueil" },
} as const
const router = (options: I18nRoutingOptions<Key> = {}) =>
  defineI18nRouting(locales, { pathnames, ...options })

describe("static translated pathnames", () => {
  test("switches both ways through the canonical key, including the default's own translation", () => {
    const r = router()
    expect(r.localizePathname("/about", "fr")).toBe("/fr/a-propos")
    expect(r.localizePathname("/fr/a-propos", "de")).toBe("/de/ueber-uns")
    expect(r.localizePathname("/de/ueber-uns", "fr")).toBe("/fr/a-propos")
    expect(r.localizePathname("/fr/a-propos", "en")).toBe("/about")
    expect(r.localizePathname("/fr/contactez-nous", "en")).toBe("/get-in-touch")
    expect(r.localizePathname("/get-in-touch", "fr")).toBe("/fr/contactez-nous")
    expect(r.localizePathname("/FR/about", "de")).toBe("/de/ueber-uns")
    expect(r.unlocalizePathname("/fr/a-propos")).toEqual({ locale: "fr", pathname: "/about" })
    expect(r.unlocalizePathname("/get-in-touch")).toEqual({
      locale: undefined,
      pathname: "/contact",
    })
  })

  test("missing translations keep the canonical spelling; unmapped paths are not translated", () => {
    const r = router()
    expect(r.localizePathname("/fr/a-propos", "ja")).toBe("/ja/about")
    expect(r.unlocalizePathname("/ja/about").pathname).toBe("/about")
    expect(r.localizePathname("/fr/unknown", "de")).toBe("/de/unknown")
    // A translated spelling is interpreted only in its source locale, never globally guessed.
    expect(r.unlocalizePathname("/de/a-propos").pathname).toBe("/a-propos")
    expect(r.localizePathname("/about/child", "fr")).toBe("/fr/about/child")
  })

  test("preserves query, hash and non-root trailing slashes, including language switches", () => {
    const r = router()
    expect(r.localizePathname("/fr/a-propos/?next=%2Fde#top", "de")).toBe(
      "/de/ueber-uns/?next=%2Fde#top",
    )
    expect(r.unlocalizePathname("/de/ueber-uns/?x=1#top")).toEqual({
      locale: "de",
      pathname: "/about/?x=1#top",
    })
    expect(r.localizePathname("/fr/accueil", "de")).toBe("/de")
    expect(r.localizePathname("/", "fr")).toBe("/fr/accueil")
    expect(r.unlocalizePathname("/fr/accueil").pathname).toBe("/")
    expect(r.alternates("/fr/accueil").canonical).toBe("/fr/accueil")
  })

  test("prefixDefaultLocale applies to mappings and translated roots", () => {
    const r = router({ prefixDefaultLocale: true })
    expect(r.localizePathname("/fr/contactez-nous", "en")).toBe("/en/get-in-touch")
    expect(r.localizePathname("/fr/accueil", "en")).toBe("/en")
    expect(r.unlocalizePathname("/en/get-in-touch")).toEqual({ locale: "en", pathname: "/contact" })
    expect(r.matchSegment(undefined, "/contact/?q#hash")).toEqual({
      kind: "redirect",
      location: "/en/get-in-touch/?q",
    })
    expect(r.matchSegment("en", "/en/get-in-touch")).toEqual({ kind: "ok", locale: "en" })
    expect(r.staticPathnames()).toContain("/en/get-in-touch")
  })

  test("canonical SEO from translated or canonical source spellings is reciprocal", () => {
    const r = router()
    const result = r.alternates("/de/ueber-uns/?q=1#top", { origin: "https://example.com" })
    expect(result).toEqual({
      canonical: "https://example.com/de/ueber-uns/?q=1",
      links: [
        { hreflang: "en", href: "https://example.com/about/?q=1" },
        { hreflang: "fr", href: "https://example.com/fr/a-propos/?q=1" },
        { hreflang: "de", href: "https://example.com/de/ueber-uns/?q=1" },
        { hreflang: "ja", href: "https://example.com/ja/about/?q=1" },
        { hreflang: "x-default", href: "https://example.com/about/?q=1" },
      ],
    })
    expect(r.alternates("/fr/about/?q=1", { origin: "https://example.com" }).links).toEqual(
      result.links,
    )
    expect(r.alternates("/fr/a-propos", { locales: ["de", "fr"] }).links).toEqual([
      { hreflang: "fr", href: "/fr/a-propos" },
      { hreflang: "de", href: "/de/ueber-uns" },
    ])
    expect(r.alternates("/contact").canonical).toBe("/get-in-touch")
  })

  test("pageLocales always sees the canonical key and still owns availability and fallback", () => {
    const seen: string[] = []
    const r = router({
      pageLocales: (path) => {
        seen.push(path)
        return path === "/about" ? ["fr", "en", "gu"] : undefined
      },
    })
    expect(r.localesOf("/fr/a-propos/?q#h")).toEqual(["en", "fr"])
    expect(r.matchSegment("de", "/de/ueber-uns")).toEqual({ kind: "not-found" })
    expect(r.alternates("/de/ueber-uns")).toEqual({ canonical: "/de/ueber-uns", links: [] })
    expect(r.alternates("/fr/a-propos").links.map((link) => link.hreflang)).toEqual([
      "en",
      "fr",
      "x-default",
    ])
    expect(r.localizePathname("/fr/a-propos", "de", { fallback: "default" })).toBe("/about")
    expect(seen).toEqual(Array(5).fill("/about"))
    expect(r.localizePathname("/about", "de")).toBe("/de/ueber-uns")
    expect(r.staticPathnames().slice(0, 2)).toEqual(["/about", "/fr/a-propos"])
    expect(r.staticPathnames()).not.toContain("/de/ueber-uns")
  })

  test("staticPathnames is mapping declaration then served registry order, without drafts", () => {
    expect(router().staticPathnames()).toEqual([
      "/about",
      "/fr/a-propos",
      "/de/ueber-uns",
      "/ja/about",
      "/get-in-touch",
      "/fr/contactez-nous",
      "/de/contact",
      "/ja/contact",
      "/",
      "/fr/accueil",
      "/de",
      "/ja",
    ])
    expect(defineI18nRouting(locales).staticPathnames()).toEqual([])
    expect(router({ pageLocales: () => [] }).staticPathnames()).toEqual([])
    expect(router().unlocalizePathname("/gu/draft-about")).toEqual({
      locale: undefined,
      pathname: "/gu/draft-about",
    })
    expect(() => router().localizePathname("/about", "gu")).toThrow(/not a served locale/)
  })

  test("matchSegment redirects source spellings and noncanonical prefixes directly to localized URLs", () => {
    const r = router()
    for (const [value, input, location] of [
      ["fr", "/fr/about/?q=1#hash", "/fr/a-propos/?q=1"],
      ["FR", "/FR/about", "/fr/a-propos"],
      ["FR", "/FR/a-propos", "/fr/a-propos"],
      ["fr", "/%66r/about", "/fr/a-propos"],
      ["en", "/en/contact", "/get-in-touch"],
      ["EN", "/EN/get-in-touch", "/get-in-touch"],
      ["fr", "/fr", "/fr/accueil"],
    ] as const) {
      expect(r.matchSegment(value, input)).toEqual({ kind: "redirect", location })
    }
    expect(r.matchSegment(undefined, "/contact?x#h")).toEqual({
      kind: "redirect",
      location: "/get-in-touch?x",
    })
    expect(r.matchSegment(undefined, "/get-in-touch")).toEqual({ kind: "ok", locale: "en" })
    expect(r.matchSegment("fr", "/fr/a-propos/")).toEqual({ kind: "ok", locale: "fr" })
    expect(r.matchSegment("fr", "/de/a-propos")).toEqual({ kind: "not-found" })
  })

  test("Unicode keys and translations round-trip through Request.url with URL-safe encoding", () => {
    const seen: string[] = []
    const r = router({
      pathnames: { "/café": { fr: "/à propos", ja: "/紹介/会社" }, "/offer": { fr: "/100%25" } },
      pageLocales: (path) => {
        seen.push(path)
        return undefined
      },
    })
    const path = new URL(new Request("https://example.com/fr/à%20propos/?q=é").url).pathname
    expect(path).toBe("/fr/%C3%A0%20propos/")
    expect(r.unlocalizePathname(path)).toEqual({ locale: "fr", pathname: "/caf%C3%A9/" })
    expect(r.localizePathname(path, "ja")).toBe("/ja/%E7%B4%B9%E4%BB%8B/%E4%BC%9A%E7%A4%BE/")
    expect(r.localizePathname("/café", "fr")).toBe("/fr/%C3%A0%20propos")
    expect(r.localizePathname("/caf%c3%a9", "fr")).toBe("/fr/%C3%A0%20propos")
    expect(r.localizePathname("/%66r/%c3%a0%20propos", "en")).toBe("/caf%C3%A9")
    expect(r.getPathLocale("/%66r/%c3%a0%20propos")).toBe("fr")
    expect(r.localesOf(path)).toEqual(["en", "fr", "de", "ja"])
    expect(seen).toEqual(["/café"])
    expect(r.alternates(path).canonical).toBe("/fr/%C3%A0%20propos/")
    expect(r.matchSegment("fr", "/fr/%c3%a0%20propos")).toEqual({
      kind: "redirect",
      location: "/fr/%C3%A0%20propos",
    })
    expect(r.unlocalizePathname("/fr/100%25").pathname).toBe("/offer")
    expect(r.staticPathnames()).toContain("/caf%C3%A9")
  })

  test("snapshots options without mutation and returns a fresh static list", () => {
    const mutable = { "/about": { fr: "/a-propos" } }
    const r = defineI18nRouting(locales, { pathnames: mutable })
    mutable["/about"].fr = "/changed"
    expect(r.localizePathname("/about", "fr")).toBe("/fr/a-propos")
    const frozen = Object.freeze({ "/about": Object.freeze({ fr: "/a-propos" }) })
    expect(defineI18nRouting(locales, { pathnames: frozen }).staticPathnames()).toEqual(
      r.staticPathnames(),
    )
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: deliberately bypass readonly to verify mutating the returned list cannot change the compiled routing table.
    const list = r.staticPathnames() as string[]
    list.length = 0
    expect(r.staticPathnames()).toHaveLength(4)
  })

  test("different locales may reuse one translated spelling for different canonical pages", () => {
    const r = router({ pathnames: { "/one": { fr: "/shared" }, "/two": { de: "/shared" } } })
    expect(r.unlocalizePathname("/fr/shared").pathname).toBe("/one")
    expect(r.unlocalizePathname("/de/shared").pathname).toBe("/two")
    expect(r.localizePathname("/fr/shared", "de")).toBe("/de/one")
  })

  test("mapped locale roots and registry order work when the default is not first", () => {
    const registry = defineLocales({
      default: "en",
      locales: { fr: {}, gu: { draft: true }, en: {}, de: {} },
    })
    const r = defineI18nRouting(registry, {
      pathnames: { "/home": { fr: "/" }, "/about/": { fr: "/a-propos/", de: undefined } },
    })
    expect(r.staticPathnames()).toEqual([
      "/fr",
      "/home",
      "/de/home",
      "/fr/a-propos",
      "/about",
      "/de/about",
    ])
    expect(r.unlocalizePathname("/fr")).toEqual({ locale: "fr", pathname: "/home" })
    expect(r.localizePathname("/fr", "en")).toBe("/home")
    expect(r.matchSegment("fr", "/fr/home")).toEqual({ kind: "redirect", location: "/fr" })
    expect(r.localizePathname("/about", "fr")).toBe("/fr/a-propos")
    expect(r.localizePathname("/about/", "fr")).toBe("/fr/a-propos/")
  })

  test("a dispatcher can resolve incoming URLs, but the helpers do not create filesystem routes", async () => {
    const r = router()
    const dispatch = (request: Request): Response => {
      const { pathname, search } = new URL(request.url)
      const match = r.matchSegment(r.getPathLocale(pathname), pathname + search)
      if (match.kind === "not-found") return new Response(null, { status: 404 })
      if (match.kind === "redirect")
        return new Response(null, { status: 308, headers: { location: match.location } })
      const canonical = r.unlocalizePathname(pathname).pathname.replace(/\/$/, "") || "/"
      return canonical === "/about"
        ? Response.json({ page: canonical, locale: match.locale })
        : new Response(null, { status: 404 })
    }
    expect(await dispatch(new Request("https://example.com/fr/a-propos")).json()).toEqual({
      page: "/about",
      locale: "fr",
    })
    expect(dispatch(new Request("https://example.com/fr/about?q=1")).headers.get("location")).toBe(
      "/fr/a-propos?q=1",
    )
    expect(dispatch(new Request("https://example.com/gu/draft-about")).status).toBe(404)
    expect(dispatch(new Request("https://example.com/xx/a-propos")).status).toBe(404)
  })
})

describe("pathname configuration safety", () => {
  test("rejects unknown locale keys and invalid translation tables at construction", () => {
    expect(() =>
      defineI18nRouting<string>(locales, { pathnames: { "/about": { es: "/acerca" } } }),
    ).toThrow(/unknown locale/)
    for (const value of [null, [], "wrong", 123]) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: malformed JS configuration deliberately bypasses the TS contract to exercise construction-time validation.
      expect(() => router({ pathnames: { "/about": value } as never })).toThrow(/pathnames/)
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a numeric translation deliberately bypasses the TS contract to test runtime rejection.
    expect(() => router({ pathnames: { "/about": { fr: 123 } } as never })).toThrow(/pathnames/)
  })

  test("rejects unsafe keys and values, including dynamic patterns and nested encoding tricks", () => {
    for (const path of [
      "about",
      "https://evil.example/x",
      "//evil.example",
      "/\\evil.example",
      "/a\\b",
      "/about?q=1",
      "/about#top",
      "/a\n",
      "/a\t",
      "/a\u0000",
      "/a\u007f",
      "/a//b",
      "/a/./b",
      "/a/../b",
      "/a/%2E%2e/b",
      "/%252e%252e/b",
      "/a%2fb",
      "/a%5Cb",
      "/%252f%252fevil.example",
      "/a%255cb",
      "/a%250a",
      "/a%3fq",
      "/a%23hash",
      "/bad%",
      "/bad%E0%A4",
      "/\ud800",
      "/:slug",
      "/[slug]",
      "/[[lang]]",
      "/[...slug]",
      "/{slug}",
      "/a/*path",
      "/a/:id?",
      "/a/%5Bslug%5D",
      "/fr/about",
      "/FR/about",
      "/%66r/about",
    ]) {
      expect(() => router({ pathnames: { [path]: {} } }), path).toThrow(/pathnames/)
      expect(() => router({ pathnames: { "/about": { fr: path } } }), path).toThrow(/pathnames/)
    }
  })

  test("rejects duplicate canonical, public and fallback paths and canonical shadowing", () => {
    const invalid: NonNullable<I18nRoutingOptions<Key>["pathnames"]>[] = [
      { "/café": {}, "/caf%C3%A9": {} },
      { "/about": {}, "/about/": {} },
      { "/one": { fr: "/same" }, "/two": { fr: "/same/" } },
      { "/one": { fr: "/café" }, "/two": { fr: "/caf%c3%a9" } },
      { "/one": { fr: "/two" }, "/two": {} },
      { "/one": { fr: "/two" }, "/two": { fr: "/different" } },
      { "/one": { fr: "/" }, "/": { fr: "/accueil" } },
    ]
    for (const mappings of invalid)
      expect(() => router({ pathnames: mappings })).toThrow(/duplicate|shadows/)
  })

  test("unsafe URL inputs never become off-site links or redirects", () => {
    const r = router()
    for (const input of [
      "//evil.example/x",
      "/\\evil.example",
      "/\t/evil.example",
      "/fr//evil.example",
      "/EN/\\evil.example",
      "/en/..//evil.example",
      "/en/%2f%2fevil.example",
      "/en/%252f%252fevil.example",
      "/en/%",
      "/en/%E0%A4",
      "/en/about?next=//evil.example#x",
    ]) {
      const outputs = [
        r.localizePathname(input, "en"),
        r.unlocalizePathname(input).pathname,
        r.alternates(input).canonical,
      ]
      const match = r.matchSegment(r.getPathLocale(input), input)
      if (match.kind === "redirect") outputs.push(match.location)
      for (const output of outputs) {
        expect(new URL(output, "https://app.example").origin, output).toBe("https://app.example")
      }
    }
  })
})
