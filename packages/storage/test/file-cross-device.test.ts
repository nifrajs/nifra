import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { constants, type Mode, type PathLike } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileStorage } from "../src/index.ts"
import { racePuts } from "./race-puts.ts"

// mock.module rewrites the shared node:fs/promises namespace, so keep the real functions first.
const real = { ...fs }
const crossDevice = (): Error =>
  Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" })

const tmpDirs: string[] = []
afterEach(() => mock.module("node:fs/promises", () => real))
afterAll(() => Promise.all(tmpDirs.map((d) => real.rm(d, { recursive: true, force: true }))))

type Fs = typeof real

/** A root on a volume of its own: nothing renames into it from the bookkeeping beside it. */
async function storageOnItsOwnMount(
  overrides: (dir: string) => Partial<Fs> = () => ({}),
): Promise<{ dir: string; storage: FileStorage }> {
  // Real, as the storage resolves it: macOS's temporary directory is reached through a link.
  const dir = await real.realpath(await real.mkdtemp(join(tmpdir(), "nifra-storage-xdev-")))
  tmpDirs.push(dir, `${dir}.nifra-state`)
  mock.module("node:fs/promises", () => ({
    ...real,
    rename: async (from: string, to: string) => {
      if (from.startsWith(`${dir}.nifra-state`) && to.startsWith(join(dir, "/")))
        throw crossDevice()
      return real.rename(from, to)
    },
    ...overrides(dir),
  }))
  return { dir, storage: new FileStorage(dir) }
}

/** `open` that hands back a handle whose `writeFile` runs `write` first, for writes `match` picks. */
const holdingWrites = (
  match: (path: string) => boolean,
  write: () => Promise<void>,
): Partial<Fs> => ({
  async open(path: PathLike, flags?: string | number, mode?: Mode) {
    const handle = await real.open(path, flags, mode)
    if (typeof flags !== "number" || (flags & constants.O_WRONLY) === 0 || !match(String(path)))
      return handle
    return new Proxy(handle, {
      get(target, name) {
        if (name === "writeFile")
          return async (data: Uint8Array | string) => {
            await write()
            return target.writeFile(data)
          }
        const value: unknown = Reflect.get(target, name, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  },
})

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe("FileStorage on a root that is its own mount point", () => {
  test.skipIf(process.platform === "win32")(
    "a put is staged beside the object and renamed over it, leaving no staged file",
    async () => {
      const { dir, storage } = await storageOnItsOwnMount()
      await storage.put("doc.txt", "a longer first version")
      await storage.put("docs/inner.txt", "nested", { contentType: "text/plain" })
      await storage.put("doc.txt", "second")
      const object = await storage.get("doc.txt")
      expect(object === null ? null : text(object.body)).toBe("second")
      expect((await storage.get("docs/inner.txt"))?.contentType).toBe("text/plain")
      expect((await real.readdir(dir)).sort()).toEqual(["doc.txt", "docs"])
      expect(await real.readdir(join(dir, "docs"))).toEqual(["inner.txt"])
    },
  )

  test.skipIf(process.platform === "win32")(
    "a put that fails leaves the previous object whole, and readers see it whole meanwhile",
    async () => {
      let entered!: () => void
      const writing = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      // Holds the second put's write into the root, wherever it lands there.
      const { dir, storage } = await storageOnItsOwnMount((dir) => {
        let writes = 0
        return holdingWrites(
          (path) => path.startsWith(join(dir, "/")) && ++writes === 2,
          async () => {
            entered()
            await released
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
          },
        )
      })
      await storage.put("doc.txt", "ORIGINAL GOOD OBJECT")
      const put = storage.put("doc.txt", "REPLACEMENT")
      put.catch(() => {})
      await writing
      const during = await storage.get("doc.txt")
      expect(await storage.list()).toEqual(["doc.txt"])
      release()
      await expect(put).rejects.toMatchObject({ code: "ENOSPC" })
      const after = await storage.get("doc.txt")
      expect([during, after].map((o) => (o === null ? null : text(o.body)))).toEqual([
        "ORIGINAL GOOD OBJECT",
        "ORIGINAL GOOD OBJECT",
      ])
      expect(await real.readdir(dir)).toEqual(["doc.txt"])
    },
  )

  test.skipIf(process.platform === "win32")(
    "a staged file a crash left behind is never listed",
    async () => {
      const { dir, storage } = await storageOnItsOwnMount()
      await storage.put("a/doc.txt", "x")
      await real.writeFile(join(dir, "a", ".nifra\\left-behind.tmp"), "debris")
      expect(await storage.list()).toEqual(["a/doc.txt"])
    },
  )

  test.if(process.platform === "win32")(
    "Windows, where no file name is out of reach of a key, refuses rather than overwrite in place",
    async () => {
      const { storage } = await storageOnItsOwnMount()
      await expect(storage.put("doc.txt", "x")).rejects.toMatchObject({ code: "EXDEV" })
    },
  )

  test.skipIf(process.platform === "win32")(
    "concurrent puts from two instances never serve one put's body with the other's metadata",
    async () => {
      const { dir } = await storageOnItsOwnMount()
      const { mixed, failed } = await racePuts(new FileStorage(dir), new FileStorage(dir), 200)
      expect({ mixed, failed }).toEqual({ mixed: 0, failed: [] })
    },
  )

  test.skipIf(process.platform === "win32")(
    "a final-component symlink is refused and its target left alone",
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
