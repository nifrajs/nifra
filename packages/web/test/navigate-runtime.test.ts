import { afterEach, describe, expect, test } from "bun:test"
import { navigateNow } from "../src/internal/navigate-runtime.ts"
import { setBrowserNavigate } from "../src/navigation.ts"

afterEach(() => setBrowserNavigate(undefined))

describe("navigateNow", () => {
  test("does nothing before a browser navigate is registered", () => {
    expect(navigateNow("/a")).toBeUndefined()
  })

  test("hands the registered navigate each target resolved at call time", () => {
    const calls: unknown[] = []
    setBrowserNavigate((to, options) => {
      calls.push([to, options])
    })
    navigateNow("/a", { replace: true })
    navigateNow(-1)
    navigateNow({ to: "/b", search: { q: "x" }, replace: true })
    expect(calls).toEqual([
      ["/a", { replace: true }],
      [-1, undefined],
      ["/b?q=x", { replace: true }],
    ])
  })
})
