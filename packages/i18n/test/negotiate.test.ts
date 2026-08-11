import { describe, expect, test } from "bun:test"
import { negotiateLocale, resolveLocale } from "../src/index.ts"

const req = (headers: Record<string, string> = {}, url = "http://x/"): Request =>
  new Request(url, { headers })
const opts = { locales: ["en", "fr", "de"], defaultLocale: "en" } as const

describe("negotiateLocale", () => {
  test("falls back to defaultLocale with no header", () => {
    expect(negotiateLocale(req(), opts)).toBe("en")
  })

  test("picks the highest-quality supported tag", () => {
    expect(negotiateLocale(req({ "accept-language": "fr-CA,fr;q=0.9,en;q=0.5" }), opts)).toBe("fr")
    expect(negotiateLocale(req({ "accept-language": "de;q=0.8,fr;q=0.9" }), opts)).toBe("fr")
  })

  test("matches a base subtag (fr-CA → fr) and is case-insensitive", () => {
    expect(negotiateLocale(req({ "accept-language": "FR-ca" }), opts)).toBe("fr")
  })

  test("skips unsupported + zero-quality tags", () => {
    expect(negotiateLocale(req({ "accept-language": "es,it;q=0,de" }), opts)).toBe("de")
    expect(negotiateLocale(req({ "accept-language": "es-ES,pt" }), opts)).toBe("en") // none match
  })

  test("'*' takes the first supported locale", () => {
    expect(negotiateLocale(req({ "accept-language": "*" }), opts)).toBe("en")
  })

  test("a valid cookie wins over Accept-Language", () => {
    const o = { ...opts, cookie: "lang" }
    expect(negotiateLocale(req({ cookie: "lang=de", "accept-language": "fr" }), o)).toBe("de")
    // an unsupported / missing cookie falls through to Accept-Language
    expect(negotiateLocale(req({ cookie: "lang=es", "accept-language": "fr" }), o)).toBe("fr")
    expect(negotiateLocale(req({ cookie: "other=de", "accept-language": "fr" }), o)).toBe("fr")
    expect(negotiateLocale(req({ "accept-language": "fr" }), o)).toBe("fr") // no cookie header
  })

  test("a valid query parameter wins over cookie and Accept-Language", () => {
    const o = { ...opts, queryParam: "lang", cookie: "locale" }
    const headers = { cookie: "locale=de", "accept-language": "fr" }
    expect(negotiateLocale(req(headers, "http://x/?lang=en"), o)).toBe("en")
    // an invalid query value falls through to the cookie, then the header
    expect(negotiateLocale(req(headers, "http://x/?lang=es"), o)).toBe("de")
    expect(negotiateLocale(req({ "accept-language": "fr" }, "http://x/?lang=xx"), o)).toBe("fr")
    // base-subtag + case-insensitive matching applies to the query value too
    expect(negotiateLocale(req({}, "http://x/?lang=FR-ca"), o)).toBe("fr")
  })

  test("a hostile query value is never reflected - output is allow-list only", () => {
    const o = { ...opts, queryParam: "lang" }
    const allowList: readonly string[] = opts.locales
    for (const evil of [
      "<script>alert(1)</script>",
      "../../etc/passwd",
      "en%0d%0aSet-Cookie:x=1",
    ]) {
      const locale = negotiateLocale(req({}, `http://x/?lang=${encodeURIComponent(evil)}`), o)
      expect(allowList).toContain(locale)
    }
  })

  test("a long Accept-Language header stays linear and correct", () => {
    const header = `${Array.from({ length: 5000 }, (_, i) => `xx-${i};q=0.9`).join(",")},de;q=0.1`
    expect(negotiateLocale(req({ "accept-language": header }), opts)).toBe("de")
  })
})

describe("resolveLocale", () => {
  const o = { ...opts, queryParam: "lang", cookie: "locale" } as const

  test("reports the winning source", () => {
    expect(resolveLocale(req({}, "http://x/?lang=fr"), o)).toEqual({
      locale: "fr",
      source: "query",
    })
    expect(resolveLocale(req({ cookie: "locale=de" }), o)).toEqual({
      locale: "de",
      source: "cookie",
      cookie: "de",
    })
    expect(resolveLocale(req({ "accept-language": "fr" }), o)).toEqual({
      locale: "fr",
      source: "header",
    })
    expect(resolveLocale(req(), o)).toEqual({ locale: "en", source: "default" })
  })

  test("reports what the cookie currently resolves to alongside a query win", () => {
    expect(resolveLocale(req({ cookie: "locale=de" }, "http://x/?lang=fr"), o)).toEqual({
      locale: "fr",
      source: "query",
      cookie: "de",
    })
    // an invalid cookie value is reported as absent, not echoed
    expect(resolveLocale(req({ cookie: "locale=xx" }, "http://x/?lang=fr"), o)).toEqual({
      locale: "fr",
      source: "query",
    })
  })

  test("accepts structural parts instead of a Request", () => {
    const headers = new Headers({ cookie: "locale=de" })
    const header = (name: string) => headers.get(name)
    expect(resolveLocale({ header, url: "http://x/a?lang=fr#frag" }, o).locale).toBe("fr")
    expect(resolveLocale({ header, query: new URLSearchParams("lang=fr") }, o).locale).toBe("fr")
    // no url + no query: the query source is skipped, not an error
    expect(resolveLocale({ header }, o)).toEqual({ locale: "de", source: "cookie", cookie: "de" })
  })
})
