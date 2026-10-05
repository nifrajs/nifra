import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { staleRouteTypes } from "@nifrajs/web/route-types"
import { scaffold } from "../src/cli.ts"
import { materializeAll } from "./_scaffold-fixtures.ts"

// The scaffold writes `.nifra/types` itself so the starter's `./+types` imports resolve before any nifra
// command has run. That text is a copy of the generator's output, so this is what keeps it one: the
// generator, run over each fresh scaffold, must find nothing to write and nothing to remove.

const { scaffolds, cleanup } = await materializeAll()
const root = await mkdtemp(join(tmpdir(), "nifra-route-types-"))
afterAll(async () => {
  await cleanup()
  await rm(root, { recursive: true, force: true })
})

for (const { label, dir } of scaffolds.filter((s) => s.label.startsWith("site-"))) {
  test(`${label}: the scaffolded route types are what nifra generates`, () => {
    expect(staleRouteTypes({ appRoot: dir }).map((path) => relative(dir, path))).toEqual([])
  })
}

test("isr: the scaffolded route types are what nifra generates", async () => {
  const dir = join(root, "isr")
  await scaffold({ target: dir, template: "isr" })
  expect(staleRouteTypes({ appRoot: dir }).map((path) => relative(dir, path))).toEqual([])
})
