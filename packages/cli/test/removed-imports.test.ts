import { expect, test } from "bun:test"
import { scanRemovedImports } from "../src/check.ts"

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
