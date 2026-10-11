import { describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as image from "../../image/src/open-resolved.ts"
import * as node from "../../node/src/open-resolved.ts"
import * as web from "../src/open-resolved.ts"

const withTree = async (fn: (root: string, outside: string) => Promise<void>): Promise<void> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nifra-open-resolved-")))
  try {
    await mkdir(join(base, "root", "assets"), { recursive: true })
    await mkdir(join(base, "outside"))
    await writeFile(join(base, "root", "assets", "app.js"), "inside")
    await writeFile(join(base, "outside", "app.js"), "SECRET")
    await fn(join(base, "root"), join(base, "outside"))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/**
 * Run `fn` while `process.platform` reads `platform`, which picks the open each copy uses, so both
 * opens run on any host.
 */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const own = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    if (own === undefined) Reflect.deleteProperty(process, "platform")
    else Object.defineProperty(process, "platform", own)
  }
}

for (const [pkg, { openResolved, opensAt, sameFileAt }] of Object.entries({ web, node, image })) {
  describe(pkg, () => {
    test("descriptor-name lookup falls back to file identity when procfs is unavailable", async () => {
      await withTree(async (root) => {
        const name = join(root, "assets", "app.js")
        const handle = await open(name, "r")
        try {
          const withoutProcfs = { fd: -1, stat: handle.stat.bind(handle) }
          expect(await opensAt(withoutProcfs, name)).toBe(true)
          await expect(opensAt(withoutProcfs, join(root, "missing.js"))).rejects.toThrow()
        } finally {
          await handle.close()
        }
      })
    })

    // Other kernels give Darwin's flag no symlink meaning, so off Darwin only its reads are checked.
    for (const platform of ["darwin", "linux"] as const) {
      const refuses = platform !== "darwin" || process.platform === "darwin"

      test(`opens a resolved name and reads its bytes (${platform} open)`, async () => {
        await withTree(async (root) => {
          const handle = await onPlatform(platform, () =>
            openResolved(join(root, "assets", "app.js")),
          )
          try {
            expect(await handle.readFile("utf8")).toBe("inside")
          } finally {
            await handle.close()
          }
        })
      })

      test(`a missing name is refused as missing (${platform} open)`, async () => {
        await withTree(async (root) => {
          await expect(
            onPlatform(platform, () => openResolved(join(root, "assets", "gone.js"))),
          ).rejects.toMatchObject({ code: "ENOENT" })
        })
      })

      // The state a writer inside the tree leaves between the containment check and the open: the
      // checked name is unchanged, but one of its directories is now a link out of the root.
      test.if(refuses)(
        `refuses a resolved name once an intermediate directory became a symlink (${platform} open)`,
        async () => {
          await withTree(async (root, outside) => {
            await rm(join(root, "assets"), { recursive: true })
            await symlink(outside, join(root, "assets"))
            await expect(
              onPlatform(platform, () => openResolved(join(root, "assets", "app.js"))),
            ).rejects.toMatchObject({ code: "ELOOP" })
          })
        },
      )

      test.if(refuses)(
        `refuses a resolved name once its final component became a symlink (${platform} open)`,
        async () => {
          await withTree(async (root, outside) => {
            await rm(join(root, "assets", "app.js"))
            await symlink(join(outside, "app.js"), join(root, "assets", "app.js"))
            await expect(
              onPlatform(platform, () => openResolved(join(root, "assets", "app.js"))),
            ).rejects.toMatchObject({ code: "ELOOP" })
          })
        },
      )
    }

    // The checks every platform without a race-free open relies on: an open file is refused once a
    // directory on its name was swapped for a link out of the root.
    test("an opened file no longer at its name behind a swapped directory is refused", async () => {
      await withTree(async (root, outside) => {
        const name = join(root, "assets", "app.js")
        let handle = await open(name, "r")
        try {
          expect(await opensAt(handle, name)).toBe(true)
          expect(await sameFileAt(handle, name)).toBe(true)
          if (process.platform === "win32") {
            // Windows locks the directory while this handle is open. Reopen the old file after the
            // move to exercise the identity check against the replacement path on this platform.
            await handle.close()
            await rename(join(root, "assets"), join(root, "assets-moved"))
            handle = await open(join(root, "assets-moved", "app.js"), "r")
          } else {
            await rename(join(root, "assets"), join(root, "assets-moved"))
          }
          await symlink(outside, join(root, "assets"))
          expect(await opensAt(handle, name)).toBe(false)
          expect(await sameFileAt(handle, name)).toBe(false)
        } finally {
          await handle.close()
        }
      })
    })

    test("an opened file replaced at its name is refused", async () => {
      await withTree(async (root) => {
        const name = join(root, "assets", "app.js")
        const handle = await open(name, "r")
        try {
          await rename(name, join(root, "assets", "old.js"))
          await writeFile(name, "replaced")
          expect(await sameFileAt(handle, name)).toBe(false)
        } finally {
          await handle.close()
        }
      })
    })
  })
}

test("the node and image copies match this one", async () => {
  const source = await readFile(new URL("../src/open-resolved.ts", import.meta.url), "utf8")
  for (const pkg of ["node", "image"]) {
    const copy = await readFile(
      new URL(`../../${pkg}/src/open-resolved.ts`, import.meta.url),
      "utf8",
    )
    expect({ pkg, body: copy.split("\n").slice(2).join("\n") }).toEqual({ pkg, body: source })
  }
})

// The race between realpath and open cannot be staged deterministically through a server, so the
// call sites are held to the helper by source: a bare open() there checks only the last component.
test("every static-file server opens through openResolved", async () => {
  for (const file of ["web/src/public-dir.ts", "image/src/server.ts", "node/src/index.ts"]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8")
    expect({ file, helper: /\bawait openResolved\(/.test(source) }).toEqual({ file, helper: true })
    expect({ file, bareOpen: /\b(?:open|fs\.open|promises\.open)\(/.test(source) }).toEqual({
      file,
      bareOpen: false,
    })
  }
})
