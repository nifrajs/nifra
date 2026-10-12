import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const read = (file: string) => readFileSync(join(root, file), "utf8")

test("the workbench's native shell carries the workbench package's version", () => {
  const { version } = JSON.parse(read("apps/workbench/package.json")) as { version: string }
  const tauri = JSON.parse(read("apps/workbench/src-tauri/tauri.conf.json")) as { version: string }
  expect(tauri.version).toBe(version)
  expect(/^version = "([^"]+)"/m.exec(read("apps/workbench/src-tauri/Cargo.toml"))?.[1]).toBe(
    version,
  )
})
