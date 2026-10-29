import { describe, expect, test } from "bun:test"
import type { SsrBenchTarget } from "./harness.ts"
import { ciRunOutput, ciWorkloads, forRuntime, SSR_RUNTIMES, selectSections } from "./matrix.ts"
import { ALL_TABLE_SECTIONS, type SsrTableSection } from "./targets.ts"

const table = (label: string): SsrTableSection => {
  const section = ALL_TABLE_SECTIONS.find((s) => s.label.startsWith(label))
  if (section === undefined) throw new Error(`no table ${label}`)
  return section
}

const names = (targets: readonly SsrBenchTarget[] | undefined): string[] =>
  (targets ?? []).map((t) => t.name)

describe("table filters", () => {
  test("a framework selects both its tables, a table letter only that one, none selects all", () => {
    const labels = (filters: string[]): string[] =>
      selectSections(ALL_TABLE_SECTIONS, filters).map((s) => s.label)
    expect(labels(["react"])).toEqual([
      "React - Table A (uncached SSR)",
      "React - Table B (cacheable)",
    ])
    expect(labels(["vue:A", "Preact:b"])).toEqual([
      "Vue - Table A (uncached SSR)",
      "Preact - Table B (SSG)",
    ])
    expect(labels([])).toHaveLength(ALL_TABLE_SECTIONS.length)
  })

  test("a filter that matches no table throws instead of measuring nothing", () => {
    expect(() => selectSections(ALL_TABLE_SECTIONS, ["react", "vue:C"])).toThrow('"vue:C"')
    expect(() => selectSections(ALL_TABLE_SECTIONS, ["bun"])).toThrow('"bun"')
  })
})

describe("one runtime's tables", () => {
  test("nifra's app rows on the other runtime drop out; rivals and reference rows stay", () => {
    expect(names(forRuntime(table("React - Table B"), "node").targets)).toEqual([
      "nifra+react (SSG, node)",
      "next (static)",
      "nifra+react (ISR, node)",
      "next (ISR)",
      "nifra+react (SSG files, static host)",
    ])
    expect(names(forRuntime(table("Preact - Table A"), "bun").targets)).toEqual([
      "nifra+preact",
      "preact-ssr",
    ])
  })

  test("every table yields a comparison on every runtime, each with one nifra row", () => {
    for (const runtime of SSR_RUNTIMES) {
      for (const section of ALL_TABLE_SECTIONS) {
        const workloads = ciWorkloads(forRuntime(section, runtime))
        expect(workloads.length).toBeGreaterThan(0)
        for (const w of workloads) {
          expect(w.nifra.runtime).toBe(runtime)
          expect(w.rival !== undefined || w.ceiling !== undefined).toBe(true)
        }
      }
    }
  })

  test("Table A compares nifra with the table's rival apps and has no ceiling", () => {
    const [w, ...rest] = ciWorkloads(forRuntime(table("React - Table A"), "node"))
    expect(rest).toEqual([])
    expect(w?.workload).toBe("React - Table A (uncached SSR)")
    expect(w?.nifra.name).toBe("nifra+react (node)")
    expect(w?.rival?.name).toBe("next (dynamic)")
    expect(w?.ceiling).toBeUndefined()
    expect(names(w?.rows)).toEqual(["nifra+react (node)", "next (dynamic)", "remix"])
  })

  test("React Table B splits by serving mode: SSG against static, ISR against ISR", () => {
    const workloads = ciWorkloads(forRuntime(table("React - Table B"), "bun"))
    expect(workloads.map((w) => [w.workload, w.rival?.name, w.ceiling?.name])).toEqual([
      [
        "React - Table B (cacheable): nifra+react (SSG)",
        "next (static)",
        "nifra+react (SSG files, static host)",
      ],
      [
        "React - Table B (cacheable): nifra+react (ISR)",
        "next (ISR)",
        "nifra+react (SSG files, static host)",
      ],
    ])
  })

  test("Preact has a ceiling but no rival app", () => {
    const [a] = ciWorkloads(forRuntime(table("Preact - Table A"), "node"))
    expect([a?.rival, a?.ceiling?.name]).toEqual([undefined, "preact-ssr"])
    const [b] = ciWorkloads(forRuntime(table("Preact - Table B"), "node"))
    expect([b?.rival, b?.ceiling?.name]).toEqual([
      undefined,
      "nifra+preact (SSG files, static host)",
    ])
  })

  test("a rival no nifra row pairs with throws rather than vanish from the report", () => {
    const section = forRuntime(table("React - Table B"), "bun")
    const noIsr = {
      ...section,
      targets: section.targets.filter((t) => t.name !== "nifra+react (ISR)"),
    }
    expect(() => ciWorkloads(noIsr)).toThrow("no nifra row pairs with next (ISR)")
    const noNifra = {
      ...section,
      targets: section.targets.filter((t) => !/^nifra\+react \(/.test(t.name)),
    }
    expect(() => ciWorkloads(noNifra)).toThrow("no nifra row")
  })
})

describe("the --json line", () => {
  const sample = (rps: number) => ({ rps, p50ms: 1, p99ms: 2 })
  const measuredRounds = (section: SsrTableSection) =>
    Object.fromEntries(section.targets.map((t, i) => [t.name, [sample(100 + i), sample(110 + i)]]))

  test("keys every round as results[runtime][row][workload] and names ceilings and roles", () => {
    const sections = [table("React - Table B"), table("Preact - Table A")].map((s) =>
      forRuntime(s, "node"),
    )
    const out = ciRunOutput(
      "node",
      sections.map((section) => ({ section, rounds: measuredRounds(section) })),
      { rounds: 2 },
    )
    const ssg = "React - Table B (cacheable): nifra+react (SSG, node)"
    const isr = "React - Table B (cacheable): nifra+react (ISR, node)"
    const preact = "Preact - Table A (uncached SSR)"
    expect(Object.keys(out.results)).toEqual(["node"])
    expect(out.results.node?.["next (ISR)"]?.[isr]?.rounds).toEqual([sample(103), sample(113)])
    // The static host is in both React Table B comparisons, the same rounds in each.
    expect(Object.keys(out.results.node?.["nifra+react (SSG files, static host)"] ?? {})).toEqual([
      ssg,
      isr,
    ])
    expect(out.ceilings).toEqual({
      node: {
        [ssg]: "next (static)",
        [isr]: "nifra+react (SSG files, static host)",
        [preact]: "preact-ssr",
      },
    })
    expect(out.roles).toEqual({
      node: {
        [ssg]: { nifra: "nifra+react (SSG, node)", rival: "next (static)" },
        [isr]: { nifra: "nifra+react (ISR, node)", rival: "next (ISR)" },
        [preact]: { nifra: "nifra+preact (node)" },
      },
    })
  })

  test("a row without rounds throws", () => {
    const section = forRuntime(table("Vue - Table A"), "bun")
    const rounds = measuredRounds(section)
    delete rounds.nuxt
    expect(() => ciRunOutput("bun", [{ section, rounds }], {})).toThrow("nuxt has no rounds")
  })
})
