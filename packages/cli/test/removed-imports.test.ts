import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectCheckResult, scanRemovedImports } from "../src/check.ts"
import { rewriteMovedExports } from "../src/check-scan.ts"
import { applyDiagnosticRecipe } from "../src/fix-recipes.ts"

const linesFlagged = (src: string): number[] =>
  scanRemovedImports("src/app.ts", src).map((f) => f.line)

test("flags every import of a package that no longer publishes", () => {
  // @nifrajs/budget folded into core; npm `latest` is still 1.13.0, so a `^2` range resolves to
  // nothing and `bun install` fails workspace-wide with an error naming neither cause nor fix.
  expect(linesFlagged('import { budget } from "@nifrajs/budget"')).toEqual([1])
  expect(linesFlagged('import "@nifrajs/budget"')).toEqual([1])
  // A subpath of the removed package counts too.
  expect(linesFlagged('import { B } from "@nifrajs/budget/types"')).toEqual([1])
})

test("a type-only import is left to tsc", () => {
  // The shared import scanner skips `import type` on purpose: it is erased at compile time and so
  // cannot cause a runtime failure, which is what these lints exist to catch. An unresolvable
  // type-only import still fails the typecheck that `nifra check` runs alongside these, so it is
  // covered - by the gate that can actually see it.
  expect(linesFlagged('import type { B } from "@nifrajs/budget"')).toEqual([])
})

test("flags only the bare side-effect form of a module that still exports values", () => {
  // The 2.0 break: `import "@nifrajs/core/ws"` used to install the WS runtime and now installs
  // nothing, so an app kept booting green in tests and failed at startup. But the module still
  // exports `websocket`, so flagging a value import would be wrong - and a rule that cries wolf on
  // correct code is a rule people learn to ignore.
  expect(linesFlagged('import "@nifrajs/core/ws"')).toEqual([1])
  expect(linesFlagged('import { websocket } from "@nifrajs/core/ws"')).toEqual([])
  expect(linesFlagged('import type { WsRuntime } from "@nifrajs/core/ws"')).toEqual([])
})

test("leaves current imports alone", () => {
  expect(
    linesFlagged(
      [
        'import { server } from "@nifrajs/core"',
        'import { budget } from "@nifrajs/core/budget"',
      ].join("\n"),
    ),
  ).toEqual([])
  // A package whose name merely starts the same way is not the removed one.
  expect(linesFlagged('import x from "@nifrajs/budgeting"')).toEqual([])
})

test("reports the right line in a multi-line file", () => {
  const src = [
    'import { server } from "@nifrajs/core"',
    "",
    '// import "@nifrajs/budget"  <- a comment, not an import',
    'import "@nifrajs/core/ws"',
    'import { budget } from "@nifrajs/budget"',
  ].join("\n")
  expect(linesFlagged(src)).toEqual([4, 5])
})

test("flags a moved name only where it is still imported from the module it left", () => {
  expect(linesFlagged('import { solidBunPlugin } from "@nifrajs/web-solid"')).toEqual([1])
  expect(linesFlagged('export { svelteBunPlugin } from "@nifrajs/web-svelte"')).toEqual([1])
  // The statement starts the finding, however many lines its bindings span.
  expect(
    linesFlagged(
      [
        "",
        "import {",
        "  solidAdapter,",
        "  solidBunPlugin as solid,",
        '} from "@nifrajs/web-solid"',
      ].join("\n"),
    ),
  ).toEqual([2])
  // What the root still exports, the new home, a type-only binding, and text that only looks like an
  // import are all left alone.
  expect(linesFlagged('import { solidAdapter } from "@nifrajs/web-solid"')).toEqual([])
  expect(linesFlagged('import { solidBunPlugin } from "@nifrajs/web-solid/plugin"')).toEqual([])
  expect(linesFlagged('import { type solidBunPlugin } from "@nifrajs/web-solid"')).toEqual([])
  expect(linesFlagged('import type { solidBunPlugin } from "@nifrajs/web-solid"')).toEqual([])
  expect(linesFlagged('// import { solidBunPlugin } from "@nifrajs/web-solid"')).toEqual([])
  expect(linesFlagged('const s = `import { solidBunPlugin } from "@nifrajs/web-solid"`')).toEqual(
    [],
  )
})

test("rewrites a moved name onto its new module and keeps the rest of the statement", () => {
  expect(rewriteMovedExports('import { solidBunPlugin } from "@nifrajs/web-solid"\n')).toBe(
    'import { solidBunPlugin } from "@nifrajs/web-solid/plugin"\n',
  )
  expect(
    rewriteMovedExports(
      "import {\n  solidAdapter,\n  solidBunPlugin as solid,\n} from '@nifrajs/web-solid';\n",
    ),
  ).toBe(
    "import { solidAdapter } from '@nifrajs/web-solid';\nimport { solidBunPlugin as solid } from '@nifrajs/web-solid/plugin';\n",
  )
  expect(
    rewriteMovedExports('export { svelteAdapter, svelteBunPlugin } from "@nifrajs/web-svelte"'),
  ).toBe(
    'export { svelteAdapter } from "@nifrajs/web-svelte"\nexport { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"',
  )
  const current = 'import { solidAdapter } from "@nifrajs/web-solid"\n'
  expect(rewriteMovedExports(current)).toBe(current)
})

test("nifra fix --code NF-C005 moves the import, and the finding is gone afterwards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-moved-export-"))
  try {
    await mkdir(join(dir, "src"), { recursive: true })
    const file = join(dir, "src", "build.ts")
    await writeFile(
      file,
      [
        'import { solidAdapter, solidBunPlugin } from "@nifrajs/web-solid"',
        'import { svelteBunPlugin } from "@nifrajs/web-svelte"',
        "export const plugins = [solidAdapter, solidBunPlugin, svelteBunPlugin]",
        "",
      ].join("\n"),
    )
    const moved = async () =>
      ((await collectCheckResult(dir, { lintsOnly: true })).structuredDiagnostics ?? []).filter(
        (diagnostic) => diagnostic.code === "NF-C005",
      )

    const before = await moved()
    expect(before.map((diagnostic) => diagnostic.line)).toEqual([1, 2])
    expect(before[0]?.message).toContain(
      '`solidBunPlugin` moved from "@nifrajs/web-solid" to "@nifrajs/web-solid/plugin"',
    )
    expect(before[0]?.fix).toEqual({
      recipe: "imports.moved-export",
      command: "nifra fix --code NF-C005",
    })

    const changed: string[] = []
    for (const diagnostic of before) changed.push(...(await applyDiagnosticRecipe(dir, diagnostic)))
    // One write covers the file; the second diagnostic finds nothing left to move.
    expect(changed).toEqual(["src/build.ts"])
    expect(await readFile(file, "utf8")).toBe(
      [
        'import { solidAdapter } from "@nifrajs/web-solid"',
        'import { solidBunPlugin } from "@nifrajs/web-solid/plugin"',
        'import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"',
        "export const plugins = [solidAdapter, solidBunPlugin, svelteBunPlugin]",
        "",
      ].join("\n"),
    )
    expect(await moved()).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
