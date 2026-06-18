import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "bun"

// The reason this package exists is the number this test pins. Bundling the bare index measures
// nothing (tree-shaking removes unused exports) — so the fixture is a realistic island module
// exercising EVERY feature: signals, computed, batch, all six bindings via mount, state seeding.
test("full-feature island bundle stays within the island budget (≤ 2 KB gz)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "islets-size-"))
  const entry = join(dir, "entry.ts")
  writeFileSync(
    entry,
    `
import { batch, computed, effect, island, islandState, mountIslands, signal } from ${JSON.stringify(
      new URL("../src/index.ts", import.meta.url).pathname,
    )}
island("compare", ({ state, root }) => {
  const count = state("count", 0)
  const open = state("open", false)
  const query = state("query", "")
  const label = computed(() => \`\${count()} selected\`)
  effect(() => console.log(label(), root))
  return {
    add: () => batch(() => { count.set((n) => (n as number) + 1); open.set(true) }),
    toggle: () => open.set((v) => !v),
    search: () => query.set(String(query())),
  }
})
console.log(islandState({ seeded: signal(1)() }))
mountIslands()
`,
  )
  try {
    const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: true })
    expect(built.success).toBe(true)
    let src = ""
    for (const o of built.outputs) src += await o.text()
    const gz = gzipSync(Buffer.from(src)).length
    console.log(
      `@nifrajs/islets full-feature island: ${(src.length / 1024).toFixed(2)} KB min, ${(gz / 1024).toFixed(2)} KB gz`,
    )
    expect(gz).toBeLessThanOrEqual(2048)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
