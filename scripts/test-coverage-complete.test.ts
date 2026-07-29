import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { Glob } from "bun"

/**
 * Every package's tests must actually run in CI.
 *
 * `@nifrajs/events` shipped with 17 passing tests that CI had never executed - not because anything
 * broke, but because the two run scripts list their 30-odd test directories by hand and nobody added
 * the new one. The tests passed locally, the package published, and the gate reported success having
 * never opened the file. The dead suite was the fail-closed half of a durable event boundary: parsing
 * arbitrary `unknown` envelopes and rejecting unknown contracts.
 *
 * A hand-maintained list is fine; a hand-maintained list with nothing checking it is how a package
 * goes a release without being tested. This is the check.
 *
 * (Worth recording, because it was claimed and is false: `bun test <nonexistent path>` exits 1 on Bun
 * 1.3.14, so a RENAMED directory does fail CI loudly. Only a never-added one slips through, which is
 * exactly what this covers.)
 */

const ROOT = resolve(import.meta.dir, "..")
const scripts = (
  JSON.parse(await Bun.file(`${ROOT}/package.json`).text()) as {
    scripts: Record<string, string>
  }
).scripts

/**
 * Directories deliberately outside a script, each with the reason. An entry here is a decision someone
 * can argue with; an omission from the scripts is one nobody ever sees.
 */
const EXEMPT: Readonly<Record<string, { readonly test?: string; readonly coverage?: string }>> = {
  // Deno's suite cannot run under `bun test` - it is driven by the separate `deno` CI job
  // (`bun run test:deno`, which ci.yml runs as its own matrix entry).
  "packages/deno/test": { test: "run by the deno CI job", coverage: "run by the deno CI job" },
  // These run in the `test` script's second `bun test` invocation, which is deliberately outside the
  // coverage run: they spawn MCP servers over stdio, and Bun's coverage instrumentation of a spawned
  // child is not what the ratchet's per-file baseline is measuring.
  "packages/mcp/test": {
    coverage: "spawns stdio servers; measured by behaviour, not line coverage",
  },
  "packages/mcp-db/test": { coverage: "spawns stdio servers; see packages/mcp/test" },
}

async function testDirs(): Promise<string[]> {
  const dirs = new Set<string>()
  for await (const rel of new Glob("packages/*/test/**/*.test.{ts,tsx}").scan({ cwd: ROOT })) {
    dirs.add(rel.split("/").slice(0, 3).join("/"))
  }
  return [...dirs].sort()
}

test("every package with tests is listed in the `test` script", async () => {
  const missing = (await testDirs()).filter(
    (dir) => !scripts.test.includes(dir) && EXEMPT[dir]?.test === undefined,
  )
  expect(missing).toEqual([])
})

test("every package with tests is listed in the `test:coverage` script", async () => {
  // Coverage is what the ratchet grades. A suite absent here can regress to zero unnoticed.
  const missing = (await testDirs()).filter(
    (dir) => !scripts["test:coverage"].includes(dir) && EXEMPT[dir]?.coverage === undefined,
  )
  expect(missing).toEqual([])
})

test("no exemption outlives the directory it excuses", async () => {
  // A stale exemption silently re-opens the hole for a path that came back under a different shape.
  const dirs = new Set(await testDirs())
  expect([...Object.keys(EXEMPT)].filter((dir) => !dirs.has(dir))).toEqual([])
})
