import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { TYPECHECK_PROJECTS, uncoveredTypecheckConfigs } from "./typecheck.ts"

const ROOT = resolve(import.meta.dir, "..")

// The gate is a hand-kept list, so a DOM/JSX package that ships its own tsconfig but is never added would
// silently go unchecked. This is the assertion that makes that impossible: every plain package tsconfig
// on disk must appear in TYPECHECK_PROJECTS.
test("every package tsconfig is covered by the typecheck gate", () => {
  expect(uncoveredTypecheckConfigs()).toEqual([])
})

// The reverse: a listed project that was deleted or renamed would make `tsc -p` fail with a confusing
// "file not found" mid-run. Catch it here instead.
test("every listed typecheck project exists on disk", () => {
  for (const project of TYPECHECK_PROJECTS) {
    expect(existsSync(join(ROOT, project))).toBe(true)
  }
})

test("the root corpus is checked first", () => {
  expect(TYPECHECK_PROJECTS[0]).toBe("tsconfig.json")
})
