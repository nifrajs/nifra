import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildTarget } from "../src/build.ts"
import { assertDisposableDir } from "../src/internal/disposable-dir.ts"
import { buildServerComponents } from "../src/server-components/build.ts"

// The build clears outDir and workDir before writing. A directory that holds the app's own sources
// must be refused before anything is deleted, whichever way the path reaches it.

let parent: string
let root: string

beforeEach(() => {
  parent = mkdtempSync(`${import.meta.dir}/.tmp-out-dir-`)
  root = join(parent, "app")
  mkdirSync(join(root, "routes"), { recursive: true })
  writeFileSync(join(root, "routes/index.tsx"), "export default function Home() { return null }\n")
  mkdirSync(join(root, "frontend"), { recursive: true })
  writeFileSync(join(root, "frontend/client.tsx"), "export {}\n")
  writeFileSync(join(root, "frontend/ssr.tsx"), "export {}\n")
})
afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

const build = (outDir: string, workDir = join(root, ".work")) =>
  buildTarget("bun", {
    routesDir: join(root, "routes"),
    outDir,
    workDir,
    clientModule: join(root, "frontend/client.tsx"),
    adapterImport: join(root, "frontend/ssr.tsx"),
  })

test("buildTarget refuses an outDir that is the app root and leaves the sources in place", async () => {
  await expect(build(root)).rejects.toThrow(/outDir \(.+\) contains .+routes; the build clears/)
  expect(existsSync(join(root, "routes/index.tsx"))).toBe(true)
})

test("buildTarget refuses an outDir that is an ancestor of the app root", async () => {
  await expect(build(parent)).rejects.toThrow(/outDir/)
  expect(existsSync(join(root, "routes/index.tsx"))).toBe(true)
})

test("buildTarget refuses an outDir that is the routes directory itself", async () => {
  await expect(build(join(root, "routes"))).rejects.toThrow(/outDir \(.+\) is .+routes/)
  expect(existsSync(join(root, "routes/index.tsx"))).toBe(true)
})

test("buildTarget refuses an outDir symlinked to the app root", async () => {
  const link = join(parent, "link")
  symlinkSync(root, link)
  await expect(build(link)).rejects.toThrow(/outDir/)
  expect(existsSync(join(root, "routes/index.tsx"))).toBe(true)
})

test("buildTarget refuses a workDir that holds the sources", async () => {
  await expect(build(join(parent, "dist"), root)).rejects.toThrow(/workDir \(.+\) contains/)
  expect(existsSync(join(root, "routes/index.tsx"))).toBe(true)
})

test("buildServerComponents refuses an outDir above the app root before moving anything", async () => {
  await expect(
    buildServerComponents({
      root,
      adapter: "react",
      entries: { client: "frontend/client.tsx", ssr: "frontend/ssr.tsx" },
      outDir: "..",
    }),
  ).rejects.toThrow(/outDir \(.+\) contains/)
  expect(existsSync(join(root, "routes/index.tsx"))).toBe(true)
  expect(existsSync(join(root, "frontend/ssr.tsx"))).toBe(true)
})

test("assertDisposableDir accepts a separate or missing directory and refuses a filesystem root", () => {
  const dist = join(parent, "dist")
  mkdirSync(dist)
  writeFileSync(join(dist, "stale.js"), "")
  expect(() => assertDisposableDir("outDir", dist, [root])).not.toThrow()
  expect(() => assertDisposableDir("outDir", join(parent, "missing"), [root])).not.toThrow()
  expect(() => assertDisposableDir("outDir", join(root, "routes-sibling"), [root])).not.toThrow()
  let top = parent
  while (dirname(top) !== top) top = dirname(top)
  expect(() => assertDisposableDir("outDir", top, [])).toThrow(/filesystem root/)
})
