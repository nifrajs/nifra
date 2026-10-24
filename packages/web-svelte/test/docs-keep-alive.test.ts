import { afterEach, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compile } from "svelte/compiler"
import { render } from "svelte/server"

// The keep-alive guide's Svelte example, as the site shows it.
const sample = (): string => {
  const page = readFileSync(
    join(import.meta.dir, "../../../site/routes/docs/keep-alive.tsx"),
    "utf8",
  )
  const found = /const SVELTE = `([\s\S]*?)`/.exec(page)?.[1]
  if (found === undefined) throw new Error("[test] the keep-alive guide has no SVELTE sample")
  return found
}

let interval: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  interval?.mockRestore()
  interval = undefined
})

test("the keep-alive guide's Svelte polling example starts no timer on the server", async () => {
  const { code } = compile(sample(), { generate: "server", filename: "Polling.svelte" }).js
  // The compiled module's imports, resolved from here, so it loads from a scratch directory.
  const resolved = code.replace(
    /from (["'])([^"']+)\1/g,
    (_, _quote: string, specifier: string) =>
      `from ${JSON.stringify(import.meta.resolve(specifier))}`,
  )
  const dir = await mkdtemp(join(tmpdir(), "nifra-docs-svelte-"))
  try {
    const file = join(dir, "Polling.js")
    await writeFile(file, resolved)
    const Polling = (await import(file)).default
    interval = spyOn(globalThis, "setInterval")
    for (let request = 0; request < 2; request++) void render(Polling).body
    expect(interval).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
