#!/usr/bin/env bun
/**
 * The runtime differential: one app served on every runtime nifra supports, the same generated
 * requests sent to each, every answer held to the invariants in `runtime-differential/oracle.ts` and
 * to each other. Then the same for WebSocket sessions on every lane with a socket, held to
 * `runtime-differential/ws-oracle.ts`.
 *
 * A run has two phases. The first sends `--runs` generated cases and files every violation under a
 * signature, so one run reports every distinct failure instead of stopping at the first. The second
 * replays the first case of each signature from its fast-check path and shrinks it, keeping the
 * signature, to a minimal reproduction printed with a `--replay` command.
 *
 *   bun scripts/check-runtime-differential.ts --runs 300
 *   bun scripts/check-runtime-differential.ts --seed 42 --lanes bun-serve,node
 *   bun scripts/check-runtime-differential.ts --replay '<case JSON printed by a failing run>'
 *   bun scripts/check-runtime-differential.ts --expose U16  # report a waived entry, shrunk
 *   bun scripts/check-runtime-differential.ts --runs 0 --ws-runs 200   # WebSocket sessions only
 *
 * Node and Deno load the built `dist`: run `bun run build` first.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import fc from "fast-check"
import {
  type Case,
  caseArbitrary,
  parseCase,
  parseWsCase,
  wsCaseArbitrary,
} from "./runtime-differential/arbitraries.ts"
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
import { runWsCase, type WsCase, type WsOutcome } from "./runtime-differential/ws.ts"
import { judgeWs, wsGroups } from "./runtime-differential/ws-oracle.ts"

/** An environment default, where an empty value (a workflow input left blank) means unset. */
const env = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : value
}

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: env("NIFRA_DIFFERENTIAL_RUNS") ?? "200" },
    "ws-runs": { type: "string", default: env("NIFRA_DIFFERENTIAL_WS_RUNS") ?? "60" },
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
const wsRuns = Number(values["ws-runs"])
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

/** What one case came to: what it broke, what excused the rest, and the lanes' answers grouped. */
interface Run {
  readonly violations: Violation[]
  readonly excusedBy: readonly string[]
  summary(): string
}

/** A kind of case the run explores: HTTP requests, or WebSocket sessions. */
interface Suite<C> {
  readonly name: string
  readonly arbitrary: fc.Arbitrary<C>
  readonly runs: number
  run(testCase: C): Promise<Run>
}

/** Each lane's crash or unknown stderr since the last case, as violations. */
function laneFaults(route: string): { violations: Violation[]; known: string[] } {
  const violations: Violation[] = []
  const known: string[] = []
  for (const lane of lanes) {
    const fault = lane.fault()
    if (fault !== undefined) {
      violations.push({
        kind: "runtime-fault",
        signature: `runtime-fault ${route} [${lane.name}] exit`,
        lanes: [lane.name],
        detail: `${lane.name}: ${fault.slice(0, 2000)}`,
      })
    }
    const stderr = unknownStderr(lane.name, lane.stderr())
    known.push(...stderr.known)
    // Output arrives on its own clock, often a case late, so its signature does not name a route.
    if (stderr.rest !== "") {
      violations.push({
        kind: "runtime-fault",
        signature: `runtime-fault [${lane.name}] stderr`,
        lanes: [lane.name],
        detail: `${lane.name} wrote to stderr: ${stderr.rest.slice(0, 2000)}`,
      })
    }
  }
  return { violations, known }
}

