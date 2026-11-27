import { describe, expect, test } from "bun:test"
import { commentBlockExpectation } from "../src/rules/comment-markers.ts"

const expectation = (text: string) => commentBlockExpectation(text.split("\n"), 2, ["NF-C064"])

describe("commentBlockExpectation reasons", () => {
  test("reads the reason after the colon in each comment form", () => {
    expect(expectation("// nifra-expect NF-C064: kept\nx")).toEqual({ reason: "kept" })
    expect(expectation("/* nifra-expect NF-C064: kept */\nx")).toEqual({ reason: "kept" })
    expect(expectation("{/* nifra-expect NF-C064: kept */}\nx")).toEqual({ reason: "kept" })
  })

  test("a marker with nothing after its colon has no reason, whatever closes the comment", () => {
    for (const marker of [
      "// nifra-expect NF-C064:",
      "/* nifra-expect NF-C064: */",
      "{/* nifra-expect NF-C064: */}",
      "{/* nifra-expect NF-C064:*/}  ",
    ])
      expect(expectation(`${marker}\nx`)).toEqual({ reason: undefined })
  })

  test("a marker for another code, or after a blank line, is not found", () => {
    expect(expectation("// nifra-expect NF-C065: kept\nx")).toBeUndefined()
    expect(
      commentBlockExpectation(["// nifra-expect NF-C064: kept", "", "x"], 3, ["NF-C064"]),
    ).toBeUndefined()
  })
})
