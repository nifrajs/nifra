import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { buildClient } from "../src/build.ts"
import { entryChunks } from "../src/internal/entry-chunks.ts"

describe("entryChunks", () => {
  test("maps each entry to the output the metafile names it for, in any output order", () => {
    const chunks = entryChunks(
      {
        "./index-b.js": { entryPoint: "routes/index.tsx" },
        "./chunk-shared.js": {},
        "./login-a.js": { entryPoint: "routes/login.tsx" },
        "./login-a.css": { entryPoint: "routes/login.tsx" },
        "./_nifra-entry-c.js": { entryPoint: ".nifra/_nifra-entry.ts" },
        "./account-deletion-d.js": { entryPoint: "routes/account-deletion.tsx" },
      },
      "/app",
    )
    expect([...chunks]).toEqual([
      ["/app/routes/index.tsx", "./index-b.js"],
      ["/app/routes/login.tsx", "./login-a.js"],
      ["/app/.nifra/_nifra-entry.ts", "./_nifra-entry-c.js"],
      ["/app/routes/account-deletion.tsx", "./account-deletion-d.js"],
    ])
  })
})

describe("route preload chunks", () => {
  // Inside the workspace, so the generated bootstrap resolves `@nifrajs/web` through node_modules.
  const root = mkdtempSync(`${import.meta.dir}/.tmp-entry-chunks-`)
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("every route's chunk list ends with the chunk built from that route's own file", async () => {
    const pages = ["index", "login", "account-deletion", "account/index", "blog/index", "privacy"]
    for (const page of pages) {
      const file = join(root, "routes", `${page}.tsx`)
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, `export default function Page() { return "page:${page}" }\n`)
    }
    mkdirSync(join(root, "frontend"), { recursive: true })
    writeFileSync(join(root, "frontend/client-stub.ts"), "export function mountRouter() {}\n")
    const outDir = join(root, "dist", "assets")
    const manifest = await buildClient({
      routesDir: join(root, "routes"),
      outDir,
      clientModule: join(root, "frontend/client-stub.ts"),
      publicDir: false,
      minify: false,
    })
    for (const page of pages) {
      const urls = manifest.routes[page] ?? []
      const own = urls.at(-1) ?? ""
      expect(own).not.toBe("")
      expect(readFileSync(join(outDir, basename(own)), "utf8")).toContain(`page:${page}`)
    }
    expect(readFileSync(join(outDir, basename(manifest.entry)), "utf8")).toContain("mountRouter")
  }, 60_000)
})
