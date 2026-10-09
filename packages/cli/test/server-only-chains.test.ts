import { describe, expect, test } from "bun:test"
import { createServerOnlyChains } from "../src/check-scan.ts"

/** A fake project: `files` by path, `../x` specifiers resolve to `x.ts`, and every read is counted. */
function graph(files: Record<string, string>) {
  let reads = 0
  const resolve = (_from: string, specifier: string): string | undefined => {
    const path = `${specifier.replace(/^(?:\.\.?\/)+/, "")}.ts`
    return files[path] === undefined ? undefined : path
  }
  const read = (path: string): string | undefined => {
    reads += 1
    return files[path]
  }
  return { chains: createServerOnlyChains({ resolve, read }), reads: () => reads }
}

describe("server-only chains", () => {
  test("a sink past 200 modules or 8 hops is still found", () => {
    const wide: Record<string, string> = {}
    const exports: string[] = []
    for (let i = 0; i < 250; i++) {
      wide[`lib/m${i}.ts`] = i === 249 ? 'import "node:fs"\n' : "export {}\n"
      exports.push(`export * from "../lib/m${i}"`)
    }
    wide["lib/barrel.ts"] = exports.join("\n")
    const barrel = graph(wide).chains("routes/index.tsx", 'import "../lib/barrel"\n')
    expect(barrel.map((finding) => finding.chain)).toEqual([
      ["routes/index.tsx", "../lib/barrel", "../lib/m249", "node:fs"],
    ])

    const deep: Record<string, string> = {}
    for (let i = 0; i < 12; i++)
      deep[`lib/d${i}.ts`] = i === 11 ? 'import "node:fs"\n' : `import "../lib/d${i + 1}"\n`
    const chain = graph(deep).chains("routes/index.tsx", 'import "../lib/d0"\n')[0]?.chain
    expect(chain).toHaveLength(14)
    expect(chain?.at(-1)).toBe("node:fs")
  })

  test("each module is read once however many routes share it", () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 250; i++)
      files[`lib/m${i}.ts`] = i < 249 ? `import "../lib/m${i + 1}"\n` : "export {}\n"
    const project = graph(files)
    for (let route = 0; route < 400; route++)
      expect(project.chains(`routes/r${route}.tsx`, `import "../lib/m${route % 250}"\n`)).toEqual(
        [],
      )
    expect(project.reads()).toBe(250)
  })
})
