import { expect, test } from "bun:test"
import { checkPublicReleaseFreshness } from "./check-public-release-freshness.ts"

test("public release metadata is current", () => {
  expect(checkPublicReleaseFreshness()).toEqual([])
})
