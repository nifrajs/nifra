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
    // URL parsing drops tabs and newlines, so a segment of only those is an empty one.
    for (const input of ["/\t/evil.com", "/\n/evil.com", "/\r\\evil.com"]) {
      const out = r.localizePathname(input, "en")
      expect([input, new URL(out, "https://app.example").host]).toEqual([input, "app.example"])
    }
    expect(r.unlocalizePathname("/fr/\n/evil.com").pathname).toBe("/evil.com")
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

describe("pageLocales", () => {
  type Key = "en" | "fr" | "pt-BR" | "hi" | "gu"
  const pages = (pathname: string): readonly Key[] | undefined => {
    if (pathname.startsWith("/repairs/")) return ["fr", "en", "gu"]
    if (pathname === "/rentals") return ["en"]
    if (pathname === "/salon") return ["fr"]
    return undefined
  }
  const r = () => defineI18nRouting(registry(), { pageLocales: pages })

  test("localesOf: the page's served locales in registry order, every one by default", () => {
    expect(r().localesOf("/fr/repairs/brakes?x=1")).toEqual(["en", "fr"])
    expect(r().localesOf("/repairs/brakes")).toEqual(["en", "fr"])
    expect(r().localesOf("/hi/about")).toEqual(["en", "fr", "pt-BR", "hi"])
    expect(urls().localesOf("/repairs/brakes")).toEqual(["en", "fr", "pt-BR", "hi"])
  })

  test("pageLocales reads the path without its prefix, query, hash or trailing slash", () => {
    const seen: string[] = []
    const router = defineI18nRouting(registry(), {
      pageLocales: (pathname) => {
        seen.push(pathname)
        return undefined
      },
    })
    router.localesOf("/fr/repairs/brakes/?x=1#top")
    router.localesOf("/")
    router.localesOf("/hi")
    expect(seen).toEqual(["/repairs/brakes", "/", "/"])
  })

  test("matchSegment: a page missing from the locale is not found", () => {
    expect(r().matchSegment("fr", "/fr/repairs/brakes")).toEqual({ kind: "ok", locale: "fr" })
    expect(r().matchSegment("hi", "/hi/repairs/brakes")).toEqual({ kind: "not-found" })
    expect(r().matchSegment("en", "/en/repairs/brakes?x=1")).toEqual({
      kind: "redirect",
      location: "/repairs/brakes?x=1",
    })
    expect(r().matchSegment("en", "/en/salon")).toEqual({ kind: "not-found" })
    expect(r().matchSegment(undefined, "/salon")).toEqual({ kind: "not-found" })
    expect(r().matchSegment(undefined, "/rentals")).toEqual({ kind: "ok", locale: "en" })
    expect(r().matchSegment("hi", "/hi/about")).toEqual({ kind: "ok", locale: "hi" })
  })

  test("alternates: the page's own locales; one locale, or a page missing its own, has none", () => {
    expect(r().alternates("/fr/repairs/brakes", { origin: "https://example.com" })).toEqual({
      canonical: "https://example.com/fr/repairs/brakes",
      links: [
        { hreflang: "en", href: "https://example.com/repairs/brakes" },
        { hreflang: "fr", href: "https://example.com/fr/repairs/brakes" },
        { hreflang: "x-default", href: "https://example.com/repairs/brakes" },
      ],
    })
    expect(r().alternates("/rentals")).toEqual({ canonical: "/rentals", links: [] })
    expect(r().alternates("/hi/repairs/brakes")).toEqual({
      canonical: "/hi/repairs/brakes",
      links: [],
    })
    expect(
      r()
        .alternates("/repairs/brakes", { locales: ["en", "hi"] })
        .links.map((link) => link.hreflang),
    ).toEqual(["en", "hi-IN", "x-default"])
  })

  test("localizePathname falls back to the default's page only when asked", () => {
    expect(r().localizePathname("/repairs/brakes", "hi")).toBe("/hi/repairs/brakes")
    expect(r().localizePathname("/fr/repairs/brakes#top", "hi", { fallback: "default" })).toBe(
      "/repairs/brakes#top",
    )
    expect(r().localizePathname("/repairs/brakes", "fr", { fallback: "default" })).toBe(
      "/fr/repairs/brakes",
    )
    expect(() => r().localizePathname("/repairs/brakes", "gu", { fallback: "default" })).toThrow(
      /not a served locale/,
    )
  })

  test("a pageLocales that throws, or answers what the registry lacks, fails loudly", () => {
    const throwing = defineI18nRouting(registry(), {
      pageLocales: () => {
        throw new Error("no such page table")
      },
    })
    const message = 'pageLocales threw for "/x": no such page table'
    expect(() => throwing.localesOf("/fr/x")).toThrow(message)
    expect(() => throwing.alternates("/x")).toThrow(message)
    expect(() => throwing.matchSegment("fr", "/fr/x")).toThrow(message)
    expect(() => throwing.localizePathname("/x", "fr", { fallback: "default" })).toThrow(message)
    expect(throwing.localizePathname("/x", "fr")).toBe("/fr/x")
    expect(() =>
      defineI18nRouting(registry(), {
        pageLocales: () => {
          throw "a string"
        },
      }).localesOf("/x"),
    ).toThrow('pageLocales threw for "/x": a string')
    expect(() =>
      defineI18nRouting<string>(registry(), { pageLocales: () => ["en", "de"] }).localesOf("/x"),
    ).toThrow('pageLocales returned "de" for "/x", which the locale registry does not declare')
    expect(() =>
      defineI18nRouting(registry(), {
        // What untyped code can hand back.
        pageLocales: () => JSON.parse('"en"'),
      }).localesOf("/x"),
    ).toThrow('pageLocales returned string for "/x"')
  })

  test("property: every page of a cluster lists the same alternates, and only its own locales", () => {
    // mulberry32: a fixed seed, so a failure reproduces.
    let seed = 0x5eed
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const all: readonly Key[] = ["en", "fr", "pt-BR", "hi", "gu"]
    const served: readonly Key[] = ["en", "fr", "pt-BR", "hi"]
    for (let round = 0; round < 25; round++) {
      const table = new Map<string, readonly Key[] | undefined>()
      for (let page = 0; page < 12; page++) {
        const picked = all.filter(() => random() < 0.5)
        table.set(`/p${page}`, random() < 0.2 ? undefined : picked)
      }
      const router = defineI18nRouting(registry(), {
        pageLocales: (pathname) => table.get(pathname),
      })
      for (const [page, listed] of table) {
        const cluster = listed === undefined ? served : served.filter((k) => listed.includes(k))
        expect(router.localesOf(page)).toEqual(cluster)
        const seen = new Set<string>()
        let links: readonly { readonly hreflang: string }[] = []
        for (const locale of cluster) {
          const path = router.localizePathname(page, locale)
          links = router.alternates(path, { origin: "https://example.com" }).links
          seen.add(JSON.stringify(links))
          expect(router.matchSegment(locale, `/${locale}${page}`).kind).not.toBe("not-found")
        }
        expect(seen.size).toBeLessThanOrEqual(1)
        const expected: string[] =
          cluster.length < 2 ? [] : cluster.map((k) => (k === "hi" ? "hi-IN" : k))
        if (cluster.length >= 2 && cluster.includes("en")) expected.push("x-default")
        expect(links.map((link) => link.hreflang)).toEqual(expected)
        for (const locale of served.filter((k) => !cluster.includes(k))) {
          expect(router.matchSegment(locale, `/${locale}${page}`)).toEqual({ kind: "not-found" })
        }
      }
    }
  })
})
