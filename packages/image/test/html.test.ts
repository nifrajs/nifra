import { describe, expect, test } from "bun:test"
import { cloudflareLoader, resolveImage, toHtmlAttrs } from "../src/index.ts"

describe("toHtmlAttrs", () => {
  test("maps ResolvedImage → lowercase HTML attrs (srcset/fetchpriority) and keeps the rest", () => {
    const attrs = toHtmlAttrs(
      resolveImage(
        { src: "/a.jpg", width: 400, height: 300, alt: "A", priority: true, sizes: "100vw" },
        cloudflareLoader(),
      ),
    )
    expect(attrs).toEqual({
      src: "/cdn-cgi/image/format=auto,width=400/a.jpg",
      width: 400,
      height: 300,
      alt: "A",
      loading: "eager", // priority → eager
      decoding: "async",
      srcset:
        "/cdn-cgi/image/format=auto,width=400/a.jpg 400w, /cdn-cgi/image/format=auto,width=800/a.jpg 800w",
      sizes: "100vw",
      fetchpriority: "high", // priority → fetchpriority=high
    })
    // No camelCase leakage.
    expect(attrs).not.toHaveProperty("srcSet")
    expect(attrs).not.toHaveProperty("fetchPriority")
  })

  test("omits unset optionals (no srcset/sizes/fetchpriority keys)", () => {
    // identity loader → every width yields the same URL → no srcSet; no sizes, no priority.
    const attrs = toHtmlAttrs(resolveImage({ src: "/a.png", width: 100, height: 100, alt: "x" }))
    expect(attrs).toEqual({
      src: "/a.png",
      width: 100,
      height: 100,
      alt: "x",
      loading: "lazy",
      decoding: "async",
    })
    expect(Object.keys(attrs)).not.toContain("srcset")
    expect(Object.keys(attrs)).not.toContain("sizes")
    expect(Object.keys(attrs)).not.toContain("fetchpriority")
  })
})
