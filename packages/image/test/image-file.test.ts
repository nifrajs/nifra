import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cacheImageAsset } from "../src/internal/image-file.ts"

const source = new Uint8Array([1, 2, 3])
const fileName = `_images/${createHash("sha256").update(source).digest("hex")}.png`
const asset = { fileName, source }
const roots: string[] = []
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-cache-image-"))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("cached assets use exclusive, idempotent creation and reject corrupted existing bytes", () => {
  const dir = root()
  cacheImageAsset(dir, asset)
  cacheImageAsset(dir, asset)
  expect(readFileSync(join(dir, fileName))).toEqual(Buffer.from(source))
  writeFileSync(join(dir, fileName), new Uint8Array([3, 2, 1]))
  expect(() => cacheImageAsset(dir, asset)).toThrow()
  expect(readFileSync(join(dir, fileName))).toEqual(Buffer.from([3, 2, 1]))
})

test("cache publication refuses final and intermediate symlinks without touching outside files", () => {
  const dir = root()
  const outside = root()
  const victim = join(outside, "victim.png")
  writeFileSync(victim, "private")
  mkdirSync(join(dir, "_images"))
  symlinkSync(victim, join(dir, fileName))
  expect(() => cacheImageAsset(dir, asset)).toThrow()
  expect(readFileSync(victim, "utf8")).toBe("private")
  rmSync(join(dir, "_images"), { recursive: true })
  symlinkSync(outside, join(dir, "_images"), "dir")
  expect(() => cacheImageAsset(dir, asset)).toThrow()
  expect(readFileSync(victim, "utf8")).toBe("private")
})

test("cache publication refuses non-files and oversized existing assets", () => {
  const dir = root()
  mkdirSync(join(dir, fileName), { recursive: true })
  expect(() => cacheImageAsset(dir, asset)).toThrow()
  rmSync(join(dir, fileName), { recursive: true })
  writeFileSync(join(dir, fileName), new Uint8Array(10))
  expect(() => cacheImageAsset(dir, asset)).toThrow()
})

test("invalid asset paths are rejected before writing a cache", () => {
  expect(() => cacheImageAsset(root(), { ...asset, fileName: "../escape.png" })).toThrow(/invalid/)
})
