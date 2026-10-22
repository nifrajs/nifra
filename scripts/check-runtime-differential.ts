#!/usr/bin/env bun
/**
 * The runtime differential: one app served on every runtime nifra supports, the same generated
 * requests sent to each, every answer held to the invariants in `runtime-differential/oracle.ts` and
 * to each other.
 *
 * A run has two phases. The first sends `--runs` generated cases and files every violation under a
 * signature, so one run reports every distinct failure instead of stopping at the first. The second
 * replays the first case of each signature from its fast-check path and shrinks it, keeping the
 * signature, to a minimal reproduction printed with a `--replay` command.
 *
 *   bun scripts/check-runtime-differential.ts --runs 300
 *   bun scripts/check-runtime-differential.ts --seed 42 --lanes bun-serve,node
 *   bun scripts/check-runtime-differential.ts --replay '<case JSON printed by a failing run>'
 *   bun scripts/check-runtime-differential.ts --expose F7   # report an open finding, shrunk
 *
 * Node and Deno load the built `dist`: run `bun run build` first.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import fc from "fast-check"
import { type Case, caseArbitrary, parseCase } from "./runtime-differential/arbitraries.ts"
import {
  isLaneName,
  LANE_NAMES,
  type Lane,
  type LaneName,
  startBunFetch,
  startBunServe,
  startDeno,
  startNode,
  startWorkerd,
  writePublicDir,
} from "./runtime-differential/lanes.ts"
import { groups, judge, unknownStderr, type Violation } from "./runtime-differential/oracle.ts"
import type { Outcome } from "./runtime-differential/wire.ts"

/** An environment default, where an empty value (a workflow input left blank) means unset. */
const env = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : value
}

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: env("NIFRA_DIFFERENTIAL_RUNS") ?? "200" },
    seed: { type: "string", default: env("NIFRA_DIFFERENTIAL_SEED") },
    lanes: { type: "string", default: env("NIFRA_DIFFERENTIAL_LANES") ?? LANE_NAMES.join(",") },
    mode: { type: "string", default: env("NIFRA_DIFFERENTIAL_MODE") ?? "production" },
    "deadline-ms": { type: "string", default: "10000" },
    "max-findings": { type: "string", default: "20" },
    "shrink-ms": { type: "string", default: "60000" },
    report: { type: "string", default: env("NIFRA_DIFFERENTIAL_REPORT") },
    replay: { type: "string" },
    expose: { type: "string", default: env("NIFRA_DIFFERENTIAL_EXPOSE") ?? "" },
  },
})

const mode = values.mode
if (mode !== "production" && mode !== "development")
  throw new Error(`--mode must be production or development, got ${mode}`)
// Read at call time by the app's own guards, so it must be set before the first request, in this
// process (Bun's lanes) and in every child.
process.env.NODE_ENV = mode
const runs = Number(values.runs)
const exposed = new Set(
  values.expose
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== ""),
)
const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(values.seed)
const deadlineMs = Number(values["deadline-ms"])
const maxFindings = Number(values["max-findings"])
const shrinkMs = Number(values["shrink-ms"])
const wanted: LaneName[] = []
for (const lane of values.lanes.split(",").map((name) => name.trim())) {
  if (lane === "") continue
  if (!isLaneName(lane)) throw new Error(`unknown lane ${lane}; known: ${LANE_NAMES.join(", ")}`)
  wanted.push(lane)
}

const publicDir = mkdtempSync(join(tmpdir(), "nifra-differential-"))
writePublicDir(publicDir)

const starters: Record<LaneName, () => Promise<Lane>> = {
  "bun-fetch": () => startBunFetch(publicDir),
  "bun-serve": () => startBunServe(publicDir),
  node: () => startNode(publicDir, mode),
  deno: () => startDeno(publicDir, mode),
  workerd: () => startWorkerd(),
}

