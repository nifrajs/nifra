import { describe, expect, test } from "bun:test"
import {
  aggregateSizeReport,
  diffManifestRoutes,
  formatBytes,
  isManifestInSync,
  parseManifestRouteFiles,
} from "../src/build-plan.ts"

describe("build-plan contract", () => {
  test("stays independent of a concrete bundler", async () => {
    const source = await Bun.file(new URL("../src/build-plan.ts", import.meta.url)).text()
    expect(source).not.toMatch(/from ["']bun["']/)
    expect(source).not.toMatch(/Bun\./)
  })

  test("keeps manifest drift comparison pure and sorted", () => {
    const drift = diffManifestRoutes(
      ["routes/z.tsx", "routes/old.tsx"],
      ["routes/a.tsx", "routes/z.tsx"],
    )
    expect(drift).toEqual({ missing: ["routes/a.tsx"], extra: ["routes/old.tsx"] })
    expect(isManifestInSync(drift)).toBe(false)
  })

  test("parses route identities from eager and lazy manifests", () => {
    const source = [
      "const loaders: Record<string, unknown> = {",
      '  "routes/b.tsx": () => import("./routes/b"),',
      "}",
      "const modules = {",
      '  "routes/a.tsx": m0,',
      "}",
    ].join("\n")
    expect(parseManifestRouteFiles(source)).toEqual(["routes/a.tsx", "routes/b.tsx"])
  })

  test("aggregates and formats artifact sizes deterministically", () => {
    const report = aggregateSizeReport([
      { name: "small.js", bytes: 512, gzip: 100 },
      { name: "large.js", bytes: 2048, gzip: 400 },
    ])
    expect(report.totalBytes).toBe(2560)
    expect(report.totalGzip).toBe(500)
    expect(report.chunks[0]?.name).toBe("large.js")
    expect(formatBytes(1536)).toBe("1.5 KB")
  })
})
