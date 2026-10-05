import { describe, expect, test } from "bun:test"
import { exportTargets, shipsTarget } from "./export-targets.ts"

describe("exportTargets", () => {
  test("reaches a condition nested under another condition", () => {
    expect(
      exportTargets({
        ".": {
          bun: "./src/index.ts",
          import: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
          default: "./dist/index.cjs",
        },
        "./resolve": "./dist/resolve.js",
      }),
    ).toEqual([
      { label: ". (bun)", target: "./src/index.ts" },
      { label: ". (import.types)", target: "./dist/index.d.cts" },
      { label: ". (import.default)", target: "./dist/index.cjs" },
      { label: ". (default)", target: "./dist/index.cjs" },
      { label: "./resolve", target: "./dist/resolve.js" },
    ])
  })

  test("reads a string, a fallback array, condition sugar, and skips null", () => {
    expect(exportTargets("./index.js")).toEqual([{ label: ".", target: "./index.js" }])
    expect(exportTargets({ ".": ["./a.js", { node: "./b.js" }], "./private": null })).toEqual([
      { label: ".", target: "./a.js" },
      { label: ". (node)", target: "./b.js" },
    ])
    expect(exportTargets({ import: "./a.mjs", require: "./a.cjs" })).toEqual([
      { label: ". (import)", target: "./a.mjs" },
      { label: ". (require)", target: "./a.cjs" },
    ])
  })
})

describe("shipsTarget", () => {
  const packed = new Set(["package.json", "dist/index.js", "dist/features/a.js"])

  test("an exact target must be packed", () => {
    expect(shipsTarget("./dist/index.js", packed)).toBe(true)
    expect(shipsTarget("./dist/index.d.cts", packed)).toBe(false)
  })

  test("a pattern target needs one packed entry it matches", () => {
    expect(shipsTarget("./dist/features/*.js", packed)).toBe(true)
    expect(shipsTarget("./dist/features/*.mjs", packed)).toBe(false)
    expect(shipsTarget("./src/*.js", packed)).toBe(false)
  })
})
