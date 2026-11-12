import { describe, expect, test } from "bun:test"
import { ciRunOutput, forRuntime, type SsrRuntime } from "../ssr/matrix.ts"
import { ALL_TABLE_SECTIONS } from "../ssr/targets.ts"
import { formatInterval, renderHeadline, renderSection } from "./render.ts"
import {
  type CiReport,
  parseCiReport,
  parseRunOutput,
  type RunOutput,
  rivalRow,
  summarize,
  unsettledRows,
} from "./report.ts"

const GET = "GET /users/:id"

/** A run whose rows' req/s are `ratio x ceiling` each round; `ceilingRps` sets the absolute level. */
function run(
  ceilingRps: readonly number[],
  ratios: Readonly<Record<string, readonly number[]>>,
): RunOutput {
  const rows: Record<
    string,
    Record<string, { rounds: { rps: number; p50ms: number; p99ms: number }[] }>
  > = {
    "bun-native": { [GET]: { rounds: ceilingRps.map((rps) => ({ rps, p50ms: 1, p99ms: 2 })) } },
  }
  for (const [row, perRound] of Object.entries(ratios)) {
    rows[row] = {
      [GET]: {
        rounds: perRound.map((r, i) => ({ rps: r * (ceilingRps[i] ?? 0), p50ms: 1, p99ms: 2 })),
      },
    }
  }
  return {
    meta: { bun: "1.4.3", oha: "1.16.0", rounds: ceilingRps.length },
    results: { bun: rows },
    ceilings: { bun: { [GET]: "bun-native" } },
  }
}

const steady = (r: number): number[] => [r, r + 0.01, r - 0.01, r]

function report(runs: readonly RunOutput[], maxCiWidthPts = 10): CiReport {
  return {
    suite: "http",
    runtime: "bun",
    settings: { minRuns: 3, maxRuns: 5, maxCiWidthPts },
    host: {
      cpuModel: "Test CPU",
      cpus: 4,
      split: { server: [0, 1], load: [2, 3], cores: 2 },
      steal: [0.001, null],
    },
    runs,
  }
}

describe("parseRunOutput", () => {
  test("keeps the rounds of a run.ts line and drops its precomputed medians", () => {
    const line = {
      meta: { bun: "1.4.3", rounds: 1 },
      results: {
        bun: {
          nifra: { [GET]: { rps: 9, ofCeiling: 0.9, rounds: [{ rps: 9, p50ms: 1, p99ms: 2 }] } },
        },
      },
      ceilings: { bun: { [GET]: "bun-native" } },
    }
    expect(parseRunOutput(JSON.parse(JSON.stringify(line)))).toEqual({
      meta: { bun: "1.4.3", rounds: 1 },
      results: { bun: { nifra: { [GET]: { rounds: [{ rps: 9, p50ms: 1, p99ms: 2 }] } } } },
      ceilings: { bun: { [GET]: "bun-native" } },
    })
  })

  test("names the field that breaks the shape", () => {
    const good = run([100], { nifra: [0.9] })
    expect(() => parseRunOutput({ ...good, ceilings: undefined })).toThrow("run.ceilings")
    expect(() =>
      parseRunOutput({
        ...good,
        results: { bun: { nifra: { [GET]: { rounds: [{ rps: "9" }] } } } },
      }),
    ).toThrow(`run.results.bun.nifra.${GET}.rounds[0].rps`)
    expect(() => parseRunOutput({ ...good, meta: { bun: true } })).toThrow("run.meta.bun")
  })
})

