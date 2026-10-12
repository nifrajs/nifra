import { afterEach, expect, test } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProjectDir } from "../src/mcp-context.ts"
import { resolveMcpProjectPath } from "../src/mcp-path.ts"
import { resolveInsideProject, writeTargetOf } from "../src/project-path.ts"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A project with `planted.json` linked to a file that does not exist yet in a directory outside it. */
async function danglingOut(): Promise<{ root: string; outside: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "nifra-dangle-root-")))
  const outside = realpathSync(await mkdtemp(join(tmpdir(), "nifra-dangle-outside-")))
  dirs.push(root, outside)
  await symlink(join(outside, "planted.json"), join(root, "planted.json"))
  await symlink(join(outside, "missing-dir"), join(root, "out-dir"))
  await mkdir(join(root, "app"))
  await symlink("../app/new.json", join(root, "app", "inside.json"))
  return { root, outside }
}

test("a dangling symlink is judged by where a write through it lands", async () => {
  const { root, outside } = await danglingOut()
  expect(writeTargetOf(join(root, "planted.json"))).toBe(join(outside, "planted.json"))
  expect(writeTargetOf(join(root, "out-dir", "a", "b.json"))).toBe(
    join(outside, "missing-dir", "a", "b.json"),
  )
  expect(writeTargetOf(join(root, "app", "inside.json"))).toBe(join(root, "app", "new.json"))
  expect(writeTargetOf(join(root, "not", "yet.json"))).toBe(join(root, "not", "yet.json"))
})

test("every project-path guard refuses a dangling symlink that points outside the project", async () => {
  const { root, outside } = await danglingOut()
  expect(resolveMcpProjectPath(root, "planted.json")).toBeNull()
  expect(resolveMcpProjectPath(root, "out-dir/snapshot.json")).toBeNull()
  expect(resolveProjectDir(root, "out-dir")).toBeNull()
  expect(resolveProjectDir(root, "out-dir/app")).toBeNull()
  expect(await resolveInsideProject(root, "planted.json")).toBeUndefined()
  expect(existsSync(join(outside, "planted.json"))).toBe(false)
})

test("a dangling symlink that stays inside the project resolves to its target", async () => {
  const { root } = await danglingOut()
  expect(resolveMcpProjectPath(root, "app/inside.json")).toBe(join(root, "app", "new.json"))
  expect(await resolveInsideProject(root, "app/inside.json")).toBe(join(root, "app", "inside.json"))
})

test("a symlink loop is refused rather than followed forever", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "nifra-dangle-loop-")))
  dirs.push(root)
  await symlink(join(root, "b"), join(root, "a"))
  await symlink(join(root, "a"), join(root, "b"))
  expect(resolveMcpProjectPath(root, "a")).toBeNull()
  expect(writeTargetOf(join(root, "a"))).toBeUndefined()
})
