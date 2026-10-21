import { afterEach, describe, expect, test } from "bun:test"
import { cdnCheckSpec, runCdnCheck } from "../src/cdn-check.ts"

const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** A fake CDN edge: `respond` sees how many page requests came before and whether it is a data or
 * swap one, which a correct edge never answers from cache. */
function edge(respond: (n: number, data: boolean, req: Request) => Response): string {
  let n = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      respond(n++, req.headers.has("x-nifra-data") || req.headers.has("x-nifra-swap"), req),
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}/p/1`
}

const html = (headers: Record<string, string>) =>
  new Response("<p>x</p>", { headers: { "content-type": "text/html", ...headers } })
const codes = (out: Awaited<ReturnType<typeof runCdnCheck>>) => out.findings.map((f) => f.code)

describe("nifra cdn-check", () => {
  test("a Cloudflare page cached on the second hit, data bypassing, passes clean", async () => {
    const url = edge((n, data) =>
      data
        ? Response.json(
            {},
            { headers: { "cf-cache-status": "BYPASS", "cache-control": "private, no-store" } },
          )
        : html({
            "cf-cache-status": n === 0 ? "MISS" : "HIT",
            age: n === 0 ? "0" : "3",
            "cache-control": "public, max-age=0, must-revalidate",
          }),
    )
    const out = await runCdnCheck({ url })
    expect(out.cdn).toBe("cloudflare")
    expect(out.findings).toEqual([])
    expect(out.requests.map((r) => r.cache)).toEqual(["MISS", "HIT", "BYPASS", "BYPASS"])
    expect(cdnCheckSpec.exitCode?.(out, { url })).toBe(0)
  })

  test("Cloudflare serving the cached document to a soft navigation fails, with the rule to add", async () => {
    const url = edge(() => html({ "cf-cache-status": "HIT" }))
    const out = await runCdnCheck({ url })
    const finding = out.findings.find((f) => f.code === "data-served-from-cache")
    expect(finding?.level).toBe("fail")
    expect(finding?.message).toContain(
      "bypasses the cache when the request has an x-nifra-data header",
    )
    expect(cdnCheckSpec.exitCode?.(out, { url })).toBe(1)
  })

  test("a rule that bypasses data requests but not slot swaps fails, naming the swap header", async () => {
    const url = edge((n, _bypassed, req) =>
      req.headers.has("x-nifra-data")
        ? Response.json({}, { headers: { "cf-cache-status": "BYPASS" } })
        : html({ "cf-cache-status": n === 0 ? "MISS" : "HIT" }),
    )
    const out = await runCdnCheck({ url })
    expect(codes(out)).toEqual(["swap-served-from-cache"])
    expect(out.requests.map((r) => `${r.kind} ${r.cache}`)).toEqual([
      "first MISS",
      "second HIT",
      "data BYPASS",
      "swap HIT",
    ])
    expect(out.findings[0]?.message).toContain("x-nifra-swap header too")
    expect(cdnCheckSpec.exitCode?.(out, { url })).toBe(1)
  })

  test("HTML Cloudflare never caches points at the Cache Rule", async () => {
    const url = edge((_n, data) =>
      data ? Response.json({}) : html({ "cf-cache-status": "DYNAMIC" }),
    )
    const out = await runCdnCheck({ url })
    expect(codes(out)).toEqual(["not-cached"])
    expect(out.findings[0]?.message).toContain("Cache Rule")
  })

  test("internal headers and unconsumed CDN headers reaching the visitor are reported", async () => {
    const url = edge((_n, data) =>
      data
        ? Response.json({})
        : html({
            "x-vercel-cache": "HIT",
            "x-nifra-isr-tags": "catalog",
            "vercel-cache-tag": "catalog",
            "cache-control": "public, max-age=600",
          }),
    )
    const out = await runCdnCheck({ url })
    expect(out.cdn).toBe("vercel")
    expect(codes(out)).toEqual(["internal-headers", "cdn-headers-visible", "browser-holds-html"])
    expect(out.findings[0]?.level).toBe("fail")
  })

  test("no CDN in front is a warning; a redirect stops the check", async () => {
    const plain = await runCdnCheck({
      url: edge((_n, data) => (data ? Response.json({}) : html({}))),
    })
    expect(codes(plain)).toEqual(["no-cdn"])
    const moved = await runCdnCheck({
      url: edge(() => new Response(null, { status: 301, headers: { location: "/elsewhere" } })),
    })
    expect(codes(moved)).toEqual(["redirect"])
    expect(moved.requests).toHaveLength(1)
  })

  test("the input must be an http(s) URL without credentials", () => {
    const parse = cdnCheckSpec.input.parse
    expect(() => parse({})).toThrow(/needs a page URL/)
    expect(() => parse({ url: "file:///etc/passwd" })).toThrow(/http or https/)
    expect(() => parse({ url: "https://u:p@example.com/" })).toThrow(/credentials/)
    expect(parse({ url: "https://example.com" })).toEqual({ url: "https://example.com/" })
    expect(cdnCheckSpec.transports).toEqual(["cli"])
  })
})
