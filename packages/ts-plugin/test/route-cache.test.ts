import { expect, mock, test } from "bun:test"
import * as pattern from "@nifrajs/core/pattern"

// A snapshot first: `mock.module` rewrites the live namespace, so the spread keeps the real compiler.
const real = { ...pattern }
let compiles = 0
mock.module("@nifrajs/core/pattern", () => ({
  ...real,
  compileRoutePattern: (value: string) => {
    compiles++
    return real.compileRoutePattern(value)
  },
}))
const { resolveRouteFile } = await import("../src/resolve.ts")

// Discovery returns a fresh array on every go-to-definition request, as `discoverRoutes` does.
const discovered = () => [
  { pattern: "/route-cache-probe", file: "routes/route-cache-probe/index.tsx" },
  { pattern: "/route-cache-probe/:id", file: "routes/route-cache-probe/[id].tsx" },
]

test("an unchanged route set compiles once, though each request hands over a new array", () => {
  compiles = 0
  expect(resolveRouteFile("/route-cache-probe/1", discovered())).toBe(
    "routes/route-cache-probe/[id].tsx",
  )
  expect(compiles).toBe(2)
  expect(resolveRouteFile("/route-cache-probe/2", discovered())).toBe(
    "routes/route-cache-probe/[id].tsx",
  )
  expect(resolveRouteFile("/route-cache-probe", discovered())).toBe(
    "routes/route-cache-probe/index.tsx",
  )
  expect(compiles).toBe(2)
})

test("a changed route set compiles afresh", () => {
  compiles = 0
  const added = [
    ...discovered(),
    { pattern: "/route-cache-probe/new", file: "routes/route-cache-probe/new.tsx" },
  ]
  expect(resolveRouteFile("/route-cache-probe/new", added)).toBe("routes/route-cache-probe/new.tsx")
  expect(compiles).toBe(3)
})

test("past its eight route sets the cache drops the oldest, so that set compiles again", () => {
  const set = (n: number) => [{ pattern: `/evict-${n}`, file: `routes/evict-${n}.tsx` }]
  for (let n = 0; n < 9; n++) resolveRouteFile(`/evict-${n}`, set(n))
  compiles = 0
  resolveRouteFile("/evict-8", set(8))
  expect(compiles).toBe(0)
  resolveRouteFile("/evict-0", set(0))
  expect(compiles).toBe(1)
})
