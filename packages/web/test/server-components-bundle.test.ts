import { expect, test } from "bun:test"
import { componentBundleImports } from "../src/server-components/bundle-proof.ts"

test("edge proof follows actual rewritten imports and keeps static, reexport and dynamic builtin denials", () => {
  expect(componentBundleImports('import "node:async_hooks"; const text = "node:module"')).toEqual([
    "node:async_hooks",
  ])
  expect(
    componentBundleImports(
      'import fs from "node:fs"; export * from "node:module"; const secret = import("node:crypto"); const path = require("node:path")',
    ),
  ).toEqual(["node:fs", "node:module", "node:crypto", "node:path"])
})
