import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cacheImageAsset, openPinned } from "../src/internal/image-file.ts"

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

test("publication is atomic: no temporary file survives and a damaged name is reported with its path", () => {
  const dir = root()
  cacheImageAsset(dir, asset)
  expect(readdirSync(join(dir, "_images"))).toEqual([fileName.slice("_images/".length)])
  // A file cut short is never produced by publication itself, and when one is found the error says
  // which file to delete rather than leaving the build permanently failing without a hint.
  writeFileSync(join(dir, fileName), source.subarray(0, 1))
  expect(() => cacheImageAsset(dir, asset)).toThrow(
    new RegExp(`invalid cached image asset.*${fileName.slice("_images/".length)}.*delete`),
  )
  expect(readdirSync(join(dir, "_images"))).toHaveLength(1)
})

test("a failed publication leaves neither the final name nor a temporary file", () => {
  const dir = root()
  mkdirSync(join(dir, "_images"))
  // The final name is occupied by a directory, so linking the temporary file there must fail cleanly.
  mkdirSync(join(dir, fileName))
  expect(() => cacheImageAsset(dir, asset)).toThrow()
  expect(readdirSync(join(dir, "_images"))).toEqual([fileName.slice("_images/".length)])
})

test("openPinned opens a regular file and refuses links, directories and swapped-in files", async () => {
  // Callers pass a canonical path (the root check resolves it); a link in any component is refused.
  const dir = realpathSync(root())
  const file = join(dir, "pic.png")
  writeFileSync(file, source)
  const handle = await openPinned(file)
  try {
    expect((await handle.stat()).size).toBe(source.byteLength)
  } finally {
    await handle.close()
  }
  const link = join(dir, "link.png")
  symlinkSync(file, link)
  await expect(openPinned(link)).rejects.toThrow()
  mkdirSync(join(dir, "folder.png"))
  await expect(openPinned(join(dir, "folder.png"))).rejects.toThrow(/regular file/)
  await expect(openPinned(join(dir, "missing.png"))).rejects.toThrow()
})

/** Make linkSync behave as if another process published the name just before this one linked it. */
function lose(race: (target: string) => void): { restore(): void } {
  const spy = spyOn(fs, "linkSync").mockImplementation((_from, target) => {
    race(String(target))
    throw Object.assign(new Error("exists"), { code: "EEXIST" })
  })
  return { restore: () => spy.mockRestore() }
}

test("losing the publication race to an identical writer is accepted, to a different one refused", () => {
  const dir = root()
  const identical = lose((target) => writeFileSync(target, source))
  try {
    cacheImageAsset(dir, asset)
  } finally {
    identical.restore()
  }
  expect(readFileSync(join(dir, fileName))).toEqual(Buffer.from(source))
  expect(readdirSync(join(dir, "_images"))).toHaveLength(1)

  const other = root()
  const different = lose((target) => writeFileSync(target, new Uint8Array([9, 9, 9])))
  try {
    expect(() => cacheImageAsset(other, asset)).toThrow(/invalid cached image asset/)
  } finally {
    different.restore()
  }
  expect(readdirSync(join(other, "_images"))).toHaveLength(1)

  // The name vanished again before it could be read: neither accepted nor left half-published.
  const vanished = root()
  const gone = lose(() => {})
  try {
    expect(() => cacheImageAsset(vanished, asset)).toThrow(/invalid cached image asset/)
  } finally {
    gone.restore()
  }
  expect(readdirSync(join(vanished, "_images"))).toHaveLength(0)
})
