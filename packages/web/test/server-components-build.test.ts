import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildServerComponents } from "../src/server-components/build.ts"

test("one generation covers imported files outside the root and failed builds preserve prior output", async () => {
  const base = resolve(import.meta.dirname, "../../../.nifra-components-fixtures")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(resolve(base, "proof-"))
  const root = resolve(directory, "app")
  await writeFile(
    resolve(directory, "package.json"),
    '{"name":"component-proof-shared","type":"module","nifra":{"environment":"shared"}}',
  )
  await mkdir(root)
  await writeFile(resolve(directory, "value.shared.ts"), 'export const value = "public-v1"')
  await writeFile(
    resolve(root, "entry.frontend.ts"),
    'import { value } from "../value.shared"; document.body.textContent = value',
  )
  await writeFile(
    resolve(root, "entry.backend.ts"),
    'import { value } from "../value.shared"; export function createApp() { return { fetch: () => new Response(value) } }',
  )
  const options = {
    root,
    adapter: "vue" as const,
    target: "node" as const,
    outDir: "output",
    entries: { client: "entry.frontend.ts", ssr: "entry.backend.ts" },
  }
  try {
    const first = await buildServerComponents(options)
    const repeat = await buildServerComponents(options)
    expect(repeat.build).toBe(first.build)
    await writeFile(resolve(directory, "value.shared.ts"), 'export const value = "public-v2"')
    const changed = await buildServerComponents(options)
    expect(changed.build).not.toBe(first.build)
    const before = await readFile(resolve(changed.outDir, "component-build.json"), "utf8")
    await writeFile(
      resolve(root, "entry.frontend.ts"),
      'import "node:fs"; document.body.textContent = "unsafe"',
    )
    await expect(buildServerComponents(options)).rejects.toThrow()
    expect(await readFile(resolve(changed.outDir, "component-build.json"), "utf8")).toBe(before)
    const manifest = JSON.parse(
      await readFile(resolve(changed.outDir, "component-manifest.json"), "utf8"),
    )
    expect(Object.keys(manifest.files).some((file) => file.startsWith("assets/"))).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
