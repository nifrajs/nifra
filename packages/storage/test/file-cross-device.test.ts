import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileStorage } from "../src/index.ts"

// mock.module rewrites the shared node:fs/promises namespace, so keep the real functions first.
const real = { ...fs }
const crossDevice = (): Error =>
  Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" })

const tmpDirs: string[] = []
afterEach(() => mock.module("node:fs/promises", () => real))
afterAll(() => Promise.all(tmpDirs.map((d) => real.rm(d, { recursive: true, force: true }))))

async function storageOnItsOwnMount(): Promise<{ dir: string; storage: FileStorage }> {
  const dir = await real.mkdtemp(join(tmpdir(), "nifra-storage-xdev-"))
  tmpDirs.push(dir, `${dir}.nifra-state`)
  mock.module("node:fs/promises", () => ({
    ...real,
    rename: async () => {
      throw crossDevice()
    },
  }))
  return { dir, storage: new FileStorage(dir) }
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe("FileStorage on a root that is its own mount point", () => {
  test("a put falls back to writing in place and leaves no staged file", async () => {
    const { dir, storage } = await storageOnItsOwnMount()
    await storage.put("doc.txt", "a longer first version")
    await storage.put("doc.txt", "second")
    const object = await storage.get("doc.txt")
    expect(object === null ? null : text(object.body)).toBe("second")
    expect(await real.readdir(join(`${dir}.nifra-state`, "staging"))).toEqual([])
  })

  test.skipIf(process.platform === "win32")(
    "the in-place write refuses a final-component symlink and leaves its target alone",
    async () => {
      const { dir, storage } = await storageOnItsOwnMount()
      const outside = await real.mkdtemp(join(tmpdir(), "nifra-storage-xdev-out-"))
      tmpDirs.push(outside)
      const target = join(outside, "target.txt")
      await real.writeFile(target, "untouched")
      await real.symlink(target, join(dir, "object.txt"), "file")
      await expect(storage.put("object.txt", "replacement")).rejects.toThrow()
      expect(await real.readFile(target, "utf8")).toBe("untouched")
    },
  )
})
