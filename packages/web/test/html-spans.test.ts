import { expect, test } from "bun:test"
import { delimitedSpans, withoutComments } from "../src/internal/html-spans.ts"

/** Every string of up to `length` tokens drawn from `tokens`. */
const strings = (tokens: readonly string[], length: number): string[] => {
  let level = [""]
  const all = [""]
  for (let size = 0; size < length; size++) {
    level = level.flatMap((prefix) => tokens.map((token) => prefix + token))
    all.push(...level)
  }
  return all
}

test("withoutComments removes what the lazy comment pattern removes", () => {
  for (const source of strings(["<!--", "-->", "--!>", "--", "-", "!", ">", "<", "x"], 4)) {
    expect(withoutComments(source)).toBe(source.replace(/<!--[\s\S]*?--!?>/g, ""))
  }
})

test("delimitedSpans reads what the lazy span pattern captures", () => {
  for (const source of strings(["{{", "}}", "{", "}", "x"], 6)) {
    expect(delimitedSpans(source, "{{", "}}")).toEqual(
      [...source.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((match) => match[1] ?? ""),
    )
  }
})
