import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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

test("without a target the build compiles for the Bun server it assembles", async () => {
  const base = resolve(import.meta.dirname, "../../../.nifra-components-fixtures")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, "target-"))
  await writeFile(
    resolve(root, "package.json"),
    '{"name":"component-target-proof","type":"module"}',
  )
  await writeFile(resolve(root, "entry.frontend.ts"), 'document.body.textContent = "public"')
  await writeFile(
    resolve(root, "entry.backend.ts"),
    'export function createApp() { return { fetch: async () => { const { Database } = await import("bun:sqlite"); return new Response(String(new Database(":memory:"))) } } }',
  )
  const options = {
    root,
    adapter: "vue" as const,
    outDir: "output",
    entries: { client: "entry.frontend.ts", ssr: "entry.backend.ts" },
  }
  try {
    const result = await buildServerComponents(options)
    expect(result.target).toBe("bun")
    await expect(buildServerComponents({ ...options, target: "node" })).rejects.toThrow(
      /bun:sqlite is unsupported on node/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

async function envFixture(files: Record<string, string>) {
  const base = resolve(import.meta.dirname, "../../../.nifra-components-fixtures")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, "env-"))
  await mkdir(resolve(root, "node_modules/envlib"), { recursive: true })
  const all: Record<string, string> = {
    "package.json": '{"name":"component-env-proof","type":"module"}',
    "node_modules/envlib/package.json": '{"name":"envlib","type":"module","main":"index.js"}',
    "node_modules/envlib/index.js": "export const env = import.meta.env",
    "entry.backend.ts":
      'export function createApp() { return { fetch: () => new Response("ok") } }',
    ...files,
  }
  for (const [name, text] of Object.entries(all)) await writeFile(resolve(root, name), text)
  const build = () =>
    buildServerComponents({
      root,
      adapter: "vue",
      target: "node",
      outDir: "output",
      entries: { client: "entry.frontend.ts", ssr: "entry.backend.ts" },
    })
  return { root, build }
}

test("a dependency reading import.meta.env gets only the public values from the app's .env files", async () => {
  const { root, build } = await envFixture({
    ".env.production":
      "VITE_DB_PASSWORD=pg-prod-pass-7f3k2xQ9wLm4\nPUBLIC_LABEL=public-label-value\n",
    "entry.frontend.ts":
      'import { env } from "envlib"; document.body.textContent = JSON.stringify(env)',
  })
  try {
    const result = await build()
    const assets = resolve(result.outDir, "assets")
    let shipped = ""
    for (const file of await readdir(assets))
      shipped += await readFile(resolve(assets, file), "utf8")
    expect(shipped).not.toContain("pg-prod-pass-7f3k2xQ9wLm4")
    expect(shipped).toContain("public-label-value")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("the secret scan knows values that exist only in the app's .env files", async () => {
  const { root, build } = await envFixture({
    ".env.production": "API_TOKEN=tok-9f8e7d6c5b4a3z2y1x\n",
    "entry.frontend.ts": 'document.body.textContent = "tok-9f8e7d6c5b4a3z2y1x"',
  })
  try {
    await expect(build()).rejects.toThrow(/API_TOKEN/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("env-file public values reach both read styles and invalidate the component generation", async () => {
  const { root, build } = await envFixture({
    ".env.production": "PUBLIC_LABEL=public-first\n",
    "entry.frontend.ts":
      'document.body.textContent = import.meta.env.PUBLIC_LABEL + ":" + process.env.PUBLIC_LABEL',
  })
  const shipped = async (outDir: string): Promise<string> => {
    const assets = resolve(outDir, "assets")
    return (
      await Promise.all(
        (
          await readdir(assets)
        )
          .filter((name) => name.endsWith(".js"))
          .map((name) => readFile(resolve(assets, name), "utf8")),
      )
    ).join("\n")
  }
  try {
    const first = await build()
    const code = await shipped(first.outDir)
    expect(code).toContain("public-first")
    expect(code).not.toContain("PUBLIC_LABEL")
    await writeFile(resolve(root, ".env.production"), "PUBLIC_LABEL=public-second\n")
    const second = await build()
    expect(second.build).not.toBe(first.build)
    expect(await shipped(second.outDir)).toContain("public-second")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
