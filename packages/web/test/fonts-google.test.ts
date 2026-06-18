import { describe, expect, test } from "bun:test"
import {
  googleFontsCssUrl,
  isAllowedFontUrl,
  loadGoogleFont,
  parseGoogleFontCss,
} from "../src/fonts-google.ts"

// A representative Google Fonts CSS2 response: two named subsets, each its own @font-face with a
// `/* subset */` label, a gstatic woff2 src, and a unicode-range.
const GOOGLE_CSS = `/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/latin400.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
/* latin-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/latinext400.woff2) format('woff2');
  unicode-range: U+0100-024F;
}`

/** A canned fetch: Google's stylesheet for the css2 endpoint, distinct bytes per gstatic file. */
function cannedFetch(css = GOOGLE_CSS): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.startsWith("https://fonts.googleapis.com/css2")) return new Response(css)
    if (url.startsWith("https://fonts.gstatic.com/")) {
      return new Response(new TextEncoder().encode(`WOFF2:${url}`))
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

/** An in-memory writer sink for assertions. */
function memWriter() {
  const written = new Map<string, Uint8Array>()
  return {
    written,
    writeFile: async (path: string, bytes: Uint8Array): Promise<void> => {
      written.set(path, bytes)
    },
  }
}

describe("googleFontsCssUrl()", () => {
  test("defaults to weight 400, normal, display swap", () => {
    expect(googleFontsCssUrl({ family: "Inter" })).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap",
    )
  })

  test("dedupes + sorts weights numerically", () => {
    expect(googleFontsCssUrl({ family: "Inter", weights: [700, 400, 700] })).toContain(
      "family=Inter:wght@400;700",
    )
  })

  test("italic + normal emits ital,wght tuples (normal first)", () => {
    expect(
      googleFontsCssUrl({ family: "Inter", weights: [400, 700], styles: ["normal", "italic"] }),
    ).toContain("family=Inter:ital,wght@0,400;0,700;1,400;1,700")
  })

  test("italic-only emits just the ital=1 tuples", () => {
    expect(googleFontsCssUrl({ family: "Inter", styles: ["italic"] })).toContain(
      "family=Inter:ital,wght@1,400",
    )
  })

  test("encodes a space in the family as +", () => {
    expect(googleFontsCssUrl({ family: "Open Sans" })).toContain("family=Open+Sans:")
  })

  test("normalizes keyword weights and a variable range", () => {
    expect(googleFontsCssUrl({ family: "Inter", weights: ["normal", "bold"] })).toContain(
      "wght@400;700",
    )
    expect(googleFontsCssUrl({ family: "Inter", weights: ["100 900"] })).toContain("wght@100 900")
  })

  test("text subsetting adds an encoded &text= param", () => {
    const url = googleFontsCssUrl({ family: "Inter", text: "Hi!" })
    expect(url).toContain("&text=Hi!")
    const url2 = googleFontsCssUrl({ family: "Inter", text: "a b" })
    expect(url2).toContain("&text=a%20b")
  })

  test("rejects a family with injection characters", () => {
    expect(() => googleFontsCssUrl({ family: "Inter:wght@400&family=Evil" })).toThrow(
      /invalid family/,
    )
    expect(() => googleFontsCssUrl({ family: "../etc/passwd" })).toThrow(/invalid family/)
  })

  test("rejects out-of-range / nonsense weights and bad styles/display", () => {
    expect(() => googleFontsCssUrl({ family: "Inter", weights: [5000] })).toThrow(/invalid weight/)
    expect(() => googleFontsCssUrl({ family: "Inter", weights: ["abc"] })).toThrow(/invalid weight/)
    // @ts-expect-error — style not in the union
    expect(() => googleFontsCssUrl({ family: "Inter", styles: ["slanted"] })).toThrow(
      /invalid style/,
    )
    // @ts-expect-error — display not in the union
    expect(() => googleFontsCssUrl({ family: "Inter", display: "explode" })).toThrow(
      /invalid display/,
    )
  })
})

