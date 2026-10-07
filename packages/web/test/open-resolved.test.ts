import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openResolved } from "../src/open-resolved.ts"

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

test("opens a resolved name and reads its bytes", async () => {
  await withTree(async (root) => {
    const handle = await openResolved(join(root, "assets", "app.js"))
    try {
      expect(await handle.readFile("utf8")).toBe("inside")
    } finally {
      await handle.close()
    }
  })
})

// The state a writer inside the tree leaves between the containment check and the open: the
// checked name is unchanged, but one of its directories is now a link out of the root.
test("refuses a resolved name once an intermediate directory became a symlink", async () => {
  await withTree(async (root, outside) => {
    await rm(join(root, "assets"), { recursive: true })
    await symlink(outside, join(root, "assets"))
    await expect(openResolved(join(root, "assets", "app.js"))).rejects.toMatchObject({
      code: "ELOOP",
    })
  })
})

test("refuses a resolved name once its final component became a symlink", async () => {
  await withTree(async (root, outside) => {
    await rm(join(root, "assets", "app.js"))
    await symlink(join(outside, "app.js"), join(root, "assets", "app.js"))
    await expect(openResolved(join(root, "assets", "app.js"))).rejects.toMatchObject({
      code: "ELOOP",
    })
  })
})

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
