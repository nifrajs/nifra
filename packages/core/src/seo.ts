/**
 * `sitemap.xml` + `robots.txt` builders — pure, edge-safe string generators (no I/O, no runtime deps).
 * Wire them to a route on any runtime:
 *
 *   app.get("/sitemap.xml", () =>
 *     new Response(sitemap([{ url: "/" }, { url: "/about", priority: 0.8 }], { hostname: "https://x.com" }), {
 *       headers: { "content-type": "application/xml; charset=utf-8" },
 *     }))
 *
 *   app.get("/robots.txt", () =>
 *     new Response(robots({ rules: [{ userAgent: "*", disallow: ["/admin"] }], sitemap: "https://x.com/sitemap.xml" }), {
 *       headers: { "content-type": "text/plain; charset=utf-8" },
 *     }))
 */

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
}

/** Escape the five XML metacharacters — `<loc>` and `<lastmod>` carry app- or DB-derived strings. */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] as string)
}

export type SitemapChangeFreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never"

const CHANGE_FREQS: ReadonlySet<string> = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
])

export interface SitemapEntry {
  /** An absolute URL, or a path that `hostname` will make absolute. */
  readonly url: string
  /** Last-modified — a `Date` (serialized as ISO 8601) or a pre-formatted W3C-datetime string. */
  readonly lastmod?: string | Date
  readonly changefreq?: SitemapChangeFreq
  /** Crawl priority, `0.0`–`1.0`. */
  readonly priority?: number
}

export interface SitemapOptions {
  /** Prepended to path-only `url`s (e.g. `"https://example.com"`). Sitemaps require absolute URLs. */
  readonly hostname?: string
}

/** sitemaps.org caps a single sitemap file at 50,000 URLs. Beyond this, split into a sitemap index. */
const SITEMAP_MAX_URLS = 50_000

/** Build a `<urlset>` sitemap XML document from `entries`. Throws on out-of-spec input (dev-time data). */
export function sitemap(entries: readonly SitemapEntry[], options: SitemapOptions = {}): string {
  if (entries.length > SITEMAP_MAX_URLS) {
    throw new RangeError(
      `sitemap: ${entries.length} entries exceeds the ${SITEMAP_MAX_URLS}-URL per-file limit — split into a sitemap index`,
    )
  }
  const base = options.hostname?.replace(/\/+$/, "")
  const urls = entries.map((entry) => {
    const parts = [`<loc>${escapeXml(resolveLoc(entry.url, base))}</loc>`]
    if (entry.lastmod !== undefined) {
      const value = entry.lastmod instanceof Date ? entry.lastmod.toISOString() : entry.lastmod
      parts.push(`<lastmod>${escapeXml(value)}</lastmod>`)
    }
    if (entry.changefreq !== undefined) {
      if (!CHANGE_FREQS.has(entry.changefreq)) {
        throw new RangeError(`sitemap: invalid changefreq "${entry.changefreq}"`)
      }
      parts.push(`<changefreq>${entry.changefreq}</changefreq>`)
    }
    if (entry.priority !== undefined) {
      if (!Number.isFinite(entry.priority) || entry.priority < 0 || entry.priority > 1) {
        throw new RangeError(`sitemap: priority must be between 0.0 and 1.0, got ${entry.priority}`)
      }
      parts.push(`<priority>${entry.priority.toFixed(1)}</priority>`)
    }
    return `  <url>${parts.join("")}</url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
}

function resolveLoc(url: string, base: string | undefined): string {
  if (/^https?:\/\//i.test(url)) return url // already absolute
  if (base === undefined) return url // relative — caller's choice (sitemaps prefer absolute)
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`
}

export interface RobotsRule {
  /** A single user-agent token (`"*"`, `"Googlebot"`, …) or several sharing the same directives. */
  readonly userAgent: string | readonly string[]
  readonly allow?: readonly string[]
  readonly disallow?: readonly string[]
  /** Seconds between requests (honored by some crawlers). */
  readonly crawlDelay?: number
}

export interface RobotsOptions {
  readonly rules: readonly RobotsRule[]
  /** One or more absolute `Sitemap:` URLs. */
  readonly sitemap?: string | readonly string[]
  /** A `Host:` directive (preferred mirror). */
  readonly host?: string
}

/** robots.txt is line-oriented, so a newline in any value could inject a forged directive. Flatten it. */
function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim()
}

/** Build a `robots.txt` body from grouped rules plus optional `Sitemap:`/`Host:` lines. */
export function robots(options: RobotsOptions): string {
  const lines: string[] = []
  for (const rule of options.rules) {
    const agents = typeof rule.userAgent === "string" ? [rule.userAgent] : rule.userAgent
    if (agents.length === 0) {
      throw new RangeError("robots: each rule needs at least one userAgent")
    }
    for (const agent of agents) lines.push(`User-agent: ${sanitizeLine(agent)}`)
    for (const path of rule.allow ?? []) lines.push(`Allow: ${sanitizeLine(path)}`)
    for (const path of rule.disallow ?? []) lines.push(`Disallow: ${sanitizeLine(path)}`)
    if (rule.crawlDelay !== undefined) {
      if (!Number.isFinite(rule.crawlDelay) || rule.crawlDelay < 0) {
        throw new RangeError(
          `robots: crawlDelay must be a non-negative number, got ${rule.crawlDelay}`,
        )
      }
      lines.push(`Crawl-delay: ${rule.crawlDelay}`)
    }
    lines.push("") // blank line between groups
  }
  const sitemaps =
    options.sitemap === undefined
      ? []
      : typeof options.sitemap === "string"
        ? [options.sitemap]
        : options.sitemap
  for (const url of sitemaps) lines.push(`Sitemap: ${sanitizeLine(url)}`)
  if (options.host !== undefined) lines.push(`Host: ${sanitizeLine(options.host)}`)
  return `${lines.join("\n").trim()}\n`
}
