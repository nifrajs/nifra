import { describe, expect, test } from "bun:test"
import { ogImageResponse, renderOgImage } from "../src/og.ts"

describe("renderOgImage", () => {
  test("renders a deterministic, escaped SVG at the requested dimensions", () => {
    const svg = renderOgImage({
      title: "Ada & <Nifra>",
      description: 'Typed APIs "without drift"',
      eyebrow: "NIFRA",
      width: 1200,
      height: 630,
      background: "#101827",
      accent: "#6ee7b7",
    })

    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"')
    expect(svg).toContain("Ada &amp; &lt;Nifra&gt;")
    expect(svg).toContain("Typed APIs &quot;without drift&quot;")
    expect(svg).not.toContain("<Nifra>")
    expect(renderOgImage({ title: "same" })).toBe(renderOgImage({ title: "same" }))
  })

  test("rejects unsafe text, colors, and dimensions before rendering", () => {
    expect(() => renderOgImage({ title: "" })).toThrow(/title/)
    expect(() => renderOgImage({ title: "x", width: 0 })).toThrow(/width/)
    expect(() => renderOgImage({ title: "x", height: 5000 })).toThrow(/height/)
    expect(() => renderOgImage({ title: "x", background: "red;url(https://evil)" })).toThrow(
      /color/,
    )
    expect(() => renderOgImage({ title: "x\u0000" })).toThrow(/title/)
  })
})

describe("ogImageResponse", () => {
  test("serves cacheable SVG and honors conditional and HEAD requests", async () => {
    const request = new Request("https://example.test/og", { method: "GET" })
    const response = await ogImageResponse({ title: "Nifra" }, request)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    const etag = response.headers.get("etag")!
    expect(etag).toMatch(/^"[0-9a-f]+"$/)
    expect((await response.text()).startsWith("<svg")).toBe(true)

    const conditional = await ogImageResponse(
      { title: "Nifra" },
      new Request("https://example.test/og", { headers: { "if-none-match": etag } }),
    )
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe("")

    const head = await ogImageResponse(
      { title: "Nifra" },
      new Request("https://example.test/og", { method: "HEAD" }),
    )
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })

  test("uses an injected rasterizer without bundling one into the public core", async () => {
    const response = await ogImageResponse(
      {
        title: "Nifra",
        rasterizer: async (svg) => ({
          bytes: new Uint8Array([1, 2, svg.length]),
          contentType: "image/png",
        }),
      },
      new Request("https://example.test/og"),
    )

    expect(response.headers.get("content-type")).toBe("image/png")
    expect([...new Uint8Array(await response.arrayBuffer())]).toHaveLength(3)
  })

  test("ETags represent rasterized bytes, not only the source SVG", async () => {
    const request = new Request("https://example.test/og")
    const first = await ogImageResponse(
      {
        title: "Nifra",
        rasterizer: () => ({ bytes: new Uint8Array([1]), contentType: "image/png" }),
      },
      request,
    )
    const second = await ogImageResponse(
      {
        title: "Nifra",
        rasterizer: () => ({ bytes: new Uint8Array([2]), contentType: "image/png" }),
      },
      request,
    )
    expect(first.headers.get("etag")).not.toBe(second.headers.get("etag"))
  })
})
