import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildScriptName,
  isPackageName,
  resolveWorkspaceLinkedPackage,
} from "../src/workspace-link.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function ground(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

test("isPackageName accepts scoped and plain names, rejects traversal", () => {
  expect(isPackageName("@nifrajs/core")).toBe(true)
  expect(isPackageName("react")).toBe(true)
  expect(isPackageName("../../etc")).toBe(false)
  expect(isPackageName("@scope/..")).toBe(false)
  expect(isPackageName("a/b/c")).toBe(false)
  expect(isPackageName("")).toBe(false)
})

test("buildScriptName reads scripts.build and ignores an empty or absent one", () => {
  expect(buildScriptName({ scripts: { build: "tsc -p ." } })).toBe("build")
  expect(buildScriptName({ scripts: { build: "   " } })).toBeUndefined()
  expect(buildScriptName({ scripts: { compile: "tsc" } })).toBeUndefined()
  expect(buildScriptName({})).toBeUndefined()
  expect(buildScriptName(undefined)).toBeUndefined()
})

test("resolves a linked checkout outside the project and names its build script", async () => {
  const root = await ground("nifra-link-root-")
  const checkout = await ground("nifra-link-src-")
  await writeFile(
    join(checkout, "package.json"),
    JSON.stringify({ name: "@scope/pkg", version: "1.0.0", scripts: { build: "tsc -p ." } }),
  )
  await mkdir(join(root, "node_modules", "@scope"), { recursive: true })
  await symlink(checkout, join(root, "node_modules", "@scope", "pkg"), "dir")

  const linked = await resolveWorkspaceLinkedPackage(root, "@scope/pkg")
  expect(linked.ok).toBe(true)
  if (!linked.ok) return
  expect(linked.buildScript).toBe("build")
  // The realpath, not the symlink: the build has to run in the checkout the developer edits.
  expect(linked.dir).not.toContain("node_modules")
})

test("refuses a package the project does not install", async () => {
  const root = await ground("nifra-link-missing-")
  const linked = await resolveWorkspaceLinkedPackage(root, "@scope/absent")
  expect(linked.ok).toBe(false)
  if (linked.ok) return
  expect(linked.reason).toContain("is not installed")
})
