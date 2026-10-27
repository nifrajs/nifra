import { expect, test } from "bun:test"
import { compareCounts, countFamilies, findFamilies, WINDOW } from "./check-clones.ts"

const block = (
  name: string,
): string => `export function ${name}(input: { a: number; b: number; c: string }) {
  const total = input.a + input.b * 2 - input.a / 3
  if (total > 10 && input.c.length > 0) return { total, label: input.c.toUpperCase() }
  for (let i = 0; i < input.b; i++) console.log(i, input.a, input.c)
  return { total: total - 1, label: input.c.slice(0, 2) }
}
`

test("a block copied between two files of one package is one family", () => {
  const families = findFamilies([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/alpha/src/two.ts", text: `const unrelated = 1\n${block("second")}` },
  ])
  expect(families).toHaveLength(1)
  const [family] = families
  expect(family?.pkg).toBe("alpha")
  expect(family?.weight).toBeGreaterThanOrEqual(WINDOW)
  expect(family?.members.map((member) => member.path)).toEqual([
    "packages/alpha/src/one.ts",
    "packages/alpha/src/two.ts",
  ])
  expect(family?.members[1]?.firstLine).toBe(2)
})

test("a copy in another package is not counted", () => {
  const families = findFamilies([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/beta/src/one.ts", text: block("second") },
  ])
  expect(families).toEqual([])
})

test("shared import lists are not copies", () => {
  const names = Array.from({ length: 40 }, (_, i) => `name${i}`).join(", ")
  const imports = `import { ${names} } from "./names.ts"\nexport { ${names} } from "./names.ts"\n`
  const families = findFamilies([
    { path: "packages/alpha/src/one.ts", text: `${imports}export const one = 1\n` },
    { path: "packages/alpha/src/two.ts", text: `${imports}export const two = 2\n` },
  ])
  expect(families).toEqual([])
})

test("counts add up per package and compare both ways", () => {
  const counts = countFamilies(
    findFamilies([
      { path: "packages/alpha/src/one.ts", text: block("first") },
      { path: "packages/alpha/src/two.ts", text: block("second") },
      { path: "packages/alpha/src/three.ts", text: block("third") },
    ]),
  )
  expect(Object.keys(counts)).toEqual(["alpha"])
  expect(compareCounts({ alpha: 1, gone: 5 }, counts)).toEqual({
    increased: [{ pkg: "alpha", was: 1, now: counts.alpha ?? 0 }],
    decreased: [{ pkg: "gone", was: 5, now: 0 }],
  })
})
