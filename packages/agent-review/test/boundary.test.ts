import { describe, expect, test } from "bun:test"

const packageRoot = new URL("..", import.meta.url)

describe("agent-review package boundary", () => {
  test("is a dependency-free public leaf", async () => {
    const manifest = (await Bun.file(new URL("package.json", packageRoot)).json()) as Record<
      string,
      unknown
    >
    expect(manifest.dependencies ?? {}).toEqual({})
    expect(manifest.peerDependencies ?? {}).toEqual({})
    expect(manifest.sideEffects).toBe(false)
    expect(manifest.publishConfig).toEqual({ access: "public" })
  })

  test("source has no framework, runtime, provider, or filesystem imports", async () => {
    const sourceFiles = ["canonical.ts", "compose.ts", "index.ts", "parser.ts", "types.ts"]
    const forbidden = /(?:node:|@nifrajs\/|from\s+["'](?:fs|path|crypto)|process\.|Bun\.)/
    for (const file of sourceFiles) {
      const source = await Bun.file(new URL(`src/${file}`, packageRoot)).text()
      expect(source).not.toMatch(forbidden)
    }
  })
})
