import { expect, test } from "bun:test"
import { apiReferenceDrift, assertSane, generateApiReference } from "./gen-api-reference.ts"

test("a committed reference that is missing or differs is stale", () => {
  expect(apiReferenceDrift(undefined, "ref\n")).toContain("api-reference.md is stale")
  expect(apiReferenceDrift("", "ref\n")).toContain("api-reference.md is stale")
  expect(apiReferenceDrift("ref", "ref\n")).toContain("api-reference.md is stale")
  expect(apiReferenceDrift("ref\n", "ref\n")).toBeUndefined()
})

test("an empty or gutted generation is refused before it can match an empty file", () => {
  expect(() => assertSane("")).toThrow("generation looks broken")
  expect(() => assertSane("## @nifrajs/core\n")).toThrow("generation looks broken")
})

test("control: the real generation passes the sanity check", () => {
  expect(() => assertSane(generateApiReference())).not.toThrow()
}, 60_000)
