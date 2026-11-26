import { describe, expect, test } from "bun:test"
import { onlyWorkloads, selectWorkloads } from "../selection.ts"
import { ciRunOutput, ciWorkloads, forRuntime, SSR_RUNTIMES, sectionsMeasuring } from "./matrix.ts"
import { ALL_TABLE_SECTIONS } from "./targets.ts"

const rounds = (name: string) => [{ rps: name.length, p50ms: 1, p99ms: 2 }]
const tables = ALL_TABLE_SECTIONS.map((section) => ({
  section,
  rounds: Object.fromEntries(section.targets.map((t) => [t.name, rounds(t.name)])),
}))

describe("one run, a report per runtime", () => {
  test("each report is what a run of that runtime alone would have written", () => {
    for (const runtime of SSR_RUNTIMES) {
      const alone = tables.map((t) => ({ ...t, section: forRuntime(t.section, runtime) }))
      expect(ciRunOutput(runtime, tables, {})).toEqual(ciRunOutput(runtime, alone, {}))
    }
  })

  test("a rerun picks the tables that feed a noisy workload on either runtime", () => {
    for (const runtime of SSR_RUNTIMES) {
      for (const section of ALL_TABLE_SECTIONS) {
        for (const { workload } of ciWorkloads(forRuntime(section, runtime))) {
          const picked = sectionsMeasuring(ALL_TABLE_SECTIONS, SSR_RUNTIMES, new Set([workload]))
          expect(picked.map((s) => s.label)).toContain(section.label)
          // A workload names one framework and table; a rerun never drags in another.
          expect(picked.every((s) => workload.startsWith(s.label))).toBe(true)
        }
      }
    }
  })

  test("a workload no table has stops the rerun instead of measuring nothing", () => {
    expect(() => sectionsMeasuring(ALL_TABLE_SECTIONS, SSR_RUNTIMES, new Set(["nope"]))).toThrow(
      /nope/,
    )
  })
})

describe("workload selection", () => {
  const all = [{ name: "a" }, { name: "b" }]

  test("everything without a selection, only the named ones with it", () => {
    expect(selectWorkloads(all, onlyWorkloads(""))).toEqual(all)
    expect(selectWorkloads(all, onlyWorkloads('["b"]'))).toEqual([{ name: "b" }])
  })

  test("a selection that is not a list of names is refused", () => {
    for (const raw of ["[]", "{}", "[1]", '"a"', "a"]) expect(() => onlyWorkloads(raw)).toThrow()
  })
})
