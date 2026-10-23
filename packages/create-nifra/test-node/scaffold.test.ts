/**
 * The library scaffold on Node: `create-nifra/scaffold` from the built package writes the starter, and
 * `--link`'s check for each local package runs through `node:fs` rather than a Bun global.
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { scaffold } from "create-nifra/scaffold"

const repo = join(import.meta.dirname, "../../..")

test("scaffold writes the api starter and links local packages on Node", async () => {
  const parent = await mkdtemp(join(tmpdir(), "create-nifra-node-"))
  try {
    const target = join(parent, "my-api")
    const result = await scaffold({ target, link: repo })
    assert.equal(result.name, "my-api")
    assert.equal(result.template, "api")
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"))
    assert.equal(pkg.name, "my-api")
    assert.match(pkg.dependencies["@nifrajs/core"], /^file:.*packages\/core$/)
    const routes = await readFile(join(target, "backend/routes.ts"), "utf8")
    assert.ok(routes.includes('from "@nifrajs/core/server"'))
    await readFile(join(target, ".gitignore"), "utf8")
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
