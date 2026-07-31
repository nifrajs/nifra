import { afterAll, expect, test } from "bun:test"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { FRAMEWORK_IDS, FRAMEWORK_SPECS } from "../src/scaffold/frameworks.ts"
import { generatedSiteFiles } from "../src/scaffold/site.ts"
import { materializeAll } from "./_scaffold-fixtures.ts"

/**
 * A committed picture of what every site scaffold emits.
 *
 * While the five template directories existed, the generator was graded against them - the strongest
 * check available, and the one that licensed deleting them. That subject is gone now, so this takes
 * over: the composed file list and every generated file's text, in one reviewable artifact.
 *
 * It is the same idea as the capability lockfile. The snapshot is not the source of truth; the model
 * is. What it buys is that a change to the model arrives as a diff someone reads, rather than as
 * silently different output in the next person's `bun create nifra`.
 *
 * Regenerate with `UPDATE_SCAFFOLD_SNAPSHOT=1 bun test scaffold-snapshot`, then read the diff.
 */

const SNAPSHOT = join(import.meta.dir, "__snapshots__", "site-scaffold.txt")

async function treeOf(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(relative(root, full))
    }
  }
  await walk(root)
  return out.sort()
}

const { scaffolds, cleanup } = await materializeAll()
afterAll(cleanup)

test("every site scaffold matches its committed snapshot", async () => {
  const sections: string[] = []
  for (const id of FRAMEWORK_IDS) {
    const site = scaffolds.find((entry) => entry.label === `site-${id}`)
    if (site === undefined) throw new Error(`site-${id} was not composed`)

    // The full tree, so a file the composer stops writing shows up here rather than in a user's app.
    sections.push(`===== site-${id} :: files\n${(await treeOf(site.dir)).join("\n")}`)
    for (const file of [...generatedSiteFiles(FRAMEWORK_SPECS[id] as never).keys()].sort()) {
      sections.push(`===== site-${id} :: ${file}\n${await readFile(join(site.dir, file), "utf8")}`)
    }
  }
  const current = `${sections.join("\n")}\n`

  if (process.env.UPDATE_SCAFFOLD_SNAPSHOT === "1") {
    await writeFile(SNAPSHOT, current)
    return
  }
  expect(current).toBe(await readFile(SNAPSHOT, "utf8"))
})
