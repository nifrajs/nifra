import { afterEach, describe, expect, test } from "bun:test"
import { rawHref } from "../src/href.ts"
import { navigateNow } from "../src/internal/navigate-runtime.ts"
import { setBrowserNavigate } from "../src/navigation.ts"

afterEach(() => setBrowserNavigate(undefined))

describe("navigateNow", () => {
  test("does nothing before a browser navigate is registered, and keeps nothing for one", () => {
    navigateNow(rawHref("/a"))
    const calls: unknown[] = []
    setBrowserNavigate((to) => {
      calls.push(to)
    })
    expect(calls).toEqual([])
  })

  test("hands the registered navigate each target resolved at call time", () => {
    const calls: unknown[] = []
    setBrowserNavigate((to, options) => {
      calls.push([to, options])
    })
    navigateNow(rawHref("/a"), { replace: true })
    navigateNow(-1)
    navigateNow(rawHref("/b?q=x"), { replace: true })
    expect(calls).toEqual([
      ["/a", { replace: true }],
      [-1, undefined],
      ["/b?q=x", { replace: true }],
    ])
  })
})
