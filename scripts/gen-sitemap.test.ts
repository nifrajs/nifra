import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sitemapProblems } from "./gen-sitemap.ts"

const SITE = "https://nifra.dev"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(pages: readonly string[], listed: readonly string[], feed: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "sitemap-"))
  roots.push(root)
  mkdirSync(join(root, "site", "routes"), { recursive: true })
  mkdirSync(join(root, "site", "public"), { recursive: true })
  for (const page of pages) writeFileSync(join(root, "site", "routes", page), "export default 1\n")
  const urls = listed.map((url) => `<url><loc>${SITE}${url}</loc></url>`).join("")
  writeFileSync(join(root, "site", "public", "sitemap.xml"), `<urlset>${urls}</urlset>`)
  const items = feed.map((slug) => `<link>${SITE}/blog/${slug}</link>`).join("")
  writeFileSync(join(root, "site", "public", "rss.xml"), `<rss>${items}</rss>`)
  return root
}

test("control: a sitemap and feed that match the routes and posts pass", () => {
  const root = fixture(["index.tsx", "about.tsx", "_layout.tsx"], ["/", "/about"], ["hello"])
  expect(sitemapProblems(root, [{ slug: "hello" }])).toEqual([])
})

test("a missing route, a dead URL, and a missing post are all reported", () => {
  const root = fixture(["index.tsx", "about.tsx"], ["/", "/gone"], [])
  expect(sitemapProblems(root, [{ slug: "hello" }])).toEqual([
    `missing from sitemap.xml: ${SITE}/about`,
    `sitemap.xml lists a route that no longer exists: ${SITE}/gone`,
    "missing from rss.xml: hello",
  ])
})

test("a routes tree with no page fails instead of agreeing with an empty sitemap", () => {
  const root = fixture([], [], [])
  expect(sitemapProblems(root, [])).toEqual([
    `${root}/site/routes has no page - nothing was checked`,
  ])
})
