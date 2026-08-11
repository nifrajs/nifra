import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { localeDetector } from "../src/detector.ts"

const base = {
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  queryParam: "lang",
  cookie: "locale",
} as const

const app = (options: Parameters<typeof localeDetector>[0] = base) =>
  server()
    .use(localeDetector(options))
    .get("/", (c) => c.json({ locale: c.locale, source: c.localeSource }))

describe("localeDetector()", () => {
  test("derives c.locale/c.localeSource and emits Content-Language", async () => {
    const res = await app().fetch(
      new Request("http://x/", { headers: { "accept-language": "fr-CA" } }),
    )
    expect(await res.json()).toEqual({ locale: "fr", source: "header" })
    expect(res.headers.get("content-language")).toBe("fr")
  })

  test("source priority: query > cookie > header > default", async () => {
    const headers = { cookie: "locale=de", "accept-language": "fr" }
    const q = await app().fetch(new Request("http://x/?lang=en", { headers }))
    expect(await q.json()).toEqual({ locale: "en", source: "query" })
    const c = await app().fetch(new Request("http://x/", { headers }))
    expect(await c.json()).toEqual({ locale: "de", source: "cookie" })
    const d = await app().fetch(new Request("http://x/"))
    expect(await d.json()).toEqual({ locale: "en", source: "default" })
  })

  test("a hostile ?lang is never reflected into context or headers", async () => {
    const res = await app().fetch(
      new Request(`http://x/?lang=${encodeURIComponent("<script>x</script>")}`),
    )
    expect(await res.json()).toEqual({ locale: "en", source: "default" })
    expect(res.headers.get("content-language")).toBe("en")
  })

  test("keeps a handler-set Content-Language; header:false disables emission", async () => {
    const existing = server()
      .use(localeDetector(base))
      .get("/", () => new Response("ok", { headers: { "content-language": "de" } }))
    const kept = await existing.fetch(new Request("http://x/"))
    expect(kept.headers.get("content-language")).toBe("de")

    const disabled = await app({ ...base, header: false }).fetch(new Request("http://x/"))
    expect(disabled.headers.get("content-language")).toBeNull()
  })

  describe("persist", () => {
    const persisting = () => app({ ...base, persist: true })

    test("writes the cookie only for a query-source choice that differs", async () => {
      const res = await persisting().fetch(new Request("http://x/?lang=fr"))
      const cookie = res.headers.get("set-cookie")
      expect(cookie).toStartWith("locale=fr")
      expect(cookie).toContain("Path=/")
      expect(cookie).toContain("SameSite=Lax")
      expect(cookie).toContain("Max-Age=31536000")
      expect(cookie).not.toContain("HttpOnly")
    })

    test("does not write for header-derived or default locales", async () => {
      const header = await persisting().fetch(
        new Request("http://x/", { headers: { "accept-language": "fr" } }),
      )
      expect(header.headers.get("set-cookie")).toBeNull()
      const fallback = await persisting().fetch(new Request("http://x/"))
      expect(fallback.headers.get("set-cookie")).toBeNull()
    })

    test("does not rewrite a cookie that already resolves to the query choice", async () => {
      const same = await persisting().fetch(
        new Request("http://x/?lang=fr", { headers: { cookie: "locale=fr" } }),
      )
      expect(same.headers.get("set-cookie")).toBeNull()
      const differs = await persisting().fetch(
        new Request("http://x/?lang=fr", { headers: { cookie: "locale=de" } }),
      )
      expect(differs.headers.get("set-cookie")).toStartWith("locale=fr")
    })

    test("honors cookieMaxAge", async () => {
      const res = await app({ ...base, persist: true, cookieMaxAge: 60 }).fetch(
        new Request("http://x/?lang=fr"),
      )
      expect(res.headers.get("set-cookie")).toContain("Max-Age=60")
    })
  })

  test("validates construction", () => {
    expect(() => localeDetector({ locales: [], defaultLocale: "en" })).toThrow(/locales/)
    expect(() => localeDetector({ locales: ["en"], defaultLocale: "fr" })).toThrow(/defaultLocale/)
    expect(() => localeDetector({ locales: ["en"], defaultLocale: "en", persist: true })).toThrow(
      /persist/,
    )
    expect(() => localeDetector({ ...base, persist: true, cookieMaxAge: 1.5 })).toThrow(
      /maxAge|integer/,
    )
  })
})
