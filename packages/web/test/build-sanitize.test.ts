import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sanitizeOutputNames } from "../src/chunk-names.ts"

// Regression: a dynamic-route file (`blog/[slug].tsx`) makes Bun emit `[slug]-<hash>.js`. The `[ ]`
// in the URL is rejected by static serving (server-bun/CF Pages → 400), so the lazy import 404s and
// the route silently never hydrates. sanitizeOutputNames must rename those chunks URL-safe AND rewrite
// every reference to them inside the other chunks (where the bootstrap's lazy import URL lives).

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nifra-sanitize-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("renames bracketed chunks URL-safe, rewrites references, leaves safe names alone", () => {
  const slug = join(dir, "[slug]-abc123.js")
  const boot = join(dir, "index-def456.js")
  const shared = join(dir, "shared-789.js")
  const slugCss = join(dir, "[slug]-abc123.css")
  // the bootstrap lazily imports the bracketed chunk by its served URL
  writeFileSync(boot, 'const u = "/assets/[slug]-abc123.js"; import(u)')
  writeFileSync(slug, 'export const x = 1; import("./[slug]-abc123.js")')
  writeFileSync(shared, "export const y = 2")
  writeFileSync(slugCss, ".x{color:red}")

  const map = sanitizeOutputNames([
    { path: boot },
    { path: slug },
    { path: shared },
    { path: slugCss },
  ])

  // renamed on disk (js + css), and NOTHING in the dir has brackets anymore
  expect(existsSync(join(dir, "_slug_-abc123.js"))).toBe(true)
  expect(existsSync(slug)).toBe(false)
  expect(existsSync(join(dir, "_slug_-abc123.css"))).toBe(true)
  expect(readdirSync(dir).some((f) => /[[\]]/.test(f))).toBe(false)

  // the reference inside the (unrenamed) bootstrap chunk is rewritten to the safe URL
  const bootText = readFileSync(boot, "utf8")
  expect(bootText).toContain("/assets/_slug_-abc123.js")
  expect(bootText).not.toContain("[slug]")

  // the map exposes the rename (so the manifest URLs follow); the safe chunk is untouched + absent
  expect(map.get("[slug]-abc123.js")).toBe("_slug_-abc123.js")
  expect(map.get("[slug]-abc123.css")).toBe("_slug_-abc123.css")
  expect(map.has("shared-789.js")).toBe(false)
  expect(readFileSync(shared, "utf8")).toBe("export const y = 2")

  // every renamed name satisfies the scaffold's asset guard (^[A-Za-z0-9._-]+$)
  for (const safe of map.values()) expect(/^[A-Za-z0-9._-]+$/.test(safe)).toBe(true)
})

test("handles catch-all + optional segments; no-op when every name is already safe", () => {
  const catchAll = join(dir, "[...path]-aaa.js")
  const optional = join(dir, "[[lang]]-bbb.js")
  writeFileSync(catchAll, "export const z = 1")
  writeFileSync(optional, "export const w = 1")
  const map = sanitizeOutputNames([{ path: catchAll }, { path: optional }])
  expect(map.get("[...path]-aaa.js")).toBe("_...path_-aaa.js")
  expect(map.get("[[lang]]-bbb.js")).toBe("__lang__-bbb.js")
  expect(existsSync(join(dir, "_...path_-aaa.js"))).toBe(true)

  // all-safe inputs → empty map, nothing renamed or rewritten
  const ok = join(dir, "ok-ccc.js")
  writeFileSync(ok, "x")
  expect(sanitizeOutputNames([{ path: ok }]).size).toBe(0)
})