describe("parseGoogleFontCss()", () => {
  test("parses each @font-face with its preceding subset label", () => {
    const faces = parseGoogleFontCss(GOOGLE_CSS)
    expect(faces.length).toBe(2)
    expect(faces[0]).toMatchObject({
      family: "Inter",
      style: "normal",
      weight: "400",
      subset: "latin",
      unicodeRange: "U+0000-00FF, U+0131",
    })
    expect(faces[0]?.src[0]).toEqual({
      url: "https://fonts.gstatic.com/s/inter/v13/latin400.woff2",
      format: "woff2",
    })
    expect(faces[1]?.subset).toBe("latin-ext")
  })

  test("labels a face with no comment as 'default' and skips a face with no src", () => {
    const css = `@font-face { font-family: 'X'; font-weight: 400; src: url(https://fonts.gstatic.com/x.woff2) format('woff2'); }
@font-face { font-family: 'Y'; font-weight: 700; }`
    const faces = parseGoogleFontCss(css)
    expect(faces.length).toBe(1)
    expect(faces[0]).toMatchObject({ family: "X", subset: "default" })
  })
})

describe("isAllowedFontUrl()", () => {
  test("allows only https fonts.gstatic.com", () => {
    expect(isAllowedFontUrl("https://fonts.gstatic.com/s/inter/x.woff2")).toBe(true)
    expect(isAllowedFontUrl("http://fonts.gstatic.com/x.woff2")).toBe(false) // not https
    expect(isAllowedFontUrl("https://evil.com/x.woff2")).toBe(false)
    expect(isAllowedFontUrl("https://fonts.gstatic.com.evil.com/x.woff2")).toBe(false)
    expect(isAllowedFontUrl("file:///etc/passwd")).toBe(false)
    expect(isAllowedFontUrl("not a url")).toBe(false)
  })
})