describe("summarize", () => {
  test("ratios pair inside each run, so a run on a slower host moves no percentage", () => {
    const fast = run([100_000, 100_000, 100_000, 100_000], {
      nifra: steady(0.98),
      elysia: steady(0.96),
    })
    const slow = run([50_000, 52_000, 49_000, 51_000], {
      nifra: steady(0.98),
      elysia: steady(0.96),
    })
    const [w] = summarize([fast, slow, fast], "bun", 10)
    expect(w?.ceiling).toBe("bun-native")
    expect(w?.nifra).toBe("nifra")
    expect(w?.rows.map((r) => r.row)).toEqual(["bun-native", "nifra", "elysia"])
    const nifra = w?.rows.find((r) => r.row === "nifra")
    const elysia = w?.rows.find((r) => r.row === "elysia")
    expect(nifra?.ofCeiling?.median).toBeCloseTo(0.98, 10)
    expect(nifra?.ofCeiling?.n).toBe(12)
    expect(nifra?.nifraOver).toBeUndefined()
    expect(elysia?.nifraOver?.median).toBeCloseTo(0.98 / 0.96, 2)
    expect(w?.rows.every((r) => r.verdict === "ok")).toBe(true)
  })

  test("a noisy nifra row counts once, not again through the ceiling row", () => {
    const runs = [1, 2, 3].map(() => run([100, 100, 100, 100], { nifra: [0.7, 1.1, 0.8, 1.2] }))
    const [w] = summarize(runs, "bun", 10)
    const ceiling = w?.rows.find((r) => r.row === "bun-native")
    expect(ceiling?.nifraOver).toBeUndefined()
    expect(ceiling?.verdict).toBe("ok")
    expect(w?.rows.find((r) => r.row === "nifra")?.verdict).toBe("noisy")
    expect(unsettledRows(summarize(runs, "bun", 10))).toBe(1)
  })

  test("a row whose interval is wider than the limit is noisy, and too few rounds is its own verdict", () => {
    const swinging = [0.7, 1.1, 0.8, 1.2]
    const runs = [1, 2, 3].map(() =>
      run([100, 100, 100, 100], { nifra: steady(0.98), hono: swinging }),
    )
    const [w] = summarize(runs, "bun", 10)
    expect(w?.rows.find((r) => r.row === "hono")?.verdict).toBe("noisy")
    expect(w?.rows.find((r) => r.row === "nifra")?.verdict).toBe("ok")
    expect(unsettledRows(summarize(runs, "bun", 10))).toBe(1)
    expect(unsettledRows(summarize(runs, "bun", 60))).toBe(0)

    const [one] = summarize([run([100, 100, 100, 100], { nifra: steady(0.98) })], "bun", 10)
    expect(one?.rows.map((r) => r.verdict)).toEqual(["too few rounds", "too few rounds"])
  })

  test("the rival keeps nifra's row suffix", () => {
    expect(rivalRow("bun", "nifra")).toBe("elysia")
    expect(rivalRow("node", "nifra-body")).toBe("fastify-body")
  })
})

describe("render", () => {
  const runs = [1, 2, 3].map(() =>
    run([100, 100, 100, 100], {
      nifra: steady(0.98),
      elysia: steady(0.96),
      hono: [0.7, 1.1, 0.8, 1.2],
    }),
  )

  test("formats a median with its interval in percent", () => {
    expect(
      formatInterval({ median: 1.014, lo: 0.981, hi: 1.032, coverage: 0.96, n: 12 }, "%"),
    ).toBe("101% (98-103)")
    expect(formatInterval(undefined)).toBe("-")
  })

  test("a section names the host, bolds nifra and flags the noisy row", () => {
    const md = renderSection(report(runs))
    expect(md).toContain("### http - bun")
    expect(md).toContain(
      "3 runs x 4 rounds - Test CPU - 4 CPUs on 2 cores, servers on 0,1 and oha on 2,3",
    )
    expect(md).toContain("CPU steal up to 0.1%")
    expect(md).toContain("| **nifra** | **98** | **98 (97-99)** | - | ok |")
    expect(md).toContain("| elysia | 96 | 96 (95-97) | 102% (102-102) | ok |")
    expect(md).toMatch(/\| hono \| [\d,]+ \| \d+ \(\d+-\d+\) \| \d+% \(\d+-\d+\) \| noisy \|/)
    expect(md).toContain("1 row(s) still noisy after 3 of at most 5 runs")
  })

  test("the headline compares nifra with the runtime's rival", () => {
    expect(renderHeadline([report(runs)])).toContain(
      `| http | bun | ${GET} | 98 | 98 (97-99) | 96 | 102% (102-102) vs elysia | 1 |`,
    )
  })

  test("a report survives the JSON round trip the summary job makes", () => {
    const r = report(runs)
    expect(parseCiReport(JSON.parse(JSON.stringify(r)))).toEqual(r)
    expect(() => parseCiReport({ ...r, runtime: "workerd" })).toThrow("runtime")
  })
})

