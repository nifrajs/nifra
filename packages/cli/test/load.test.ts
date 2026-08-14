import { afterAll, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { loadApp } from "../src/load.ts"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) removeFixtureRoot(dir)
})

test("plugin thunks resolve exactly once and remain available to later phases", async () => {
  const root = createFixtureRoot("tmp-load-")
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

async function loadWithClientModule(spec: string): Promise<string> {
  const root = createFixtureRoot("tmp-load-")
  dirs.push(root)
  mkdirSync(join(root, "routes"))
  writeFileSync(join(root, "routes", "index.ts"), "export default function Page() {}\n")
  writeFileSync(
    join(root, "framework.ts"),
    `export const adapter = {}\nexport const clientModule = ${JSON.stringify(spec)}\n`,
  )
  const app = await loadApp(root, "dist", { importQuery: `test=${crypto.randomUUID()}` })
  return app.framework.clientModule
}

// The generated client entry embeds `clientModule` verbatim as an import specifier, and `nifra dev` and
// `nifra build` write that entry into different directories - so a RELATIVE clientModule must be
// absolutized at load, or it resolves against different bases and loads in one phase but not the other.
test("a relative clientModule is resolved to absolute at load", async () => {
  const resolved = await loadWithClientModule("./src/client.tsx")
  expect(resolved.endsWith("/src/client.tsx")).toBe(true)
  expect(resolve(resolved)).toBe(resolved) // already absolute
})

test("a bare/package clientModule specifier is left unchanged", async () => {
  expect(await loadWithClientModule("@nifrajs/web-react/client")).toBe("@nifrajs/web-react/client")
})

// A specifier with no `./` prefix is read as a bare PACKAGE specifier (resolved against node_modules).
// When a real local file sits at that path the user forgot the `./`, and the bundle would fail with an
// opaque "cannot resolve" - so load rejects it up front with the fix instead of failing silently.
test("a non-relative clientModule shadowing a local file is rejected with the ./ fix", async () => {
  const root = createFixtureRoot("tmp-load-")
  dirs.push(root)
  mkdirSync(join(root, "routes"))
  writeFileSync(join(root, "routes", "index.ts"), "export default function Page() {}\n")
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "client.tsx"), "export function mountRouter() {}\n")
  writeFileSync(
    join(root, "framework.ts"),
    `export const adapter = {}\nexport const clientModule = "src/client.tsx"\n`,
  )
  await expect(
    loadApp(root, "dist", { importQuery: `test=${crypto.randomUUID()}` }),
  ).rejects.toThrow(/no "\.\/" prefix.*"\.\/src\/client\.tsx"/s)
})
