import { describe, expect, test } from "bun:test"
import { VERSION } from "../src/index.ts"

describe("@nifrajs/core", () => {
  test("exposes a semver-shaped VERSION", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
