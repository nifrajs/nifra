import { afterAll, afterEach, expect, mock, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileStorage } from "../src/index.ts"

// mock.module rewrites the shared node:fs/promises namespace, so keep the real functions first.
const real = { ...fs }

const tmpDirs: string[] = []
afterEach(() => mock.module("node:fs/promises", () => real))
afterAll(() => Promise.all(tmpDirs.map((d) => real.rm(d, { recursive: true, force: true }))))

test.skipIf(process.platform === "win32")(
  "list skips a directory replaced by a symlink, or removed, after the listing read it",
  async () => {
    const root = await real.mkdtemp(join(tmpdir(), "nifra-storage-swap-"))
    const outside = await real.mkdtemp(join(tmpdir(), "nifra-storage-swap-out-"))
    tmpDirs.push(root, `${root}.nifra-state`, outside)
    const storage = new FileStorage(root)
    await storage.put("inside.txt", "a")
    await storage.put("sub/kept.txt", "b")
    await storage.put("gone/dropped.txt", "d")
    await real.writeFile(join(outside, "elsewhere.txt"), "c")
    const roots = new Set([root, await real.realpath(root)])
    let swapped = false
    mock.module("node:fs/promises", () => ({
      ...real,
      readdir: async (...args: Parameters<typeof real.readdir>) => {
        const listed = await real.readdir(...args)
        if (!swapped && roots.has(String(args[0]))) {
          swapped = true
          await real.rm(join(root, "sub"), { recursive: true })
          await real.symlink(outside, join(root, "sub"), "dir")
          await real.rm(join(root, "gone"), { recursive: true })
        }
        return listed
      },
    }))

    expect(await storage.list()).toEqual(["inside.txt"])
    expect(swapped).toBe(true)
  },
)
