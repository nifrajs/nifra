import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTarget } from "../src/build.ts"
import { adapterRefusal, installedPackage } from "../src/internal/node-adapter.ts"

// A `--target node` server entry is generated for the @nifrajs/node of the same release, and the bundle
// inlines whichever copy is installed: an older adapter has to stop the build, not the server.

const WEB_VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
).version

let root: string

beforeEach(() => {
  root = mkdtempSync(`${import.meta.dir}/.tmp-node-adapter-`)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const install = (dir: string, manifest: Record<string, unknown>): string => {
  const pkg = join(dir, "node_modules/@nifrajs/node")
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@nifrajs/node", ...manifest }))
  return pkg
}

test("the copy a module imports is the nearest one walking up from its directory", () => {
  const outer = install(root, { version: "1.0.0" })
  const inner = install(join(root, "app"), { version: "2.0.0" })
  expect(installedPackage("@nifrajs/node", join(root, "app/.work"))).toEqual({
    dir: inner,
    version: "2.0.0",
  })
  expect(installedPackage("@nifrajs/node", join(root, "other/.work"))).toEqual({
    dir: outer,
    version: "1.0.0",
  })
})

test("a copy whose package.json declares no version is unknown, not refused", () => {
  install(root, {})
  expect(installedPackage("@nifrajs/node", root)).toBeUndefined()
  expect(adapterRefusal("node", root, WEB_VERSION)).toBeUndefined()
})

test("with no copy installed the bundler reports the missing import itself", () => {
  const bare = mkdtempSync(join(tmpdir(), "nifra-node-adapter-"))
  try {
    expect(installedPackage("@nifrajs/node", bare)).toBeUndefined()
    expect(adapterRefusal("node", bare, WEB_VERSION)).toBeUndefined()
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test("an adapter older than @nifrajs/web is refused; the same release or newer is not", () => {
  const pkg = install(root, { version: "0.0.1" })
  expect(adapterRefusal("node", root, WEB_VERSION)).toBe(
    `[nifra/web] --target node would bundle @nifrajs/node 0.0.1 (${pkg}), older than @nifrajs/web ` +
      `${WEB_VERSION}. The server entry is generated for the adapter of the same release, and an ` +
      "older one can fail when the server starts. Upgrade the nifra packages together: " +
      `nifra upgrade ${WEB_VERSION}`,
  )
  install(root, { version: WEB_VERSION })
  expect(adapterRefusal("node", root, WEB_VERSION)).toBeUndefined()
  install(root, { version: "999.0.0" })
  expect(adapterRefusal("node", root, WEB_VERSION)).toBeUndefined()
})

test("a deno build is held to @nifrajs/deno the same way", () => {
  const pkg = join(root, "node_modules/@nifrajs/deno")
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@nifrajs/deno", version: "0.0.1" }),
  )
  expect(adapterRefusal("deno", root, WEB_VERSION)).toStartWith(
    `[nifra/web] --target deno would bundle @nifrajs/deno 0.0.1 (${pkg}), older than @nifrajs/web `,
  )
  // Each target looks only at its own adapter.
  expect(adapterRefusal("node", root, WEB_VERSION)).toBeUndefined()
})

for (const target of ["node", "deno"] as const) {
  test(`buildTarget ${target} refuses an older adapter before it clears the last deploy dir`, async () => {
    mkdirSync(join(root, "routes"))
    writeFileSync(
      join(root, "routes/index.tsx"),
      "export default function Home() { return null }\n",
    )
    writeFileSync(join(root, "client.tsx"), "export {}\n")
    writeFileSync(join(root, "ssr.tsx"), "export {}\n")
    const pkg = join(root, `node_modules/@nifrajs/${target}`)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: `@nifrajs/${target}`, version: "0.0.1" }),
    )
    const outDir = join(root, "dist")
    mkdirSync(outDir)
    writeFileSync(join(outDir, "server.js"), "// the last good build\n")
    const workDir = join(root, ".work")

    await expect(
      buildTarget(target, {
        routesDir: join(root, "routes"),
        outDir,
        workDir,
        clientModule: join(root, "client.tsx"),
        adapterImport: join(root, "ssr.tsx"),
      }),
    ).rejects.toThrow(`@nifrajs/${target} 0.0.1 (${pkg})`)
    expect(readFileSync(join(outDir, "server.js"), "utf8")).toBe("// the last good build\n")
    expect(existsSync(workDir)).toBe(false)
  })
}
