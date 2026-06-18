import { describe, expect, test } from "bun:test"
import { cloudflareLoader, identityLoader, resolveImage, selfHostedLoader } from "../src/index.ts"

describe("loaders", () => {
  test("identityLoader returns the source unchanged", () => {
    expect(identityLoader({ src: "/a.png", width: 100 })).toBe("/a.png")
  })

  test("cloudflareLoader builds /cdn-cgi/image URLs (format=auto, width, quality)", () => {
    const l = cloudflareLoader()
    expect(l({ src: "/hero.jpg", width: 640 })).toBe(
      "/cdn-cgi/image/format=auto,width=640/hero.jpg",
    )
    expect(l({ src: "/hero.jpg", width: 640, quality: 80 })).toBe(
      "/cdn-cgi/image/format=auto,width=640,quality=80/hero.jpg",
    )
  })

  test("cloudflareLoader honors a base prefix + strips the duplicate leading slash", () => {
    const l = cloudflareLoader({ base: "https://cdn.example" })
    expect(l({ src: "/x.png", width: 100 })).toBe(
      "/cdn-cgi/image/format=auto,width=100/https://cdn.example/x.png",
    )
  })

  test("selfHostedLoader builds /endpoint?src=&w=[&q=] (URL-encoded)", () => {
    const l = selfHostedLoader({ endpoint: "/_image" })
    expect(l({ src: "/hero.jpg", width: 640 })).toBe("/_image?src=%2Fhero.jpg&w=640")
    expect(l({ src: "/hero.jpg", width: 640, quality: 80 })).toBe(
      "/_image?src=%2Fhero.jpg&w=640&q=80",
    )
    // Encodes a remote source + special chars so the endpoint parses one well-formed `src`.
    expect(l({ src: "https://cdn.example/a b.png", width: 320 })).toBe(
      "/_image?src=https%3A%2F%2Fcdn.example%2Fa+b.png&w=320",
    )
  })
})

describe("resolveImage", () => {
  test("CLS-safe defaults: lazy, async decode, intrinsic w/h, retina srcSet", () => {
    const r = resolveImage({ src: "/a.jpg", width: 400, height: 300, alt: "A" }, cloudflareLoader())
    expect(r).toMatchObject({
      width: 400,
      height: 300,
      alt: "A",
      loading: "lazy",
      decoding: "async",
    })
    expect(r.src).toBe("/cdn-cgi/image/format=auto,width=400/a.jpg") // 1× fallback
    expect(r.srcSet).toBe(
      "/cdn-cgi/image/format=auto,width=400/a.jpg 400w, /cdn-cgi/image/format=auto,width=800/a.jpg 800w",
    )
    expect(r.fetchPriority).toBeUndefined()
  })

  test("explicit widths are de-duped + sorted; sizes + quality thread through", () => {
    const r = resolveImage(
      {
        src: "/a.jpg",
        width: 320,
        height: 240,
        alt: "",
        widths: [640, 320, 640, 1280],
        sizes: "100vw",
        quality: 70,
      },
      cloudflareLoader(),
    )
    expect(r.sizes).toBe("100vw")
    expect(r.srcSet).toBe(
      "/cdn-cgi/image/format=auto,width=320,quality=70/a.jpg 320w, " +
        "/cdn-cgi/image/format=auto,width=640,quality=70/a.jpg 640w, " +
        "/cdn-cgi/image/format=auto,width=1280,quality=70/a.jpg 1280w",
    )
  })

  test("identity loader → no srcSet (every width yields the same URL)", () => {
    const r = resolveImage({ src: "/a.png", width: 100, height: 100, alt: "x" }) // default loader = identity
    expect(r.src).toBe("/a.png")
    expect(r.srcSet).toBeUndefined()
  })

  test("priority → eager + fetchPriority high; explicit eager without priority", () => {
    const p = resolveImage({ src: "/a.jpg", width: 10, height: 10, alt: "", priority: true })
    expect(p.loading).toBe("eager")
    expect(p.fetchPriority).toBe("high")
    const e = resolveImage({ src: "/a.jpg", width: 10, height: 10, alt: "", loading: "eager" })
    expect(e.loading).toBe("eager")
    expect(e.fetchPriority).toBeUndefined()
  })

  test("rejects a non-positive / non-finite width or height (CLS contract)", () => {
    expect(() => resolveImage({ src: "/a", width: 0, height: 10, alt: "" })).toThrow(
      /positive width \+ height/,
    )
    expect(() => resolveImage({ src: "/a", width: 10, height: -1, alt: "" })).toThrow(/CLS/)
    expect(() => resolveImage({ src: "/a", width: Number.NaN, height: 10, alt: "" })).toThrow(/CLS/)
  })
})
