import { afterEach, expect, test } from "bun:test"
import { type BrowserNavigate, getBrowserNavigate, setBrowserNavigate } from "../src/index.ts"

// The bridge is a module singleton; reset it after each test so leakage can't cross tests.
afterEach(() => setBrowserNavigate(undefined))

test("the navigation bridge is empty until a browser navigate is registered", () => {
  expect(getBrowserNavigate()).toBeUndefined()
})

test("setBrowserNavigate publishes the navigate; clearing with undefined removes it", () => {
  const calls: Array<[string | number, unknown]> = []
  const nav: BrowserNavigate = (to, options) => calls.push([to, options])
  setBrowserNavigate(nav)
  expect(getBrowserNavigate()).toBe(nav)

  // A binding reads it at call time and forwards args verbatim.
  getBrowserNavigate()?.("/users/7", { replace: true })
  getBrowserNavigate()?.(-1)
  expect(calls).toEqual([
    ["/users/7", { replace: true }],
    [-1, undefined],
  ])

  setBrowserNavigate(undefined)
  expect(getBrowserNavigate()).toBeUndefined()
})
