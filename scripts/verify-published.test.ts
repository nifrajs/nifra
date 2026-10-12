import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { integrityMatches, publishedTarballFailures } from "./verify-published.ts"

let dir: string
let bytes: Uint8Array
let integrity: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-published-"))
  mkdirSync(join(dir, "package", "dist"), { recursive: true })
  writeFileSync(join(dir, "package", "package.json"), "{}")
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

test("a matching tarball is read and held to the never-ship and marker rules", () => {
  expect(publishedTarballFailures("@x/a@1.0.0", { bytes, integrity }, ["ZQX-HIDDEN"])).toEqual({
    failures: [
      "@x/a@1.0.0/dist/index.test.js: a test file",
      "@x/a@1.0.0/dist/index.js: private marker present",
    ],
    paths: ["dist/index.js", "dist/index.test.js", "package.json"],
  })
})
