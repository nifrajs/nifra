import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateServerManifest } from "@nifrajs/web"
import { parseManifestRouteFiles } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { syncServerManifests } from "../src/sync-manifest.ts"

// Build a fixture app: a routes/ tree + a committed server-manifest.ts generated from it (with baked
// client assets), matching the layout `buildServer` produces (manifest next to serverEntry, `./routes/`).
async function fixture(): Promise<{ dir: string; manifestPath: string; routesDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "nifra-syncman-"))
  const routesDir = join(dir, "routes")
  await mkdir(routesDir, { recursive: true })
  await writeFile(join(routesDir, "index.tsx"), "export default () => null")
  await writeFile(join(routesDir, "about.tsx"), "export default () => null")
  const source = generateServerManifest(discoverRoutes(routesDir), {
    resolve: (file) => `./routes/${file}`,
    clientEntry: "/_nifra/entry.abc123.js",
    styles: ["/_nifra/app.def456.css"],
    routeStyles: { "index.tsx": ["/_nifra/index.aaa.css"] },
  })
  const manifestPath = join(dir, "server-manifest.ts")
  await writeFile(manifestPath, source)
  return { dir, manifestPath, routesDir }
}

describe("nifra sync-manifest", () => {
  test("adds a new route to the committed manifest, preserving baked client assets", async () => {
    const { dir, manifestPath, routesDir } = await fixture()
    // Add a route on disk -> the committed manifest is now stale (the drift `nifra check` flags).
    await writeFile(join(routesDir, "blog.tsx"), "export default () => null")

    const [result] = await syncServerManifests(dir)
    expect(result?.changed).toBe(true)
    expect(result?.added).toContain("blog.tsx")
    expect(result?.removed).toEqual([])

    const synced = await readFile(manifestPath, "utf8")
    // The new route is now imported...
    expect(parseManifestRouteFiles(synced)).toEqual(["about.tsx", "blog.tsx", "index.tsx"])
    // ...and the baked client-asset references were preserved verbatim (no full build needed).
    expect(synced).toContain('export const clientEntry = "/_nifra/entry.abc123.js"')
    expect(synced).toContain('export const styles = ["/_nifra/app.def456.css"]')
    expect(synced).toContain('"index.tsx":["/_nifra/index.aaa.css"]')
    await rm(dir, { recursive: true, force: true })
  })

  test("drops a removed route and reports it", async () => {
    const { dir, manifestPath, routesDir } = await fixture()
    await rm(join(routesDir, "about.tsx"))

    const [result] = await syncServerManifests(dir)
    expect(result?.changed).toBe(true)
    expect(result?.removed).toContain("about.tsx")
    expect(parseManifestRouteFiles(await readFile(manifestPath, "utf8"))).toEqual(["index.tsx"])
    await rm(dir, { recursive: true, force: true })
  })

  test("no-op when already in sync (file untouched)", async () => {
    const { dir, manifestPath } = await fixture()
    const before = await readFile(manifestPath, "utf8")
    const [result] = await syncServerManifests(dir)
    expect(result?.changed).toBe(false)
    expect(await readFile(manifestPath, "utf8")).toBe(before)
    await rm(dir, { recursive: true, force: true })
  })

  test("ignores a non-generated file named server-manifest.ts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-syncman-"))
    await writeFile(join(dir, "server-manifest.ts"), "export const manifest = {} // hand-written")
    const results = await syncServerManifests(dir)
    expect(results).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