function outcomeSummary(
  grouped: readonly { readonly lanes: readonly LaneName[]; readonly key: string }[],
): string {
  return grouped
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

/** Send one request to every lane at once, then judge it - runtime faults included. */
async function runHttp(testCase: Case): Promise<Run> {
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
  const faults = laneFaults(testCase.route)
  excusedBy.push(...judged.excusedBy, ...faults.known)
  return {
    violations: [...judged.violations, ...faults.violations],
    excusedBy,
    summary: () => outcomeSummary(groups(outcomes)),
  }
}

const timedOut = (outcome: WsOutcome) =>
  outcome.sockets.some((events) => events.some((event) => event.kind === "timeout"))

/** Run one WebSocket session on every lane with a socket at once, then judge them. */
async function runWs(testCase: WsCase): Promise<Run> {
  const excusedBy: string[] = []
  const answered = await Promise.all(
    lanes.map(async (lane) => {
      const port = await lane.wsPort()
      if (port === undefined) return undefined
      const first = await runWsCase(port, testCase, deadlineMs)
      if (!timedOut(first)) return [lane.name, first] as const
      const second = await runWsCase(port, testCase, deadlineMs)
      if (!timedOut(second)) excusedBy.push("answered when asked again")
      return [lane.name, second] as const
    }),
  )
  const outcomes = new Map<LaneName, WsOutcome>(answered.filter((entry) => entry !== undefined))
  const judged = judgeWs(testCase, outcomes, exposed)
  const faults = laneFaults(`ws:${testCase.route}`)
  excusedBy.push(...judged.excusedBy, ...faults.known)
  return {
    violations: [...judged.violations, ...faults.violations],
    excusedBy,
    summary: () => outcomeSummary(wsGroups(outcomes)),
  }
}

function describe(testCase: unknown): string {
  return JSON.stringify(testCase)
}

if (values.replay !== undefined) {
  const replayed: Run = /"kind"\s*:\s*"ws"/.test(values.replay)
    ? await runWs(parseWsCase(values.replay))
    : await runHttp(parseCase(values.replay))
  console.log(replayed.summary())
  for (const violation of replayed.violations)
    console.log(`\n${violation.signature}\n${violation.detail}`)
  await shutdown()
  process.exit(replayed.violations.length === 0 ? 0 : 1)
}

interface Bucket {
  readonly signature: string
  readonly kind: Violation["kind"]
  readonly firstRun: number
  /** The violation as first seen, for a signature that does not come back on replay. */
  readonly firstDetail: string
  readonly firstCase: unknown
  count: number
}

interface Finding {
  readonly signature: string
  readonly kind: Violation["kind"]
  readonly count: number
  readonly shrunk: unknown
  readonly violations: readonly Violation[]
  readonly outcomes: string
  readonly report: string
}

interface Explored {
  readonly name: string
  readonly runs: number
  readonly signatures: readonly Bucket[]
  readonly findings: readonly Finding[]
}

console.log(
  `runtime differential: ${runs} runs + ${wsRuns} WebSocket runs, seed ${seed}, mode ${mode}, lanes ${lanes.map((lane) => lane.name).join(", ")}`,
)

/**
 * Phase 1 files every violation of `suite.runs` generated cases under its signature; phase 2 replays
 * the first case of each signature from its fast-check path and shrinks it, keeping the signature.
 */
async function explore<C>(suite: Suite<C>): Promise<Explored> {
  const buckets = new Map<string, Bucket>()
  const excusals = new Map<string, number>()
  let runIndex = 0
  const startedAt = performance.now()
  await fc.check(
    fc.asyncProperty(suite.arbitrary, async (testCase) => {
      const at = runIndex++
      const { violations, excusedBy } = await suite.run(testCase)
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
    { seed, numRuns: suite.runs },
  )
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `${suite.name} phase 1: ${runIndex} cases in ${seconds} s, ${buckets.size} distinct violation signatures`,
  )
  for (const [id, count] of excusals) console.log(`  excused by ${id}: ${count}`)

  const findings: Finding[] = []
  const ordered = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, maxFindings)
  for (const bucket of ordered) {
    const details = await fc.check(
      fc.asyncProperty(suite.arbitrary, async (testCase) => {
        const { violations } = await suite.run(testCase)
        // nifra-expect NF-S002: violation signatures are public failure-group labels, not cryptographic signatures.
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
    const replayed = await suite.run(shrunk)
    findings.push({
      signature: bucket.signature,
      kind: bucket.kind,
      count: bucket.count,
      shrunk,
      violations: replayed.violations.filter(
        // nifra-expect NF-S002: violation signatures are public failure-group labels, not cryptographic signatures.
        (violation) => violation.signature === bucket.signature,
      ),
      outcomes: replayed.summary(),
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
  return { name: suite.name, runs: runIndex, signatures: [...buckets.values()], findings }
}

const explored = [
  await explore({ name: "http", arbitrary: caseArbitrary, runs, run: runHttp }),
  await explore({ name: "ws", arbitrary: wsCaseArbitrary, runs: wsRuns, run: runWs }),
]

if (values.report !== undefined) {
  writeFileSync(
    values.report,
    `${JSON.stringify({ seed, mode, lanes: lanes.map((lane) => lane.name), suites: explored }, null, 2)}\n`,
  )
}

await shutdown()
const failed = explored.reduce((total, suite) => total + suite.signatures.length, 0)
if (failed > 0) {
  console.error(
    `\nruntime differential failed: ${failed} distinct violation signature(s); seed ${seed}`,
  )
  process.exit(1)
}
console.log("runtime differential passed")
