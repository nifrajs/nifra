import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadApp } from "../src/load.ts"

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test("plugin thunks resolve exactly once and remain available to later phases", async () => {
  const root = mkdtempSync(`${import.meta.dir}/.tmp-load-`)
  dirs.push(root)
  mkdirSync(join(root, "routes"))
  writeFileSync(join(root, "routes", "index.ts"), "export default function Page() {}\n")
  writeFileSync(
    join(root, "framework.ts"),
    `export const adapter = {}
     export const clientModule = "./client.ts"
     export const vitePlugins = () => {
       globalThis.__nifraPluginThunkCalls = (globalThis.__nifraPluginThunkCalls ?? 0) + 1
       return [{ name: "one-shot-plugin" }]
     }\n`,
  )

  const globals = globalThis as typeof globalThis & { __nifraPluginThunkCalls?: number }
  delete globals.__nifraPluginThunkCalls
  try {
    const app = await loadApp(root, "dist", { importQuery: `test=${crypto.randomUUID()}` })
    expect(Number(globals.__nifraPluginThunkCalls)).toBe(1)
    expect(app.resolvedPlugins.vitePlugins).toEqual([{ name: "one-shot-plugin" }])

    // Build/dev consumers reuse this retained array; reading it never invokes the one-shot factory.
    expect([...app.resolvedPlugins.vitePlugins]).toHaveLength(1)
    expect(Number(globals.__nifraPluginThunkCalls)).toBe(1)
  } finally {
    delete globals.__nifraPluginThunkCalls
  }
})
