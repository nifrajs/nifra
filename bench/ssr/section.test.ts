import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test"
import type { SsrBenchTarget } from "./harness.ts"
import { assertEveryTargetMeasured, runSection, type SectionSteps } from "./section.ts"
import type { SsrTableSection } from "./targets.ts"

const target = (name: string): SsrBenchTarget => ({
  name,
  runtime: "node",
  build: ["true"],
  serve: ["true"],
  port: 0,
})

const section: SsrTableSection = {
  label: "Fake - Table A (uncached SSR)",
  blurb: "",
  baseline: "base",
  targets: [target("base"), target("broken"), target("flaky")],
}

/** Every row builds and samples 1000 req/s, except the named failures. */
function fakeSteps(fails: { build?: string; measure?: { name: string; sample: number } } = {}) {
  const sampled = new Map<string, number>()
  const steps: SectionSteps = {
    rounds: 3,
    build: async (t) => {
      if (t.name === fails.build) throw new Error("build failed")
    },
    measure: async (t) => {
      const sample = (sampled.get(t.name) ?? 0) + 1
      sampled.set(t.name, sample)
      if (t.name === fails.measure?.name && sample === fails.measure.sample) {
        throw new Error("oha exited 1")
      }
      return { rps: 1000, p50ms: 1, p99ms: 2 }
    },
  }
  return { steps, sampled }
}

let quiet: Mock<typeof console.log>[] = []
beforeEach(() => {
  quiet = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ]
})
afterEach(() => {
  for (const spy of quiet) spy.mockRestore()
})

describe("a failed row fails the run", () => {
  test("every row measured: no failures, and the run passes", async () => {
    const result = await runSection(section, fakeSteps().steps)
    expect(result.failures).toEqual([])
    expect(result.rows.map((r) => r.target.name)).toEqual(["base", "broken", "flaky"])
    expect(() => assertEveryTargetMeasured(result.failures)).not.toThrow()
  })

  test("a row that cannot build is reported, and the run throws", async () => {
    const result = await runSection(section, fakeSteps({ build: "broken" }).steps)
    expect(result.rows.map((r) => r.target.name)).toEqual(["base", "flaky"])
    expect(result.failures).toEqual(["Fake - Table A (uncached SSR) / broken: build failed"])
    expect(() => assertEveryTargetMeasured(result.failures)).toThrow(
      "benchmark results are invalid; Fake - Table A (uncached SSR) / broken: build failed",
    )
  })

  test("a row that fails a round stops sampling, drops out, and the run throws", async () => {
    const { steps, sampled } = fakeSteps({ measure: { name: "flaky", sample: 2 } })
    const result = await runSection(section, steps)
    expect(sampled.get("flaky")).toBe(2)
    expect(sampled.get("base")).toBe(3)
    expect(result.rows.map((r) => r.target.name)).toEqual(["base", "broken"])
    expect(Object.keys(result.samples)).toEqual(["base", "broken"])
    expect(result.failures).toEqual(["Fake - Table A (uncached SSR) / flaky: oha exited 1"])
    expect(() => assertEveryTargetMeasured(result.failures)).toThrow(
      "benchmark results are invalid",
    )
  })

  test("failures from every section are joined into one error", () => {
    expect(() => assertEveryTargetMeasured(["A / x: build failed", "B / y: oha exited 1"])).toThrow(
      "benchmark results are invalid; A / x: build failed; B / y: oha exited 1",
    )
  })
})
