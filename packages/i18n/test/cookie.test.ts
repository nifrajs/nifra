import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { localeDetector } from "../src/detector.ts"
import { localeCookie } from "../src/index.ts"

// The switcher's cookie must be the detector's own `Set-Cookie`, byte for byte, or a choice made in
// the page and one made through `?lang=` become two cookies with different lifetimes or scopes.
const detectorCookie = async (cookie: string, locale: string, cookieMaxAge?: number) => {
  const app = server()
    .use(
      localeDetector({
        locales: ["en", locale],
        defaultLocale: "en",
        queryParam: "lang",
        cookie,
        persist: true,
        ...(cookieMaxAge !== undefined ? { cookieMaxAge } : {}),
      }),
    )
    .get("/", () => "ok")
  const res = await app.fetch(new Request(`http://x/?lang=${encodeURIComponent(locale)}`))
  return res.headers.get("set-cookie")
}

describe("localeCookie", () => {
  test("matches the detector's Set-Cookie for plain and prefixed names", async () => {
    for (const name of ["locale", "__Secure-locale", "__Host-locale", "__secure-lang"]) {
      for (const locale of ["fr", "pt-BR", "zh-Hant-TW"]) {
        expect(localeCookie(name, locale)).toBe((await detectorCookie(name, locale)) as string)
      }
    }
  })

  test("matches a configured Max-Age", async () => {
    expect(localeCookie("locale", "hi", { maxAge: 60 })).toBe(
      (await detectorCookie("locale", "hi", 60)) as string,
    )
  })

  test("encodes the value so it cannot add attributes", () => {
    expect(localeCookie("locale", "en; Domain=evil.com")).toBe(
      "locale=en%3B%20Domain%3Devil.com; Max-Age=31536000; Path=/; SameSite=Lax",
    )
  })

  test("refuses a bad name, a fractional Max-Age and an oversized cookie", () => {
    expect(() => localeCookie("bad name", "en")).toThrow(/RFC 6265 token/)
    expect(() => localeCookie("a;b", "en")).toThrow(/RFC 6265 token/)
    expect(() => localeCookie("locale", "en", { maxAge: 1.5 })).toThrow(/integer/)
    expect(() => localeCookie("locale", "x".repeat(5000))).toThrow(/over the 4096B limit/)
  })
})
