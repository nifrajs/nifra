import { describe, expect, test } from "bun:test"
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
    expect(md).toContain("| **nifra** | **98 (97-99)** | - | ok |")
    expect(md).toContain("| elysia | 96 (95-97) | 102% (102-102) | ok |")
    expect(md).toMatch(/\| hono \| \d+ \(\d+-\d+\) \| \d+% \(\d+-\d+\) \| noisy \|/)
    expect(md).toContain("1 row(s) still noisy after 3 of at most 5 runs")
  })

  test("the headline compares nifra with the runtime's rival", () => {
    expect(renderHeadline([report(runs)])).toContain(
      `| http | bun | ${GET} | 98 (97-99) | 102% (102-102) vs elysia | 1 |`,
    )
  })

  test("a report survives the JSON round trip the summary job makes", () => {
    const r = report(runs)
    expect(parseCiReport(JSON.parse(JSON.stringify(r)))).toEqual(r)
    expect(() => parseCiReport({ ...r, runtime: "workerd" })).toThrow("runtime")
  })
})
