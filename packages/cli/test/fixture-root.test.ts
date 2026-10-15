import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeReleasedDirectory } from "./fixture-root.ts"

const failure = (code: string): Error => Object.assign(new Error(code), { code })

test("a directory a killed tool still holds is removed once it is released", async () => {
  const calls: string[] = []
  await removeReleasedDirectory("held", (path) => {
    calls.push(path)
    if (calls.length === 1) throw failure("EBUSY")
  })
  expect(calls).toEqual(["held", "held"])
})

test("a failure other than a held directory is thrown at once", async () => {
  let calls = 0
  const removal = removeReleasedDirectory("named", () => {
    calls += 1
    throw failure("ENAMETOOLONG")
  })
  await expect(removal).rejects.toThrow("ENAMETOOLONG")
  expect(calls).toBe(1)
})

test("by default the directory and everything in it is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-released-"))
  writeFileSync(join(dir, "file.txt"), "x")
  await removeReleasedDirectory(dir)
  expect(existsSync(dir)).toBe(false)
})
