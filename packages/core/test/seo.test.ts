import { afterEach, describe, expect, test } from "bun:test"
import { type RunningServer, robots, server, sitemap } from "../src/index.ts"

describe("sitemap()", () => {
  test("emits a valid urlset and makes path-only urls absolute via hostname", () => {
    const xml = sitemap([{ url: "/" }, { url: "about" }], { hostname: "https://example.com/" })
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(xml).toContain("<loc>https://example.com/</loc>") // trailing slash on hostname stripped, "/" kept
    expect(xml).toContain("<loc>https://example.com/about</loc>") // missing leading slash added
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true)
  })

  test("leaves already-absolute urls untouched", () => {
    const xml = sitemap([{ url: "https://cdn.other.com/x" }], { hostname: "https://example.com" })
    expect(xml).toContain("<loc>https://cdn.other.com/x</loc>")
  })

  test("serializes lastmod (Date → ISO, string passthrough), changefreq, and priority", () => {
    const xml = sitemap([
      {
        url: "/a",
        lastmod: new Date("2026-06-08T00:00:00.000Z"),
        changefreq: "daily",
        priority: 1,
      },
      { url: "/b", lastmod: "2026-01-01", priority: 0.25 },
    ])
    expect(xml).toContain("<lastmod>2026-06-08T00:00:00.000Z</lastmod>")
    expect(xml).toContain("<changefreq>daily</changefreq>")
    expect(xml).toContain("<priority>1.0</priority>")
    expect(xml).toContain("<lastmod>2026-01-01</lastmod>")
    expect(xml).toContain("<priority>0.3</priority>") // 0.25 → toFixed(1)
  })

  test("XML-escapes the loc (no injection from query strings / DB slugs)", () => {
    const xml = sitemap([{ url: "https://x.com/s?a=1&b=2<3" }])
    expect(xml).toContain("<loc>https://x.com/s?a=1&amp;b=2&lt;3</loc>")
    expect(xml).not.toContain("a=1&b=2") // raw ampersand never reaches output
  })

  test("an empty list is still a valid (empty) urlset", () => {
    expect(sitemap([])).toContain("<urlset")
  })

  test("rejects out-of-spec input", () => {
    expect(() => sitemap([{ url: "/", changefreq: "often" as never }])).toThrow(/changefreq/)
    expect(() => sitemap([{ url: "/", priority: 1.5 }])).toThrow(/0.0 and 1.0/)
    expect(() => sitemap([{ url: "/", priority: -0.1 }])).toThrow(/0.0 and 1.0/)
    expect(() => sitemap([{ url: "/", priority: Number.NaN }])).toThrow(/0.0 and 1.0/)
    expect(() => sitemap(Array.from({ length: 50_001 }, () => ({ url: "/" })))).toThrow(/50000/)
  })
})

describe("robots()", () => {
  test("groups directives under user-agents with a blank line between groups", () => {
    const txt = robots({
      rules: [
        { userAgent: "*", allow: ["/"], disallow: ["/admin", "/api"] },
        { userAgent: ["Googlebot", "Bingbot"], crawlDelay: 10 },
      ],
    })
    expect(txt).toContain("User-agent: *")
    expect(txt).toContain("Allow: /")
    expect(txt).toContain("Disallow: /admin")
    expect(txt).toContain("Disallow: /api")
    expect(txt).toContain("User-agent: Googlebot")
    expect(txt).toContain("User-agent: Bingbot")
    expect(txt).toContain("Crawl-delay: 10")
    expect(txt.endsWith("\n")).toBe(true)
  })

  test("appends Sitemap (single or many) and Host lines", () => {
    const one = robots({ rules: [{ userAgent: "*" }], sitemap: "https://x.com/sitemap.xml" })
    expect(one).toContain("Sitemap: https://x.com/sitemap.xml")
    const many = robots({
      rules: [{ userAgent: "*" }],
      sitemap: ["https://x.com/a.xml", "https://x.com/b.xml"],
      host: "x.com",
    })
    expect(many).toContain("Sitemap: https://x.com/a.xml")
    expect(many).toContain("Sitemap: https://x.com/b.xml")
    expect(many).toContain("Host: x.com")
  })

  test("flattens newlines so a value can't inject a forged directive", () => {
    const txt = robots({ rules: [{ userAgent: "*", disallow: ["/a\nDisallow: /secret"] }] })
    const disallowLines = txt.split("\n").filter((l) => l.startsWith("Disallow:"))
    expect(disallowLines).toEqual(["Disallow: /a Disallow: /secret"]) // one line, injection neutralized
  })

  test("rejects out-of-spec input", () => {
    expect(() => robots({ rules: [{ userAgent: [] }] })).toThrow(/at least one userAgent/)
    expect(() => robots({ rules: [{ userAgent: "*", crawlDelay: -1 }] })).toThrow(/crawlDelay/)
  })
})

describe("wired to a live nifra app", () => {
  let running: RunningServer | undefined
  afterEach(() => {
    running?.stop(true)
    running = undefined
  })

  test("/sitemap.xml and /robots.txt serve over HTTP with the right content-types", async () => {
    running = server()
      .get(
        "/sitemap.xml",
        () =>
          new Response(sitemap([{ url: "/" }], { hostname: "https://x.com" }), {
            headers: { "content-type": "application/xml; charset=utf-8" },
          }),
      )
      .get(
        "/robots.txt",
        () =>
          new Response(robots({ rules: [{ userAgent: "*", disallow: ["/admin"] }] }), {
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      )
      .listen(0)
    const base = `http://127.0.0.1:${running.port}`
    const sm = await fetch(`${base}/sitemap.xml`)
    expect(sm.headers.get("content-type")).toContain("application/xml")
    expect(await sm.text()).toContain("<loc>https://x.com/</loc>")
    const rb = await fetch(`${base}/robots.txt`)
    expect(rb.headers.get("content-type")).toContain("text/plain")
    expect(await rb.text()).toContain("Disallow: /admin")
  })
})
