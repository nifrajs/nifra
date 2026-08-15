import { type BakedCollection, indexCollection } from "../packages/content/src/index.ts"

type BenchFrontmatter = { id: string; score: number; section: "news" | "sports" }
const count = 10_000
const entries = Array.from({ length: count }, (_, index) => ({
  slug: `entry-${index}`,
  frontmatter: {
    id: String(index),
    score: count - index,
    section: index % 2 === 0 ? ("news" as const) : ("sports" as const),
  },
  html: "",
  body: "",
})) satisfies BakedCollection<BenchFrontmatter>["entries"]

const started = performance.now()
const index = indexCollection<BenchFrontmatter, "section">(
  { entries },
  { by: "section", sort: { field: "score", dir: "desc" } },
)
const builtMs = performance.now() - started

const queryStarted = performance.now()
let rows = 0
for (let page = index.query({ where: { section: "news" }, limit: 100 }); page.items.length > 0; ) {
  rows += page.items.length
  if (page.nextCursor === undefined) break
  page = index.query({ where: { section: "news" }, limit: 100, cursor: page.nextCursor })
}
const queryMs = performance.now() - queryStarted

console.log(
  JSON.stringify({
    entries: count,
    indexedRows: index.all().length,
    queriedRows: rows,
    builtMs,
    queryMs,
  }),
)