describe("ssr reports", () => {
  /** Each row samples `rps(row, round)`; every table runs on `runtime` as its CI job would. */
  function ssrRun(runtime: SsrRuntime, rps: (row: string, round: number) => number): RunOutput {
    const tables = ALL_TABLE_SECTIONS.map((s) => forRuntime(s, runtime)).map((section) => ({
      section,
      rounds: Object.fromEntries(
        section.targets.map((t) => [
          t.name,
          [0, 1, 2, 3].map((round) => ({ rps: rps(t.name, round), p50ms: 1, p99ms: 2 })),
        ]),
      ),
    }))
    const meta = { bun: "1.4.3", node: "v26.12.0", oha: "1.16.0", rounds: 4 }
    // Through JSON and back, as bench/ci/run.ts reads the line.
    return parseRunOutput(JSON.parse(JSON.stringify(ciRunOutput(runtime, tables, meta))))
  }

  /** nifra at 1000 req/s, every other row at a share of it that wobbles by 1% a round. */
  const SHARE: Readonly<Record<string, number>> = {
    "next (dynamic)": 0.1,
    remix: 0.2,
    "next (ISR)": 0.25,
    "preact-ssr": 1.25,
  }
  const shares = (row: string, round: number): number =>
    (row.startsWith("nifra+") && !row.includes("static host") ? 1000 : 1000 * (SHARE[row] ?? 0.5)) *
    (1 + (round % 2) * 0.01)

  const REACT_A = "React - Table A (uncached SSR)"
  const ISR_NODE = "React - Table B (cacheable): nifra+react (ISR, node)"
  const PREACT_A = "Preact - Table A (uncached SSR)"

  function ssrReport(runtime: SsrRuntime, runs: readonly RunOutput[]): CiReport {
    return { ...report(runs), suite: "ssr", runtime }
  }

  test("a run line keeps its roles, and a malformed role names its field", () => {
    const line = ssrRun("node", shares)
    expect(line.roles?.node?.[REACT_A]).toEqual({
      nifra: "nifra+react (node)",
      rival: "next (dynamic)",
    })
    expect(line.roles?.node?.[PREACT_A]).toEqual({ nifra: "nifra+preact (node)" })
    // bench:ssr divides every row by the table's baseline, so that row is the ceiling.
    expect(line.ceilings.node?.[REACT_A]).toBe("next (dynamic)")
    expect(() => parseRunOutput({ ...line, roles: { node: { [REACT_A]: { nifra: 1 } } } })).toThrow(
      `run.roles.node.${REACT_A}.nifra`,
    )
  })

  test("a table's baseline is its ceiling, so % of ceiling is bench:ssr's ratio", () => {
    const runs = [1, 2, 3].map(() => ssrRun("node", shares))
    const w = summarize(runs, "node", 10).find((s) => s.workload === REACT_A)
    expect(w?.ceiling).toBe("next (dynamic)")
    expect(w?.nifra).toBe("nifra+react (node)")
    expect(w?.rival).toBe("next (dynamic)")
    expect(w?.rows.map((r) => r.row)).toEqual(["nifra+react (node)", "remix", "next (dynamic)"])
    expect(w?.rows.every((r) => r.verdict === "ok")).toBe(true)
    expect(w?.rows[0]?.ofCeiling?.median).toBeCloseTo(10, 6)
    expect(w?.rows[1]?.nifraOver?.median).toBeCloseTo(5, 6)
    expect(w?.rows[1]?.nifraOver?.n).toBe(12)
  })

  test("nifra's ISR row is compared with the rival's ISR row, under the static host ceiling", () => {
    const runs = [1, 2, 3].map(() => ssrRun("node", shares))
    const w = summarize(runs, "node", 10).find((s) => s.workload === ISR_NODE)
    expect([w?.nifra, w?.rival, w?.ceiling]).toEqual([
      "nifra+react (ISR, node)",
      "next (ISR)",
      "nifra+react (SSG files, static host)",
    ])
    expect(w?.rows.find((r) => r.row === "next (ISR)")?.nifraOver?.median).toBeCloseTo(4, 6)
    expect(w?.rows.find((r) => r.row === w?.nifra)?.ofCeiling?.median).toBeCloseTo(2, 6)
  })

  test("the raw renderer is Preact's ceiling, and its headline names no rival", () => {
    const runs = [1, 2, 3].map(() => ssrRun("bun", shares))
    const r = ssrReport("bun", runs)
    const w = summarize(runs, "bun", 10).find((s) => s.workload === PREACT_A)
    expect([w?.ceiling, w?.rival]).toEqual(["preact-ssr", undefined])
    expect(w?.rows.find((row) => row.row === "nifra+preact")?.ofCeiling?.median).toBeCloseTo(0.8, 6)
    const headline = renderHeadline([r])
    expect(headline).toContain(`| ssr | bun | ${PREACT_A} | 1,005 | 80 (80-80) | - | - | 0 |`)
    expect(headline).toContain(
      `| ssr | bun | ${REACT_A} | 1,005 | 1000 (1000-1000) | 101 | 1000% (1000-1000) vs next (dynamic) | 0 |`,
    )
    expect(unsettledRows(summarize(runs, "bun", 10))).toBe(0)
  })

  test("a section says which runtime nifra ran on and marks a table without a rival", () => {
    const md = renderSection(
      ssrReport(
        "node",
        [1, 2, 3].map(() => ssrRun("node", shares)),
      ),
    )
    expect(md).toContain("### ssr - node")
    expect(md).toContain("nifra runs on node; the rival apps run on node in both ssr jobs")
    expect(md).toContain(`**${REACT_A}** (ceiling: next (dynamic))`)
    expect(md).toContain("| **nifra+react (node)** | **1,005** | **1000 (1000-1000)** | - | ok |")
    expect(md).toContain("| remix | 201 | 200 (200-200) | 500% (500-500) | ok |")
  })

  test("an ssr report survives the summary job's round trip; ssr has no deno job", () => {
    const r = ssrReport("node", [ssrRun("node", shares)])
    expect(parseCiReport(JSON.parse(JSON.stringify(r)))).toEqual(r)
    expect(() => parseCiReport({ ...r, runtime: "deno" })).toThrow(
      "runtime: expected one of bun, node",
    )
  })
})