describe("loadGoogleFont()", () => {
  test("downloads, hashes, self-hosts, and emits @font-face CSS + preloads", async () => {
    const { written, writeFile } = memWriter()
    const result = await loadGoogleFont(
      { family: "Inter", weights: [400] },
      { outDir: "public/fonts", fetch: cannedFetch(), writeFile },
    )

    // Two subsets (latin + latin-ext) → two written files, hashed.
    expect(written.size).toBe(2)
    for (const path of written.keys()) {
      expect(path).toMatch(/^public\/fonts\/inter-latin(-ext)?-normal-400-[0-9a-f]{16}\.woff2$/)
    }
    // Generated stylesheet self-hosts (no gstatic URL) and keeps the CLS-safe bits.
    expect(result.css).toContain('font-family: "Inter"')
    expect(result.css).toContain("font-display: swap")
    expect(result.css).toContain("unicode-range: U+0000-00FF, U+0131")
    expect(result.css).toContain('url("/fonts/inter-latin-normal-400-')
    expect(result.css).not.toContain("gstatic.com")
    // Preloads are spreadable into meta.link.
    expect(result.preloads.length).toBe(2)
    expect(result.preloads[0]).toMatchObject({
      rel: "preload",
      as: "font",
      crossorigin: "anonymous",
    })
    expect(result.preloads[0]?.href).toMatch(/^\/fonts\/inter-/)
    expect(result.assets[0]?.sourceUrl).toContain("fonts.gstatic.com")
  })

  test("a content hash is deterministic for identical bytes", async () => {
    const run = async () => {
      const { written, writeFile } = memWriter()
      await loadGoogleFont({ family: "Inter" }, { outDir: "out", fetch: cannedFetch(), writeFile })
      return [...written.keys()].sort()
    }
    expect(await run()).toEqual(await run())
  })

  test("filters to the requested named subsets", async () => {
    const { written, writeFile } = memWriter()
    const result = await loadGoogleFont(
      { family: "Inter", subsets: ["latin"] },
      { outDir: "out", fetch: cannedFetch(), writeFile },
    )
    expect(written.size).toBe(1)
    expect(result.assets[0]?.subset).toBe("latin")
  })

  test("honors a custom publicPath (trailing slash trimmed)", async () => {
    const { writeFile } = memWriter()
    const result = await loadGoogleFont(
      { family: "Inter", subsets: ["latin"] },
      { outDir: "out", publicPath: "/assets/fonts/", fetch: cannedFetch(), writeFile },
    )
    expect(result.assets[0]?.href).toMatch(/^\/assets\/fonts\/inter-/)
    expect(result.css).toContain('url("/assets/fonts/inter-')
  })

  test("forwards CLS metric overrides into every face", async () => {
    const { writeFile } = memWriter()
    const result = await loadGoogleFont(
      { family: "Inter", subsets: ["latin"], sizeAdjust: "105%", ascentOverride: "90%" },
      { outDir: "out", fetch: cannedFetch(), writeFile },
    )
    expect(result.css).toContain("size-adjust: 105%")
    expect(result.css).toContain("ascent-override: 90%")
  })

  test("SECURITY: refuses to download a font from a non-Google host (SSRF gate)", async () => {
    const evilCss = `/* latin */
@font-face {
  font-family: 'Inter';
  font-weight: 400;
  src: url(https://evil.example.com/exfil.woff2) format('woff2');
}`
    let evilHit = false
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.startsWith("https://fonts.googleapis.com/css2")) return new Response(evilCss)
      if (url.includes("evil.example.com")) evilHit = true
      return new Response(new TextEncoder().encode("x"))
    }) as typeof fetch
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont({ family: "Inter" }, { outDir: "out", fetch: fetchImpl, writeFile }),
    ).rejects.toThrow(/non-Google host/)
    expect(evilHit).toBe(false) // never even attempted the fetch
  })

  test("SECURITY: rejects a font file that exceeds the size cap", async () => {
    const bigFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.startsWith("https://fonts.googleapis.com/css2")) return new Response(GOOGLE_CSS)
      return new Response(new Uint8Array(1024)) // 1 KB, over our 16-byte cap below
    }) as typeof fetch
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont(
        { family: "Inter", subsets: ["latin"] },
        { outDir: "out", fetch: bigFetch, writeFile, maxBytesPerFile: 16 },
      ),
    ).rejects.toThrow(/exceeds 16 bytes/)
  })

  test("SECURITY: rejects a font whose advertised Content-Length exceeds the cap (pre-download)", async () => {
    const lyingFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.startsWith("https://fonts.googleapis.com/css2")) return new Response(GOOGLE_CSS)
      return new Response(new Uint8Array(4), { headers: { "content-length": "9999" } })
    }) as typeof fetch
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont(
        { family: "Inter", subsets: ["latin"] },
        { outDir: "out", fetch: lyingFetch, writeFile, maxBytesPerFile: 16 },
      ),
    ).rejects.toThrow(/exceeds 16 bytes/)
  })

  test("rejects an invalid subset name", async () => {
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont(
        { family: "Inter", subsets: ["latin; rm -rf"] },
        { outDir: "out", fetch: cannedFetch(), writeFile },
      ),
    ).rejects.toThrow(/invalid subset/)
  })

  test("rejects text subsetting longer than the cap", async () => {
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont(
        { family: "Inter", text: "x".repeat(3000) },
        { outDir: "out", fetch: cannedFetch(), writeFile },
      ),
    ).rejects.toThrow(/text exceeds/)
  })

  test("throws when no face matches the requested subsets", async () => {
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont(
        { family: "Inter", subsets: ["cyrillic"] },
        { outDir: "out", fetch: cannedFetch(), writeFile },
      ),
    ).rejects.toThrow(/no faces for subsets \[cyrillic\]/)
  })

  test("throws when Google returns no @font-face rules", async () => {
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont(
        { family: "Inter" },
        { outDir: "out", fetch: cannedFetch("/* nothing here */"), writeFile },
      ),
    ).rejects.toThrow(/no @font-face rules/)
  })

  test("propagates a non-OK stylesheet response (host only, no full URL leak)", async () => {
    const failFetch = (async (_input: Parameters<typeof fetch>[0]) =>
      new Response("nope", { status: 503 })) as typeof fetch
    const { writeFile } = memWriter()
    await expect(
      loadGoogleFont({ family: "Inter" }, { outDir: "out", fetch: failFetch, writeFile }),
    ).rejects.toThrow(/fetch failed \(503\) from fonts\.googleapis\.com/)
  })
})
