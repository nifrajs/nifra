import { expect, test } from "bun:test"
import { compareCounts, findClones, WINDOW } from "./check-clones.ts"

const block = (
  name: string,
): string => `export function ${name}(input: { a: number; b: number; c: string }) {
  const total = input.a + input.b * 2 - input.a / 3
  if (total > 10 && input.c.length > 0) return { total, label: input.c.toUpperCase() }
  for (let i = 0; i < input.b; i++) console.log(i, input.a, input.c)
  return { total: total - 1, label: input.c.slice(0, 2) }
}
`

test("a block copied between two files of one package is one clone, both copies counted", () => {
  const { clones, counts } = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/alpha/src/two.ts", text: `const unrelated = 1\n${block("second")}` },
  ])
  expect(clones).toHaveLength(1)
  const [clone] = clones
  expect(clone?.pkg).toBe("alpha")
  expect(clone?.tokens).toBeGreaterThanOrEqual(WINDOW)
  expect([clone?.a.path, clone?.b.path]).toEqual([
    "packages/alpha/src/one.ts",
    "packages/alpha/src/two.ts",
  ])
  expect(clone?.b.firstLine).toBe(2)
  expect(counts).toEqual({ alpha: 2 * (clone?.tokens ?? 0) })
})

test("a copy in another package is not counted", () => {
  const found = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/beta/src/one.ts", text: block("second") },
  ])
  expect(found).toEqual({ clones: [], counts: {} })
})

test("shared import lists are not copies", () => {
  const names = Array.from({ length: 40 }, (_, i) => `name${i}`).join(", ")
  const imports = `import { ${names} } from "./names.ts"\nexport { ${names} } from "./names.ts"\n`
  const found = findClones([
    { path: "packages/alpha/src/one.ts", text: `${imports}export const one = 1\n` },
    { path: "packages/alpha/src/two.ts", text: `${imports}export const two = 2\n` },
  ])
  expect(found).toEqual({ clones: [], counts: {} })
})

test("a third copy adds its own tokens once, and counts compare both ways", () => {
  const two = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/alpha/src/two.ts", text: block("second") },
  ]).counts
  const three = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/alpha/src/two.ts", text: block("second") },
    { path: "packages/alpha/src/three.ts", text: block("third") },
  ]).counts
  expect((three.alpha ?? 0) * 2).toBe((two.alpha ?? 0) * 3)
  expect(compareCounts({ alpha: 1, gone: 5 }, three)).toEqual({
    increased: [{ pkg: "alpha", was: 1, now: three.alpha ?? 0 }],
    decreased: [{ pkg: "gone", was: 5, now: 0 }],
  })
})
