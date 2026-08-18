import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { loadDocsCorpus, searchSections, splitSections } from "../src/docs-search.ts"
import { loadTypesCorpus, searchTypes } from "../src/types-search.ts"

interface GoldenCase {
  readonly query: string
  readonly kind: "docs" | "types"
  readonly accept: readonly string[]
  readonly within?: number
}

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/retrieval-golden.json", import.meta.url), "utf8"),
) as readonly GoldenCase[]

describe("retrieval golden set", () => {
  test("bundled corpora are present before relevance assertions run", async () => {
    const [docs, types] = await Promise.all([loadDocsCorpus(), loadTypesCorpus()])
    expect(docs?.length ?? 0).toBeGreaterThan(10_000)
    expect(types?.length ?? 0).toBeGreaterThan(100)
  })

  test("real agent queries keep an accepted result in the top N", async () => {
    const [docs, types] = await Promise.all([loadDocsCorpus(), loadTypesCorpus()])
    if (docs === undefined || types === undefined)
      throw new Error("retrieval corpora are unavailable")

    const failures: string[] = []
    for (const entry of golden) {
      const limit = entry.within ?? 3
      const ranked =
        entry.kind === "docs"
          ? searchSections(splitSections(docs), entry.query, limit).map((hit) => hit.heading)
          : searchTypes(types, entry.query, limit).map((hit) => hit.name)
      if (!ranked.some((id) => entry.accept.includes(id))) {
        failures.push(
          `${entry.kind} ${JSON.stringify(entry.query)} expected one of ${entry.accept.join(", ")} ` +
            `in top ${limit}; got ${ranked.slice(0, 5).join(" | ") || "(no results)"}`,
        )
      }
    }
    if (failures.length > 0) throw new Error(failures.join("\n"))
    expect(golden.length).toBeGreaterThanOrEqual(25)
  })
})
