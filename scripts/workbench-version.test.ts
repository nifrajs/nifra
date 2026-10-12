import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const read = (file: string) => readFileSync(join(root, file), "utf8")

test("the workbench's native shell carries the workbench package's version", () => {
  const version: unknown = JSON.parse(read("apps/workbench/package.json")).version
  if (typeof version !== "string") throw new Error("apps/workbench/package.json has no version")
  expect(JSON.parse(read("apps/workbench/src-tauri/tauri.conf.json")).version).toBe(version)
  expect(/^version = "([^"]+)"/m.exec(read("apps/workbench/src-tauri/Cargo.toml"))?.[1]).toBe(
    version,
  )
})
