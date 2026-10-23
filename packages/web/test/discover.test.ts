import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { discoverRoutes } from "../src/fs.ts"

test("discoverRoutes scans a routes dir into a manifest", async () => {
  const dir = mkdtempSync(`${tmpdir()}/nifra-routes-`)
  try {
    // Route modules with a non-function default + no JSX: importing them under bun needs
    // no transform, and the imported module contributes no uncovered functions to coverage.
    writeFileSync(`${dir}/_layout.tsx`, "export default 'layout'\n")
    writeFileSync(`${dir}/index.tsx`, "export default 'home'\n")
    writeFileSync(`${dir}/_404.tsx`, "export default 'nope'\n")
    mkdirSync(`${dir}/users`)
    writeFileSync(`${dir}/users/_layout.tsx`, "export default 'users-layout'\n")
    writeFileSync(`${dir}/users/[id].tsx`, "export default 'user'\n")
    writeFileSync(`${dir}/styles.css`, "body{}\n") // non-route file → ignored

    const m = discoverRoutes(dir)
    expect(m.routes.map((r) => r.pattern).sort()).toEqual(["/", "/users/:id"])
    expect(m.routes.find((r) => r.pattern === "/users/:id")?.layoutIds).toEqual([
      "_layout",
      "users/_layout",
    ])
    expect(m.notFound).toBeDefined()
    expect(Object.keys(m.layouts).sort()).toEqual(["_layout", "users/_layout"])

    // load() actually imports the module (covers the lazy importer end-to-end).
    const home = m.routes.find((r) => r.pattern === "/")
    expect((await home?.load())?.default).toBe("home")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("discoverRoutes marks the pages that export keepAlive, and passes over one it cannot read", () => {
  const dir = mkdtempSync(`${tmpdir()}/nifra-routes-`)
  try {
    writeFileSync(`${dir}/_layout.tsx`, "export const keepAlive = true\nexport default 'layout'\n")
    writeFileSync(`${dir}/list.tsx`, "export const keepAlive = true\nexport default 'list'\n")
    writeFileSync(`${dir}/list.backend.ts`, "export const keepAlive = true\n")
    writeFileSync(`${dir}/index.tsx`, "export default 'home'\n")
    // Listed like a route file, but reading it fails: discovery still builds the manifest.
    mkdirSync(`${dir}/odd.tsx`)

    const m = discoverRoutes(dir)
    expect(m.routes.filter((r) => r.keepAlive === true).map((r) => r.id)).toEqual(["list"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