const started = await Promise.allSettled(wanted.map((lane) => starters[lane]()))
const lanes = started.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
const startFailures = started.flatMap((result, at) =>
  result.status === "rejected"
    ? [
        `${wanted[at]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      ]
    : [],
)

async function shutdown(): Promise<void> {
  await Promise.allSettled(lanes.map((lane) => lane.stop()))
  rmSync(publicDir, { recursive: true, force: true })
}

if (startFailures.length > 0) {
  await shutdown()
  console.error(`could not start every lane:\n${startFailures.join("\n")}`)
  process.exit(1)
}

/** Send one case to every lane at once, then judge it - runtime faults included. */
async function run(testCase: Case): Promise<{
  outcomes: Map<LaneName, Outcome>
  violations: Violation[]
  excusedBy: readonly string[]
}> {
  const excusedBy: string[] = []
  // A lane with no answer in time is asked once more, so only a hang that repeats is a finding: a
  // loaded machine or the local dev proxy stalling once is not.
  const answered = await Promise.all(
    lanes.map(async (lane) => {
      const first = await lane.send(testCase.request, deadlineMs)
      if (first.kind !== "timeout") return [lane.name, first] as const
      const second = await lane.send(testCase.request, deadlineMs)
      if (second.kind !== "timeout") excusedBy.push("answered when asked again")
      return [lane.name, second] as const
    }),
  )
  const outcomes = new Map<LaneName, Outcome>(answered)
  const judged = judge(testCase, outcomes, exposed)
  const violations = [...judged.violations]
  excusedBy.push(...judged.excusedBy)
  for (const lane of lanes) {
    const fault = lane.fault()
    if (fault !== undefined) {
      violations.push({
        kind: "runtime-fault",
        signature: `runtime-fault ${testCase.route} [${lane.name}] exit`,
        lanes: [lane.name],
        detail: `${lane.name}: ${fault.slice(0, 2000)}`,
      })
    }
    const { rest, known } = unknownStderr(lane.name, lane.stderr())
    excusedBy.push(...known)
    // Output arrives on its own clock, often a case late, so its signature does not name a route.
    if (rest !== "") {
      violations.push({
        kind: "runtime-fault",
        signature: `runtime-fault [${lane.name}] stderr`,
        lanes: [lane.name],
        detail: `${lane.name} wrote to stderr: ${rest.slice(0, 2000)}`,
      })
    }
  }
  return { outcomes, violations, excusedBy }
}

function describe(testCase: Case): string {
  return JSON.stringify(testCase)
}

function outcomeSummary(outcomes: Map<LaneName, Outcome>): string {
  return groups(outcomes)
    .map(
      (group) =>
        `  [${group.lanes.join(", ")}]\n${group.key
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")
          .slice(0, 1500)}`,
    )
    .join("\n")
}

if (values.replay !== undefined) {
  const testCase = parseCase(values.replay)
  const { outcomes, violations } = await run(testCase)
  console.log(outcomeSummary(outcomes))
  for (const violation of violations) console.log(`\n${violation.signature}\n${violation.detail}`)
  await shutdown()
  process.exit(violations.length === 0 ? 0 : 1)
}

interface Bucket {
  readonly signature: string
  readonly kind: Violation["kind"]
  readonly firstRun: number
  /** The violation as first seen, for a signature that does not come back on replay. */
  readonly firstDetail: string
  readonly firstCase: Case
  count: number
}

console.log(
  `runtime differential: ${runs} runs, seed ${seed}, mode ${mode}, lanes ${lanes.map((lane) => lane.name).join(", ")}`,
)
const buckets = new Map<string, Bucket>()
const excusals = new Map<string, number>()
let runIndex = 0
const started_at = performance.now()
await fc.check(
  fc.asyncProperty(caseArbitrary, async (testCase) => {
    const at = runIndex++
    const { violations, excusedBy } = await run(testCase)
    for (const id of excusedBy) excusals.set(id, (excusals.get(id) ?? 0) + 1)
    for (const violation of violations) {
      const bucket = buckets.get(violation.signature)
      if (bucket === undefined)
        buckets.set(violation.signature, {
          signature: violation.signature,
          kind: violation.kind,
          firstRun: at,
          firstDetail: violation.detail,
          firstCase: testCase,
          count: 1,
        })
      else bucket.count++
    }
    return true
  }),
  { seed, numRuns: runs },
)
const exploreSeconds = ((performance.now() - started_at) / 1000).toFixed(1)
console.log(
  `phase 1: ${runIndex} cases in ${exploreSeconds} s, ${buckets.size} distinct violation signatures`,
)
for (const [id, count] of excusals) console.log(`  excused by ${id}: ${count}`)

interface Finding {
  readonly signature: string
  readonly kind: Violation["kind"]
  readonly count: number
  readonly shrunk: Case | undefined
  readonly violations: readonly Violation[]
  readonly outcomes: string
  readonly report: string
}

const findings: Finding[] = []
const ordered = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, maxFindings)
for (const bucket of ordered) {
  const details = await fc.check(
    fc.asyncProperty(caseArbitrary, async (testCase) => {
      const { violations } = await run(testCase)
      return !violations.some((violation) => violation.signature === bucket.signature)
    }),
    {
      seed,
      path: String(bucket.firstRun),
      numRuns: 1,
      interruptAfterTimeLimit: shrinkMs,
      markInterruptAsFailure: false,
    },
  )
  const shrunk = details.counterexample?.[0]
  if (shrunk === undefined) {
    findings.push({
      signature: bucket.signature,
      kind: bucket.kind,
      count: bucket.count,
      shrunk: undefined,
      violations: [],
      outcomes: `did not reproduce on replay. First seen on ${describe(bucket.firstCase)}:\n${bucket.firstDetail}`,
      report: "",
    })
    continue
  }
  const { outcomes, violations } = await run(shrunk)
  findings.push({
    signature: bucket.signature,
    kind: bucket.kind,
    count: bucket.count,
    shrunk,
    violations: violations.filter((violation) => violation.signature === bucket.signature),
    outcomes: outcomeSummary(outcomes),
    report: fc.defaultReportMessage(details) ?? "",
  })
}

for (const finding of findings) {
  console.log(`\n=== ${finding.signature}  (${finding.count} of ${runIndex} cases)`)
  if (finding.shrunk === undefined) {
    console.log(finding.outcomes)
    continue
  }
  console.log(`shrunk case: ${describe(finding.shrunk)}`)
  for (const violation of finding.violations) console.log(violation.detail)
  console.log(finding.outcomes)
  console.log(
    `replay: bun scripts/check-runtime-differential.ts --mode ${mode} --replay '${describe(finding.shrunk).replaceAll("'", "'\\''")}'`,
  )
}

if (values.report !== undefined) {
  writeFileSync(
    values.report,
    `${JSON.stringify({ seed, runs: runIndex, mode, lanes: lanes.map((lane) => lane.name), excusals: Object.fromEntries(excusals), signatures: [...buckets.values()], findings }, null, 2)}\n`,
  )
}

await shutdown()
if (buckets.size > 0) {
  console.error(
    `\nruntime differential failed: ${buckets.size} distinct violation signature(s); seed ${seed}`,
  )
  process.exit(1)
}
console.log("runtime differential passed")
