import { expect, test } from "bun:test"
import {
  benchmarkVersionIsCurrent,
  checkPublicReleaseFreshness,
} from "./check-public-release-freshness.ts"

test("public release metadata is current", () => {
  expect(checkPublicReleaseFreshness()).toEqual([])
})

test("a patch release may keep the benchmark numbers of its minor, and nothing older or newer", () => {
  expect(benchmarkVersionIsCurrent("5.15.1", "5.15.1")).toBe(true)
  expect(benchmarkVersionIsCurrent("5.15.0", "5.15.1")).toBe(true)
  expect(benchmarkVersionIsCurrent("5.15.1", "5.15.2")).toBe(true)
  expect(benchmarkVersionIsCurrent("5.14.0", "5.15.1")).toBe(false)
  expect(benchmarkVersionIsCurrent("5.14.9", "5.15.1")).toBe(false)
  expect(benchmarkVersionIsCurrent("4.15.0", "5.15.1")).toBe(false)
  expect(benchmarkVersionIsCurrent("5.15.2", "5.15.1")).toBe(false)
  expect(benchmarkVersionIsCurrent(undefined, "5.15.1")).toBe(false)
  expect(benchmarkVersionIsCurrent("5.15", "5.15.1")).toBe(false)
})

test("a minor or major release needs numbers captured at its own version", () => {
  expect(benchmarkVersionIsCurrent("5.16.0", "5.16.0")).toBe(true)
  expect(benchmarkVersionIsCurrent("5.15.0", "5.16.0")).toBe(false)
  expect(benchmarkVersionIsCurrent("5.15.3", "5.16.0")).toBe(false)
  expect(benchmarkVersionIsCurrent("5.99.0", "6.0.0")).toBe(false)
})
