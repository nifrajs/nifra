import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { imageBunPlugin } from "../src/plugins.ts"

type Load = (args: { path: string }) => Promise<{ contents: string }>

let root: string
let saved: Record<"NIFRA_DEV_HMR" | "NIFRA_DEV_ROOT", string | undefined>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nifra-image-publish-"))
  saved = { NIFRA_DEV_HMR: process.env.NIFRA_DEV_HMR, NIFRA_DEV_ROOT: process.env.NIFRA_DEV_ROOT }
  process.env.NIFRA_DEV_HMR = "1"
  process.env.NIFRA_DEV_ROOT = root
})
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

/** A PNG signature + IHDR is all the codec-free metadata read needs; `seed` makes the bytes unique. */
const png = (seed: number): Uint8Array => {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, 8)
  new DataView(bytes.buffer).setUint32(20, 4)
  bytes[40] = seed
  return bytes
}

/** The first cached file name, narrowed without an assertion. */
function firstCached(directory: string): string {
  const [name] = readdirSync(directory)
  if (name === undefined) throw new Error("no asset was published")
  return name
}

function install(): { setup: () => void; load: Load } {
  const plugin = imageBunPlugin({ root })
  let load: Load | undefined
  const setup = (): void =>
    plugin.setup({
      onResolve() {},
      onLoad(_options, handler) {
        load = handler
      },
    })
  setup()
  return {
    setup,
    load: (args) => {
      if (load === undefined) throw new Error("onLoad was not registered")
      return load(args)
    },
  }
}

test("dev publishing verifies an asset once per build, not again on every later import", async () => {
  writeFileSync(join(root, "a.png"), png(1))
  writeFileSync(join(root, "b.png"), png(2))
  const { load } = install()
  await load({ path: join(root, "a.png?image") })
  const directory = join(root, ".nifra/image-assets/_images")
  // A published asset was verified against its content hash when it was written. Damage afterwards
  // must not make an unrelated import re-read it (that made N imports cost N^2 file reads).
  truncateSync(join(directory, firstCached(directory)), 3)
  await load({ path: join(root, "b.png?image") })
  expect(readdirSync(directory)).toHaveLength(2)
})

test("a new build re-verifies the cache, so a damaged file is still refused", async () => {
  writeFileSync(join(root, "a.png"), png(1))
  const { setup, load } = install()
  await load({ path: join(root, "a.png?image") })
  const directory = join(root, ".nifra/image-assets/_images")
  truncateSync(join(directory, firstCached(directory)), 3)
  setup()
  await expect(load({ path: join(root, "a.png?image") })).rejects.toThrow(
    /invalid cached image asset/,
  )
})
