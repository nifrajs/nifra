/**
 * Agent-platform orchestration bench. Five modes, each runnable under `--check` (assert invariants,
 * non-zero exit on violation) or bare (print timings):
 *
 *   compile   - checked compile of a 256-node fixture and a no-op fixture; the ceiling holds and the
 *               lowering never throws.
 *   schedule  - submit/start/settle a 256-node plan through the OrchestrationHost; every node
 *               completes and the terminal digest is deterministic.
 *   memory    - append 1k/10k/100k evidence records to a bounded store; the live window stays
 *               bounded, the full count is tallied, and the digest is order-independent.
 *   gateway   - compare direct deterministic fake calls with the bounded gateway policy path.
 *   replay    - replay 1,000 token-only steps twice and require an identical schedule digest.
 *
 * Usage: `bun run scripts/bench-agent-platform.ts [--check] [compile] [schedule] [memory] [gateway] [replay] [--json]`
 */

import { performance } from "node:perf_hooks"
import { FakeModelGateway, runModelGateway } from "@nifrajs/agent"
import { RUN_PLAN_VERSION, type RunEvidence, type RunPlan } from "@nifrajs/agent-protocol"
import {
  compileRunPlan,
  createStepCatalog,
  MemoryEvidenceStore,
  noopArtifactPort,
  OrchestrationHost,
  type StepCatalog,
} from "@nifrajs/coding-agent/orchestration"
import { runFailureScenario } from "@nifrajs/testing"

const CHECK = Bun.argv.includes("--check")
const JSON_OUT = Bun.argv.includes("--json")
const ALL = ["compile", "schedule", "memory", "gateway", "replay"] as const
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

async function benchGateway(): Promise<void> {
  const operations = 256
  const responses = Array.from({ length: operations }, () => ({
    ok: true as const,
    output: { ok: true },
  }))
  const directGateway = new FakeModelGateway({ responses })
  const directStart = performance.now()
  for (let i = 0; i < operations; i++) {
    await directGateway.complete({
      routeId: "bench-route",
      input: {},
      signal: new AbortController().signal,
      envelope: { attempt: 1, attemptsRemaining: 0 },
    })
  }
  const directMs = performance.now() - directStart

  const wrappedGateway = new FakeModelGateway({ responses })
  const wrappedStart = performance.now()
  for (let i = 0; i < operations; i++) {
    const result = await runModelGateway(
      wrappedGateway,
      { input: {} },
      { routes: ["bench-route"], retryableCodes: [], budget: { maxAttempts: 1 } },
    )
    assert(result.ok, "gateway wrapper must accept the fake response")
  }
  const gatewayMs = performance.now() - wrappedStart
  assert(directGateway.calls === operations, "direct fake call count must match")
  assert(wrappedGateway.calls === operations, "gateway fake call count must match")
  results.gateway = {
    operations,
    directMs: round(directMs),
    gatewayMs: round(gatewayMs),
    overheadMs: round(gatewayMs - directMs),
  }
  log(
    `gateway: ${operations.toLocaleString()} direct/facaded calls, ${round(gatewayMs - directMs)}ms overhead`,
  )
}

async function benchReplay(): Promise<void> {
  const steps = 1_000
  const run = async () => {
    let delivered = 0
    const report = await runFailureScenario(
      {
        name: "agent-replay-1000",
        execute(lab) {
          for (let index = 0; index < steps; index++) {
            delivered += lab.deliveries(`replay.${index}`, [index]).length
          }
          return true
        },
        verify: () => delivered === steps,
      },
      { seed: 0x5245504c, schedule: [] },
    )
    return { report, delivered }
  }
  const start = performance.now()
  const first = await run()
  const second = await run()
  const ms = performance.now() - start
  const firstEvidence = JSON.stringify({
    replay: first.report.replay,
    evidence: first.report.evidence,
  })
  const secondEvidence = JSON.stringify({
    replay: second.report.replay,
    evidence: second.report.evidence,
  })
  assert(first.report.ok && second.report.ok, "1,000-step replay must pass")
  assert(first.delivered === steps && second.delivered === steps, "replay must deliver every step")
  assert(firstEvidence === secondEvidence, "replay evidence digest must be deterministic")
  results.replay = { steps, ms: round(ms), digest: await digest(firstEvidence) }
  log(`replay: ${steps.toLocaleString()} deterministic steps in ${round(ms)}ms`)
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const raw = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(raw)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function log(line: string): void {
  if (!JSON_OUT) console.log(line)
}

for (const mode of modes) {
  if (mode === "compile") benchCompile()
  else if (mode === "schedule") await benchSchedule()
  else if (mode === "memory") await benchMemory()
  else if (mode === "gateway") await benchGateway()
  else await benchReplay()
}

if (JSON_OUT) console.log(JSON.stringify({ check: CHECK, modes, results }))
else if (CHECK) console.log(`bench-agent-platform: all checks passed (${modes.join(", ")})`)
