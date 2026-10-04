import { expect, test } from "bun:test"
import { shouldPointLatest } from "./point-latest.ts"

test("latest moves only forward", () => {
  expect(shouldPointLatest("4.0.0-beta.3", undefined)).toBe(true)
  expect(shouldPointLatest("4.0.0-beta.3", "3.9.0")).toBe(true)
  expect(shouldPointLatest("4.0.0-beta.4", "4.0.0-beta.3")).toBe(true)
  expect(shouldPointLatest("4.0.0-beta.3", "4.0.0-beta.3")).toBe(false)
  expect(shouldPointLatest("4.0.0-beta.3", "4.0.0")).toBe(false)
  expect(shouldPointLatest("3.2.1", "3.10.0")).toBe(false)
})
