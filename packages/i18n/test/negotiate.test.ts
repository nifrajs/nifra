import { describe, expect, test } from "bun:test"
import { negotiateLocale } from "../src/index.ts"

const req = (headers: Record<string, string> = {}): Request => new Request("http://x/", { headers })
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
})
