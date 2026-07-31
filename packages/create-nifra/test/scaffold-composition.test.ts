import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { FRAMEWORK_SPECS, NIFRA_DEP_RANGE } from "../src/scaffold/frameworks.ts"
import { generatedSiteFiles, materializeSite, SITE_BASE_DIR } from "../src/scaffold/site.ts"

/**
 * Composing a site must produce the directory that used to be checked in.
 *
 * The per-file generators are covered next door; this covers the thing that actually ships - the whole
 * tree. It is the test that licenses deleting the four redundant template directories, so it checks
 * the two properties deletion would put at risk: every file a user used to get is still there, and
 * every file NOT emitted from the model is byte-identical to the one it replaces.
 */

const scratch: string[] = []
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

const templateDir = (id: string): string =>
  id === "react" ? SITE_BASE_DIR : join(SITE_BASE_DIR, "..", `template-site-${id}`)

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

describe("a composed site matches the template it replaces", () => {
  for (const id of Object.keys(FRAMEWORK_SPECS)) {
    test(`${id} - same set of files`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `nifra-site-${id}-`))
      scratch.push(dir)
      await materializeSite(dir, id)
      expect(await treeOf(dir)).toEqual(await treeOf(templateDir(id)))
    })

    test(`${id} - every non-generated file is byte-identical`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `nifra-same-${id}-`))
      scratch.push(dir)
      await materializeSite(dir, id)
      const generated = new Set(generatedSiteFiles(FRAMEWORK_SPECS[id] as never).keys())

      const differing: string[] = []
      for (const file of await treeOf(dir)) {
        if (generated.has(file)) continue // covered byte-for-byte by the parity suite
        const [composed, committed] = await Promise.all([
          readFile(join(dir, file), "utf8"),
          readFile(join(templateDir(id), file), "utf8"),
        ])
        if (composed !== committed) differing.push(file)
      }
      expect(differing).toEqual([])
    })
  }
})

/**
 * A scaffolded app must install the release it was scaffolded by.
 *
 * The release script used to regex-sweep `@nifrajs/*` pins across eight `package.json` files with
 * nothing verifying the result, and its own comment warns that a missed bump ships templates that
 * install the PREVIOUS release. One constant, and this test, is what turns that into a red build.
 */
test("the scaffold's Nifra range matches the version being published", async () => {
  const core = JSON.parse(
    await readFile(join(SITE_BASE_DIR, "..", "..", "core", "package.json"), "utf8"),
  ) as { version: string }
  expect(NIFRA_DEP_RANGE).toBe(`^${core.version}`)
})
