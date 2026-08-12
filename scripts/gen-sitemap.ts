/**
 * Generate the site's crawler surface from the route tree: `site/public/sitemap.xml` and
 * `site/public/rss.xml`.
 *
 *   bun run scripts/gen-sitemap.ts           # rewrite both files
 *   bun run scripts/gen-sitemap.ts --check   # fail if the sitemap's URL set has drifted
 *
 * Why generate rather than hand-maintain: the sitemap is the one file nothing breaks when it goes
 * stale, so it silently rots - a new page ships uncrawled, a removed page keeps 404ing at Google for
 * months. Deriving it from `site/routes/**` makes "the route exists" and "the URL is listed" the
 * same fact.
 *
 * `<lastmod>` is each route file's last commit date, read from git. That is the only honest source:
 * a constant would be a lie the moment one page changes, and crawlers demote a sitemap whose dates
 * they can prove wrong. `--check` deliberately compares only the URL SET, never the dates: CI checks
 * out shallow, where per-file history does not exist, and a date check there would fail on a correct
 * file. Regenerate locally (full history) and commit the result.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { POSTS } from "../site/data/posts"

const SITE = "https://nifra.dev"
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const ROUTES = `${ROOT}/site/routes`
const SITEMAP = `${ROOT}/site/public/sitemap.xml`
const RSS = `${ROOT}/site/public/rss.xml`

/** Route files that render a page for a crawler. Excluded: `_`-prefixed framework files (layouts,
 * `_404`), dynamic segments (no fixed URL to list), and anything that is not a route module. */
function isPageFile(name: string): boolean {
  if (name.startsWith("_") || name.includes("[")) return false
  return name.endsWith(".tsx") || name.endsWith(".mdx")
}

interface Route {
  /** Site-root-relative URL, e.g. `/blog/bun-vs-node` (the home page is `/`). */
  readonly url: string
  /** Repo-relative path of the route file, for the git lastmod lookup. */
  readonly file: string
}

function collect(dir: string, prefix: string, out: Route[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_") || entry.name.startsWith("[")) continue
      collect(`${dir}/${entry.name}`, `${prefix}/${entry.name}`, out)
      continue
    }
    if (!isPageFile(entry.name)) continue
    const base = entry.name.replace(/\.(tsx|mdx)$/, "")
    const url = base === "index" ? (prefix === "" ? "/" : prefix) : `${prefix}/${base}`
    out.push({ url, file: `${dir}/${entry.name}`.slice(ROOT.length + 1) })
  }
}

/** Last commit date (`YYYY-MM-DD`) for a path. Empty when history is unavailable (a shallow clone,
 * or a route file that is not committed yet) - callers fall back rather than emit a wrong date. */
function lastCommitDate(file: string): string {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", file], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim()
  } catch {
    return ""
  }
}

/** Route files with uncommitted edits. Their last commit date describes the OLD content, so they get
 * today instead - otherwise every regeneration ships a sitemap one commit behind the pages in it. */
function dirtyFiles(): ReadonlySet<string> {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", "site/routes"], {
      cwd: ROOT,
      encoding: "utf8",
    })
    return new Set(
      out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.slice(3).trim()),
    )
  } catch {
    return new Set()
  }
}

function repoTipDate(): string {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim()
  } catch {
    return ""
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** RFC 822 date for an RSS `<pubDate>`, at midnight UTC. RSS readers reject the bare ISO date, so
 * the feed carries this form while every other surface keeps ISO. */
function rfc822(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString()
}

function buildSitemap(routes: readonly Route[], tip: string): string {
  const dirty = dirtyFiles()
  const today = new Date().toISOString().slice(0, 10)
  const lines = routes.map((route) => {
    const post = POSTS.find((entry) => `/blog/${entry.slug}` === route.url)
    const git = dirty.has(route.file) ? today : lastCommitDate(route.file)
    // A post's publication date is a floor: a page cannot have been modified before it existed, and
    // in a shallow clone git gives the checkout date rather than the file's own.
    const lastmod = post !== undefined && git < post.date ? post.date : git || tip
    return `  <url><loc>${SITE}${route.url}</loc><lastmod>${lastmod}</lastmod></url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join("\n")}\n</urlset>\n`
}

function buildRss(): string {
  const items = POSTS.map(
    (post) => `    <item>
      <title>${xmlEscape(post.title)}</title>
      <link>${SITE}/blog/${post.slug}</link>
      <guid isPermaLink="true">${SITE}/blog/${post.slug}</guid>
      <pubDate>${rfc822(post.date)}</pubDate>
      <description>${xmlEscape(post.summary)}</description>
    </item>`,
  ).join("\n")
  // `lastBuildDate` is the newest post rather than the build clock: a feed whose timestamp moves on
  // every deploy tells aggregators to re-poll for content that did not change.
  const newest = POSTS.reduce((max, post) => (post.date > max ? post.date : max), POSTS[0].date)
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Nifra Blog</title>
    <link>${SITE}/blog</link>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Engineering notes from building nifra.</description>
    <language>en</language>
    <lastBuildDate>${rfc822(newest)}</lastBuildDate>
${items}
  </channel>
</rss>
`
}

function urlsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).sort()
}

const routes: Route[] = []
collect(ROUTES, "", routes)
routes.sort((a, b) => (a.url < b.url ? -1 : 1))

const check = process.argv.includes("--check")

if (check) {
  const current = urlsOf(readFileSync(SITEMAP, "utf8"))
  const expected = routes.map((route) => `${SITE}${route.url}`).sort()
  const missing = expected.filter((url) => !current.includes(url))
  const extra = current.filter((url) => !expected.includes(url))
  if (missing.length > 0 || extra.length > 0) {
    for (const url of missing) console.error(`missing from sitemap.xml: ${url}`)
    for (const url of extra)
      console.error(`sitemap.xml lists a route that no longer exists: ${url}`)
    console.error("\nRegenerate: bun run gen:sitemap")
    process.exit(1)
  }
  const feed = readFileSync(RSS, "utf8")
  const stale = POSTS.filter((post) => !feed.includes(`${SITE}/blog/${post.slug}`))
  if (stale.length > 0) {
    for (const post of stale) console.error(`missing from rss.xml: ${post.slug}`)
    console.error("\nRegenerate: bun run gen:sitemap")
    process.exit(1)
  }
  console.log(`sitemap.xml: ${current.length} URLs, in sync with site/routes`)
} else {
  writeFileSync(SITEMAP, buildSitemap(routes, repoTipDate()))
  writeFileSync(RSS, buildRss())
  console.log(`sitemap.xml: ${routes.length} URLs · rss.xml: ${POSTS.length} posts`)
}
