import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient, serverOnlyEmptyPlugin } from "../src/build.ts"

// #2: a server-only module (`*.server.ts`) imported from client-reachable code must NOT pull its import
// subtree (node: builtins, native deps) into the browser bundle. buildClient empties `.server` modules in
// the client build (CJS proxy → named/default imports become undefined, no missing-export error); the
// node-builtin guard still fails loud when the same import is co-located in a route (can't tree-shake out).
// Temp apps live INSIDE the workspace so the generated entry resolves @nifrajs/* (bunfig ignores .tmp-*).
const TMP = `${import.meta.dir}/.tmp-server-only-`
let root: string
beforeEach(() => {
  root = mkdtempSync(TMP)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const clientStub = (dir: string): string => {
  const m = join(dir, "client-stub.ts")
  writeFileSync(m, "export function mountRouter() {}\n")
  return m
}

test("buildClient empties a .server module so its node: subtree stays out of the client [#2]", async () => {
  const routes = join(root, "routes")
  mkdirSync(routes, { recursive: true })
  // server-only module pulling in node:crypto
  writeFileSync(
    join(root, "db.server.ts"),
    'import { randomUUID } from "node:crypto"\nexport const newId = () => randomUUID()\n',
  )
  // a route whose (server-only) loader uses it — the loader export survives client bundling (entrypoint)
  writeFileSync(
    join(routes, "index.tsx"),
    'import { newId } from "../db.server.ts"\nexport const loader = () => ({ id: newId() })\nexport default () => "home"\n',
  )
  const outDir = join(root, "dist")
  // SUCCEEDS (no node-builtin-guard throw) because the .server module is emptied in the client build
  await buildClient({ routesDir: routes, outDir, clientModule: clientStub(root), minify: false })
  let bundle = ""
  for (const f of readdirSync(outDir))
    if (f.endsWith(".js")) bundle += readFileSync(join(outDir, f), "utf8")
  expect(bundle).not.toContain("node:crypto")
  expect(bundle).not.toContain("randomUUID")
})

test("buildClient still fails loud when node: is co-located in a route (no .server escape) [#2/#4]", async () => {
  const routes = join(root, "routes")
  mkdirSync(routes, { recursive: true })
  writeFileSync(
    join(routes, "index.tsx"),
    'import { randomUUID } from "node:crypto"\nexport const loader = () => ({ id: randomUUID() })\nexport default () => "home"\n',
  )
  await expect(
    buildClient({
      routesDir: routes,
      outDir: join(root, "dist"),
      clientModule: clientStub(root),
      minify: false,
    }),
  ).rejects.toThrow(/node:crypto/)
})

test("serverOnlyEmptyPlugin empties *.server modules to an undefined-yielding stub", () => {
  let loaded: { contents: string; loader: string } | undefined
  const build = {
    onLoad: (_: { filter: RegExp }, cb: () => { contents: string; loader: string }) => {
      loaded = cb()
    },
  }
  // setup's real param is Bun's PluginBuilder; this unit only exercises onLoad.
  ;(serverOnlyEmptyPlugin().setup as unknown as (b: typeof build) => unknown)(build)
  expect(loaded?.contents).toContain("new Proxy")
  expect(loaded?.loader).toBe("js")
})
