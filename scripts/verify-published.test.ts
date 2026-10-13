import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fetchPublished,
  integrityMatches,
  publishedTarballFailures,
  type RegistryAccess,
} from "./verify-published.ts"

let dir: string
let bytes: Uint8Array
let integrity: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-published-"))
  mkdirSync(join(dir, "package", "dist"), { recursive: true })
  writeFileSync(join(dir, "package", "package.json"), '{"version":"1.0.0"}')
  writeFileSync(join(dir, "package", "CHANGELOG.md"), "# @x/a\n\n## 0.9.0\n")
  writeFileSync(join(dir, "package", "dist", "index.js"), "// zqx-hidden\nexport {}")
  writeFileSync(join(dir, "package", "dist", "index.test.js"), "test()")
  const tgz = join(dir, "p.tgz")
  if (spawnSync("tar", ["-czf", tgz, "-C", dir, "package"]).status !== 0) throw new Error("tar")
  bytes = readFileSync(tgz)
  integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("only the registry's own sha512 of these exact bytes matches", () => {
  expect(integrityMatches(bytes, integrity)).toBe(true)
  const changed = new Uint8Array(bytes)
  changed[changed.length - 1] = (changed[changed.length - 1]! + 1) % 256
  expect(integrityMatches(changed, integrity)).toBe(false)
  const sha1 = `sha1-${new Bun.CryptoHasher("sha1").update(bytes).digest("base64")}`
  expect(integrityMatches(bytes, sha1)).toBe(false)
  expect(integrityMatches(bytes, "garbage")).toBe(false)
})

test("a tarball that fails its hash is refused before it is opened", () => {
  const changed = new Uint8Array(bytes)
  changed[0] = (changed[0]! + 1) % 256
  expect(publishedTarballFailures("@x/a@1.0.0", { bytes: changed, integrity }, [])).toEqual({
    failures: ["@x/a@1.0.0: tarball does not match the registry's integrity hash"],
    paths: [],
  })
})

test("a matching tarball is read and held to the changelog, never-ship and marker rules", () => {
  expect(publishedTarballFailures("@x/a@1.0.0", { bytes, integrity }, ["ZQX-HIDDEN"])).toEqual({
    failures: [
      "@x/a@1.0.0: CHANGELOG.md's newest section is `## 0.9.0`, not `## 1.0.0`",
      "@x/a@1.0.0/dist/index.test.js: a test file",
      "@x/a@1.0.0/dist/index.js: private marker present",
    ],
    paths: ["CHANGELOG.md", "dist/index.js", "dist/index.test.js", "package.json"],
  })
})

/** npm answering from a script of statuses per URL, on a clock that only sleeping moves. */
function scriptedRegistry(statuses: Record<string, number[]>): RegistryAccess & { slept: number } {
  let clock = 0
  const access = {
    slept: 0,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
      access.slept += 1
    },
    fetch: async (url: string) => {
      const status = statuses[url]?.shift() ?? 200
      if (status !== 200) return new Response(null, { status })
      if (url.endsWith(".tgz")) return new Response(bytes)
      return Response.json({ dist: { tarball: "https://r.test/p.tgz", integrity } })
    },
  }
  return access
}

test("a tarball npm does not serve yet is retried while the wait lasts", async () => {
  const registry = scriptedRegistry({ "https://r.test/p.tgz": [404, 404] })
  const fetched = await fetchPublished("https://r.test", "p", "1.0.0", 60_000, registry)
  expect(typeof fetched === "string" ? fetched : fetched.integrity).toBe(integrity)
  expect(registry.slept).toBe(2)
})

test("a tarball still missing when the wait runs out fails with its status", async () => {
  const registry = scriptedRegistry({ "https://r.test/p.tgz": [404, 404, 404] })
  expect(await fetchPublished("https://r.test", "p", "1.0.0", 20_000, registry)).toBe(
    "p@1.0.0: tarball download failed (404)",
  )
  expect(registry.slept).toBe(2)
})

test("a tarball error other than 404 is not retried", async () => {
  const registry = scriptedRegistry({ "https://r.test/p.tgz": [500] })
  expect(await fetchPublished("https://r.test", "p", "1.0.0", 60_000, registry)).toBe(
    "p@1.0.0: tarball download failed (500)",
  )
  expect(registry.slept).toBe(0)
})
