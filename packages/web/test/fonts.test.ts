import { describe, expect, test } from "bun:test"
import {
  createWebApp,
  fontFace,
  fontPreload,
  type Manifest,
  type RenderAdapter,
} from "../src/index.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

describe("fontFace()", () => {
  test("defaults to font-display: swap and infers format() from the extension", () => {
    const css = fontFace({ family: "Inter", src: [{ url: "/fonts/inter.woff2" }] })
    expect(css).toContain('font-family: "Inter"')
    expect(css).toContain('src: url("/fonts/inter.woff2") format("woff2")')
    expect(css).toContain("font-display: swap")
    expect(css.startsWith("@font-face {")).toBe(true)
  })

  test("emits multiple sources (best-first) with explicit + inferred formats", () => {
    const css = fontFace({
      family: "Inter",
      src: [{ url: "/f/inter.woff2" }, { url: "/f/inter.ttf", format: "truetype" }],
    })
    expect(css).toContain(
      'src: url("/f/inter.woff2") format("woff2"), url("/f/inter.ttf") format("truetype")',
    )
  })

  test("serializes weight (number + variable range), style, unicode-range, and metric overrides", () => {
    const css = fontFace({
      family: "Inter",
      src: [{ url: "/f/inter.woff2" }],
      weight: "100 900",
      style: "italic",
      display: "optional",
      unicodeRange: "U+0000-00FF",
      sizeAdjust: "105%",
      ascentOverride: "90%",
      descentOverride: "22%",
      lineGapOverride: "0%",
    })
    expect(css).toContain("font-weight: 100 900")
    expect(css).toContain("font-style: italic")
    expect(css).toContain("font-display: optional")
    expect(css).toContain("unicode-range: U+0000-00FF")
    expect(css).toContain("size-adjust: 105%")
    expect(css).toContain("ascent-override: 90%")
    expect(css).toContain("descent-override: 22%")
    expect(css).toContain("line-gap-override: 0%")
  })

  test("a numeric weight serializes too", () => {
    expect(fontFace({ family: "X", src: [{ url: "/x.woff2" }], weight: 700 })).toContain(
      "font-weight: 700",
    )
  })

  test("infers no format() for an unknown extension", () => {
    const css = fontFace({ family: "X", src: [{ url: "/x.bin" }] })
    expect(css).toContain('src: url("/x.bin")')
    expect(css).not.toContain("format(")
  })

  test("escapes the family/url and sanitizes token values (no CSS injection)", () => {
    const css = fontFace({
      family: 'Evil"; } body { display:none } @font-face { font-family:"x',
      src: [{ url: '/f.woff2") ; } body{color:red} /*' }],
      weight: "400; } body { color: red }",
    })
    // The family + url stay inside their quoted strings — the `"` is escaped, so it can't break out
    // and start a new rule. The injected text survives as inert (escaped) string content; what must
    // NOT appear is an *unescaped* closing quote (`Evil";`) that would terminate the value early.
    expect(css).toContain('font-family: "Evil\\"')
    expect(css).not.toContain('Evil";')
    expect(css).toContain('url("/f.woff2\\")') // closing quote escaped, stays inside url("…")
    expect(css).not.toContain('woff2") ;') // no unescaped breakout from the url() either
    // The unquoted weight token has its declaration-ending chars stripped.
    expect(css).toContain("font-weight: 400  body  color: red")
    expect(css).not.toMatch(/font-weight: 400;\s*}/)
  })

  test("throws when src is empty", () => {
    expect(() => fontFace({ family: "X", src: [] })).toThrow(/at least one source/)
  })
})

describe("fontPreload()", () => {
  test("produces a font preload link with inferred type + crossorigin=anonymous", () => {
    expect(fontPreload({ href: "/fonts/inter.woff2" })).toEqual({
      rel: "preload",
      as: "font",
      href: "/fonts/inter.woff2",
      type: "font/woff2",
      crossorigin: "anonymous",
    })
  })

  test("honors an explicit type + crossOrigin", () => {
    expect(
      fontPreload({ href: "/f/x.woff", type: "font/woff", crossOrigin: "use-credentials" }),
    ).toEqual({
      rel: "preload",
      as: "font",
      href: "/f/x.woff",
      type: "font/woff",
      crossorigin: "use-credentials",
    })
  })

  test("omits type for an unrecognized extension", () => {
    const link = fontPreload({ href: "/f/x" })
    expect(link.type).toBeUndefined()
    expect(link).toMatchObject({
      rel: "preload",
      as: "font",
      href: "/f/x",
      crossorigin: "anonymous",
    })
  })

  test("a fontPreload in a route's meta.link is injected into <head> by renderPage", async () => {
    const stub: RenderAdapter = {
      renderToStream: () => streamOf("<p>hi</p>"),
      hydrationHead: () => "",
    }
    const manifest: Manifest = {
      routes: [
        {
          id: "index",
          pattern: "/",
          layoutIds: [],
          file: "index.tsx",
          load: async () => ({
            default: "home",
            meta: { link: [fontPreload({ href: "/fonts/inter.woff2" })] },
          }),
        },
      ],
      layouts: {},
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    }
    const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
    const html = await (await app.fetch(new Request("http://x/"))).text()
    expect(html).toContain('rel="preload"')
    expect(html).toContain('as="font"')
    expect(html).toContain('href="/fonts/inter.woff2"')
    expect(html).toContain('crossorigin="anonymous"')
  })
})
