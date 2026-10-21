import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CiReport, RunOutput, Suite } from "./report.ts"

const dir = mkdtempSync(join(tmpdir(), "bench-ci-summary-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rounds = (rps: number) => ({ rounds: [1, 2, 3, 4].map(() => ({ rps, p50ms: 1, p99ms: 2 })) })

function report(suite: Suite, run: RunOutput): CiReport {
  return {
    suite,
    runtime: "node",
    settings: { minRuns: 2, maxRuns: 2, maxCiWidthPts: 10 },
    host: { cpuModel: null, cpus: 4, split: null, steal: [null, null] },
    // Two runs of four rounds: six is the fewest samples a 95% interval takes.
    runs: [run, run],
  }
}

writeFileSync(
  join(dir, "http-node.json"),
  JSON.stringify(
    report("http", {
      meta: { rounds: 4 },
      results: {
        node: { "node-native": { "GET /": rounds(100) }, nifra: { "GET /": rounds(95) } },
      },
      ceilings: { node: { "GET /": "node-native" } },
    }),
  ),
)
writeFileSync(
  join(dir, "ssr-node.json"),
  JSON.stringify(
    report("ssr", {
      meta: { rounds: 4 },
      results: { node: { "nifra+vue (node)": { Vue: rounds(300) }, nuxt: { Vue: rounds(100) } } },
      ceilings: { node: {} },
      roles: { node: { Vue: { nifra: "nifra+vue (node)", rival: "nuxt" } } },
    }),
  ),
)

function summary(...args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "summary.ts"), dir, ...args])
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  }
}

describe("summary.ts", () => {
  test("renders ssr rows after http's and lists every job that left no report", () => {
    const { code, out } = summary()
    expect(code).toBe(0)
    expect(out).toContain("| http | node | GET / | 95 (95-95) | - | 0 |")
    expect(out).toContain("| ssr | node | Vue | - | 300% (300-300) vs nuxt | 0 |")
    expect(out.indexOf("### http - node")).toBeLessThan(out.indexOf("### ssr - node"))
    expect(out).toContain(
      "No report from: http-bun, http-deno, realworld-bun, realworld-node, realworld-deno, ssr-bun (",
    )
  })

  test("--suites limits the missing-job list to the suites the workflow ran", () => {
    const { code, out } = summary("--suites", "http,ssr")
    expect(code).toBe(0)
    expect(out).toContain("No report from: http-bun, http-deno, ssr-bun (")
    expect(summary("--suites", "ssr,proxy").err).toContain("--suites takes http, realworld, ssr")
  })
})
