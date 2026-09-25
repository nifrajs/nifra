import { describe, expect, test } from "bun:test"
import { manifestLink, pwaManifest, serializeManifest } from "../src/pwa-manifest.ts"

describe("pwaManifest", () => {
  test("builds a minimal installable manifest with defaults", () => {
    expect(pwaManifest({ name: "News" })).toEqual({
      name: "News",
      start_url: "/",
      scope: "/",
      display: "standalone",
    })
    expect(pwaManifest({ short_name: "News", start_url: "/app/home" })).toEqual({
      short_name: "News",
      start_url: "/app/home",
      scope: "/app/",
      display: "standalone",
    })
  })

  test("passes options through and stringifies deterministically", () => {
    const doc = pwaManifest({
      name: "News",
      short_name: "N",
      description: "Read things",
      theme_color: "#3367d6",
      background_color: "#ffffff",
      lang: "en",
      dir: "ltr",
      categories: ["news"],
      icons: [{ src: "/icon.png", sizes: "192x192 512x512", type: "image/png" }],
    })
    expect(doc.theme_color).toBe("#3367d6")
    expect(doc.icons).toEqual([{ src: "/icon.png", sizes: "192x192 512x512", type: "image/png" }])
    expect(JSON.parse(serializeManifest(doc))).toEqual(doc)
  })

  test("derives scope from absolute start URLs, keeps query strings", () => {
    expect(pwaManifest({ name: "N", start_url: "https://x.com/app/home" }).scope).toBe(
      "https://x.com/app/",
    )
    expect(pwaManifest({ name: "N", start_url: "/app/home?x=1" }).scope).toBe("/app/")
  })

  test("fails loud on invalid input", () => {
    expect(() => pwaManifest({})).toThrow(/name \/ short_name/)
    expect(() => pwaManifest({ name: "   " })).toThrow(/name must not be empty/)
    expect(() => pwaManifest({ short_name: "\t" })).toThrow(/short_name must not be empty/)
    expect(() => pwaManifest({ name: "N", start_url: "" })).toThrow(/start_url/)
    expect(() => pwaManifest({ name: "N", start_url: "//evil.test/app" })).toThrow(/start_url/)
    expect(() => pwaManifest({ name: "N", start_url: "javascript:alert(1)" })).toThrow(/start_url/)
    expect(() => pwaManifest({ name: "N", start_url: "not a url" })).toThrow(/path or URL/)
    expect(() => pwaManifest({ name: "N", display: "weird" as never })).toThrow(/display/)
    expect(() => pwaManifest({ name: "N", dir: "sideways" as never })).toThrow(/dir/)
    expect(() => pwaManifest({ name: "N", icons: [{ src: "" }] })).toThrow(/src/)
    expect(() => pwaManifest({ name: "N", icons: [{ src: "/i.png", sizes: "big" }] })).toThrow(
      /sizes/,
    )
    expect(() => pwaManifest({ name: "N", icons: [{ src: "/i.png", purpose: "round" }] })).toThrow(
      /purpose/,
    )
    expect(() => pwaManifest({ name: "N", screenshots: [{ src: "" }] })).toThrow(/src/)
    expect(() => pwaManifest({ name: "N", shortcuts: [{ name: "", url: "/x" }] })).toThrow(
      /shortcuts\[0\].name/,
    )
    expect(() => manifestLink("")).toThrow(/href/)
  })

  test("normalizes icon purpose tokens and emits shortcuts", () => {
    const doc = pwaManifest({
      name: "N",
      icons: [{ src: "/i.png", purpose: "maskable  any" }],
      shortcuts: [
        {
          name: "New",
          url: "/new",
          icons: [{ src: "/new.png", sizes: "96x96" }],
        },
      ],
    })
    expect(doc.icons).toEqual([{ src: "/i.png", sizes: "any", purpose: "maskable any" }])
    expect(doc.shortcuts).toEqual([
      { name: "New", url: "/new", icons: [{ src: "/new.png", sizes: "96x96" }] },
    ])
  })

  test("manifestLink emits the head tag with quote escaping", () => {
    expect(manifestLink()).toBe('<link rel="manifest" href="/manifest.webmanifest">')
    expect(manifestLink('/m?a="b"')).toBe('<link rel="manifest" href="/m?a=&quot;b&quot;">')
  })
})
