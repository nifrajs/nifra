import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { Glob } from "bun"

/**
 * Every published package must contribute at least one signature to `types.json`.
 *
 * That file is the corpus the `nifra_types` MCP tool answers from, and three published packages -
 * `@nifrajs/deno`, `@nifrajs/content` and `@nifrajs/workers` - were absent from it entirely. They ship
 * `files: ["src"]` and point `types` at `./src/index.ts` (correct for a Deno/workerd/Bun-resolved
 * package), while the index only ever looked for a built `dist/*.d.ts`.
 *
 * The `--check` gate could not see it. It compares the regenerated file against the committed one, so
 * a package missing from BOTH matches forever. Staleness was gated because it hands an agent a
 * signature the code no longer has; this is the same failure with a worse ending, since an agent given
 * nothing for a package it was told exists writes an API that never existed.
 *
 * `gen:llms` now fails on an untyped package too. This is the cheap half: it grades the COMMITTED
 * artifact in the normal test run, with no build and no regeneration.
 */

const ROOT = resolve(import.meta.dir, "..")

interface TypeEntry {
  readonly name: string
  readonly kind: string
  readonly package: string
  readonly signature: string
}

const types = JSON.parse(
  await Bun.file(`${ROOT}/packages/cli/docs/types.json`).text(),
) as TypeEntry[]

/**
 * Published packages that declare a code entry. A manifest with no `exports`/`main`/`bin`/`types`
 * ships data rather than an API - `@nifrajs/skills` is markdown - so it has no signature to
 * contribute, and counting it as missing would read as the build-was-skipped failure above. Same
 * exemption `gen:llms` applies when it generates the file this grades.
 */
const publishedPackages = async (): Promise<string[]> => {
  const names: string[] = []
  for await (const file of new Glob("packages/*/package.json").scan(ROOT)) {
    const manifest = JSON.parse(await Bun.file(`${ROOT}/${file}`).text()) as {
      name?: string
      private?: boolean
      exports?: unknown
      main?: unknown
      bin?: unknown
      types?: unknown
    }
    if (manifest.private === true || manifest.name === undefined) continue
    const code =
      manifest.exports !== undefined ||
      manifest.main !== undefined ||
      manifest.bin !== undefined ||
      manifest.types !== undefined
    if (!code) continue
    names.push(manifest.name)
  }
  return names.sort()
}

test("every published package contributes types", async () => {
  const indexed = new Set(types.map((entry) => entry.package))
  const missing = (await publishedPackages()).filter((name) => !indexed.has(name))
  expect(missing).toEqual([])
})

test("the packages that publish TypeScript source are indexed like the ones that build", () => {
  // Named rather than derived: these three are the reason this file exists, and deriving "which
  // packages have no dist" from the tree would make the test pass again the moment one is dropped.
  for (const name of ["@nifrajs/deno", "@nifrajs/content", "@nifrajs/workers"]) {
    expect(types.filter((entry) => entry.package === name).length).toBeGreaterThan(0)
  }
})

test("signatures are declarations, not implementations", () => {
  // Indexing source could have meant pasting function bodies in where a `.d.ts` would have given a
  // clean signature. Emitting declarations first is what avoids that, and this is what says so: a
  // function entry carries `declare` and stops at the return type.
  const functions = types.filter((entry) => entry.kind === "function")
  expect(functions.length).toBeGreaterThan(50)
  const withBodies = functions.filter((entry) => !/^export declare function/.test(entry.signature))
  expect(withBodies.map((entry) => `${entry.package}#${entry.name}`)).toEqual([])
})
