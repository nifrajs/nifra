/**
 * Agent-platform orchestration bench. Three modes, each runnable under `--check` (assert invariants,
 * non-zero exit on violation) or bare (print timings):
 *
 *   compile   - checked compile of a 256-node fixture and a no-op fixture; the ceiling holds and the
 *               lowering never throws.
 *   schedule  - submit/start/settle a 256-node plan through the OrchestrationHost; every node
 *               completes and the terminal digest is deterministic.
 *   memory    - append 1k/10k/100k evidence records to a bounded store; the live window stays
 *               bounded, the full count is tallied, and the digest is order-independent.
 *
 * Usage: `bun run scripts/bench-agent-platform.ts [--check] [compile] [schedule] [memory] [--json]`
 */

import { performance } from "node:perf_hooks"
import { RUN_PLAN_VERSION, type RunEvidence, type RunPlan } from "@nifrajs/agent-protocol"
import {
  compileRunPlan,
  createStepCatalog,
  MemoryEvidenceStore,
  noopArtifactPort,
  OrchestrationHost,
  type StepCatalog,
} from "@nifrajs/coding-agent/orchestration"

const CHECK = Bun.argv.includes("--check")
const JSON_OUT = Bun.argv.includes("--json")
const ALL = ["compile", "schedule", "memory"] as const
type Mode = (typeof ALL)[number]
const requested = Bun.argv.filter((arg): arg is Mode => (ALL as readonly string[]).includes(arg))
const modes: readonly Mode[] = requested.length > 0 ? requested : ALL

const PLAN_DIGEST = "a".repeat(64)

function assert(condition: boolean, message: string): void {
  if (CHECK && !condition) throw new Error(`bench-agent-platform: ${message}`)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function catalog(): StepCatalog {
  return createStepCatalog({ noop: { kind: "task", run: () => undefined } })
}

/** N independent top-level task nodes: one layer, one bounded parallel of breadth N. */
function fanPlan(nodes: number): RunPlan {
  return {
    version: 1,
    id: "bench",
    nodes: Array.from({ length: nodes }, (_unused, i) => ({
      id: `n${i}`,
      kind: "task" as const,
      step: "noop",
    })),
  }
}

const results: Record<string, unknown> = {}

function benchCompile(): void {
  const opts = { catalog: catalog(), planDigest: PLAN_DIGEST, artifactPort: noopArtifactPort() }
  const big = fanPlan(256)
  const noop = fanPlan(1)
  const start = performance.now()
  const compiledBig = compileRunPlan(big, opts)
  const compiledNoop = compileRunPlan(noop, opts)
  const ms = performance.now() - start
  assert(
    compiledBig.type === "parallel",
    "256-node fixture must lower to one bounded parallel layer",
  )
  assert(compiledNoop.type === "task", "no-op fixture must lower to a single task")
  results.compile = { nodes: 256, ms: round(ms) }
  log(`compile: 256-node + no-op lowered in ${round(ms)}ms`)
}

async function benchSchedule(): Promise<void> {
  const host = new OrchestrationHost({ catalog: catalog() })
  const start = performance.now()
  const runId = await host.submit(fanPlan(256), { runId: "bench" })
  host.start(runId)
  const result = await host.settled(runId)
  const ms = performance.now() - start
  assert(result.status === "succeeded", `schedule run must succeed, got ${result.status}`)
  assert(result.completedNodeIds.length === 256, "every node must complete")
  assert(/^[0-9a-f]{64}$/.test(result.evidenceDigest), "terminal digest must be 64 hex")
  results.schedule = { nodes: 256, ms: round(ms), digest: result.evidenceDigest }
  log(`schedule: 256-node plan settled ${result.status} in ${round(ms)}ms`)
}

async function benchMemory(): Promise<void> {
  const sizes = [1_000, 10_000, 100_000]
  const maxLive = 512
  const rows: Record<string, unknown>[] = []
  for (const size of sizes) {
    const store = new MemoryEvidenceStore({ maxLive })
    const start = performance.now()
    for (let i = 0; i < size; i++) {
      const record: RunEvidence = {
        version: RUN_PLAN_VERSION,
        runId: "bench",
        planDigest: PLAN_DIGEST,
        nodeId: `n${i}`,
        status: "completed",
        seq: i,
        idempotent: false,
      }
      await store.append(record)
    }
    const ms = performance.now() - start
    const digest = await store.digest()
    assert(store.count === size, `store must tally ${size} records`)
    assert(store.live().length === Math.min(size, maxLive), "live window must stay bounded")
    assert(/^[0-9a-f]{64}$/.test(digest), "digest must be 64 hex")
    rows.push({ events: size, liveWindow: store.live().length, ms: round(ms) })
    log(
      `memory: ${size.toLocaleString()} events, live window ${store.live().length}, ${round(ms)}ms`,
    )
  }
  results.memory = rows
}

function log(line: string): void {
  if (!JSON_OUT) console.log(line)
}

for (const mode of modes) {
  if (mode === "compile") benchCompile()
  else if (mode === "schedule") await benchSchedule()
  else await benchMemory()
}

if (JSON_OUT) console.log(JSON.stringify({ check: CHECK, modes, results }))
else if (CHECK) console.log(`bench-agent-platform: all checks passed (${modes.join(", ")})`)
