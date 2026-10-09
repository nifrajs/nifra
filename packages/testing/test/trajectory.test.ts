import { describe, expect, test } from "bun:test"
import { createAgentState, runAgent } from "@nifrajs/agent"
import { defineTool } from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import { defineFaultProfile } from "../src/fault-profile.ts"
import {
  assertTrajectoryInvariants,
  checkTrajectoryInvariants,
  createTrajectoryTranscript,
  replayTrajectory,
  trajectoryRegressionId,
} from "../src/trajectory.ts"

const input = t.object({ prompt: t.string() })
const output = t.object({ answer: t.string() })
const tool = defineTool({
  name: "trajectory.echo",
  description: "Echo a trajectory value.",
  input: t.object({ value: t.string() }),
  output: t.object({ ok: t.boolean() }),
  capability: "trajectory.echo",
  execute: () => ({ ok: true }),
})

const definition = {
  name: "trajectory-agent",
  instruction: "Use the tool and answer.",
  input,
  output,
  tools: [tool],
}

describe("agent trajectory lab", () => {
  test("a tool fault fires during a dry replay, which still runs no tool", async () => {
    let executions = 0
    const counted = defineTool({
      ...tool,
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const counting = { ...definition, tools: [counted] }
    const responses: unknown[] = [
      { kind: "tool", name: "trajectory.echo", input: { value: "x" } },
      { kind: "output", value: { answer: "done" } },
    ]
    const recorded = await runAgent(
      counting,
      { value: { prompt: "run" } },
      {
        model: { complete: () => responses.shift() },
        capabilities: ["trajectory.echo"],
        clock: () => 1,
      },
      { state: createAgentState("trajectory-record"), maxTurns: 2 },
    )
    const transcript = await createTrajectoryTranscript(recorded.transcript)
    const scenarios = [
      { id: "s", name: "s", description: "tool fault", execute: () => {}, verify: () => true },
    ]
    const outcomes: string[] = []
    for (const kind of ["tool-error", "cancellation", "budget-pressure"] as const) {
      const replay = await replayTrajectory(
        counting,
        { value: { prompt: "run" } },
        { capabilities: ["trajectory.echo"], clock: () => 1 },
        transcript,
        {
          state: createAgentState("trajectory-replay"),
          maxTurns: 2,
          faultProfile: defineFaultProfile({
            name: `tool-${kind}`,
            scenarios,
            faults: [{ point: "tool", kind }],
          }),
        },
      )
      const evidence = replay.result.evidence.find((item) => item.kind === "tool")
      outcomes.push(`${kind} ${replay.result.status} ${evidence?.outcome}:${evidence?.code}`)
    }
    expect(outcomes).toEqual([
      "tool-error completed failed:execution_failed",
      "cancellation suspended failed:cancelled",
      "budget-pressure suspended failed:budget_exceeded",
    ])
    expect(executions).toBe(1)
  })

  test("replays the same transcript byte-identically with no real tool effects", async () => {
    const responses: unknown[] = [
      { kind: "tool", name: "trajectory.echo", input: { value: "x" } },
      { kind: "output", value: { answer: "done" } },
    ] as const
    const recorded = await runAgent(
      definition,
      { value: { prompt: "run" } },
      {
        model: { complete: () => responses.shift() },
        capabilities: ["trajectory.echo"],
        clock: () => 1,
      },
      { state: createAgentState("trajectory-record"), maxTurns: 2 },
    )
    const transcript = await createTrajectoryTranscript(recorded.transcript, { seed: 17 })
    const profile = defineFaultProfile({
      name: "trajectory-reference",
      scenarios: [
        {
          id: "smoke",
          name: "smoke",
          description: "reference trajectory",
          execute: () => {},
          verify: () => true,
        },
      ],
    })
    const first = await replayTrajectory(
      definition,
      { value: { prompt: "run" } },
      { capabilities: [], clock: () => 1 },
      transcript,
      {
        state: createAgentState("trajectory-replay"),
        maxTurns: 2,
        faultProfile: profile,
        seed: 17,
      },
    )
    const second = await replayTrajectory(
      definition,
      { value: { prompt: "run" } },
      { capabilities: [], clock: () => 1 },
      transcript,
      {
        state: createAgentState("trajectory-replay"),
        maxTurns: 2,
        faultProfile: profile,
        seed: 17,
      },
    )
    expect(first.result.status).toBe("completed")
    expect(JSON.stringify(first.result)).toBe(JSON.stringify(second.result))
    expect(first.faults).toEqual(second.faults)
    expect(first.invariants.every((invariant) => invariant.ok)).toBe(true)
  })

  test("turns a seeded malformed-model fault into a stable regression", async () => {
    const recorded = await runAgent(
      { ...definition, tools: [] },
      { value: { prompt: "fault" } },
      {
        model: { complete: () => ({ kind: "output", value: { answer: "done" } }) },
        capabilities: [],
        clock: () => 1,
      },
      { state: createAgentState("trajectory-fault-record"), maxTurns: 1 },
    )
    const transcript = await createTrajectoryTranscript(recorded.transcript)
    const profile = defineFaultProfile({
      name: "malformed-model",
      scenarios: [
        {
          id: "smoke",
          name: "smoke",
          description: "malformed model fixture",
          execute: () => {},
          verify: () => true,
        },
      ],
      faults: [{ point: "model", kind: "malformed-model-output" }],
    })
    const replay = await replayTrajectory(
      { ...definition, tools: [] },
      { value: { prompt: "fault" } },
      { capabilities: [], clock: () => 1 },
      transcript,
      {
        state: createAgentState("trajectory-fault-replay"),
        maxTurns: 1,
        faultProfile: profile,
        seed: 9,
      },
    )
    expect(replay.result.status).toBe("suspended")
    const id = await trajectoryRegressionId(transcript, profile.name, "bounded-stop")
    expect(id).toMatch(/^[a-f0-9]{64}$/)
    expect(replay.regressionIds).toContain(id)
  })

  test("catches invariant fixtures that violate ledger evidence and budget monotonicity", () => {
    const state = createAgentState("invariant-fixture")
    const bad = {
      status: "continue" as const,
      state,
      toolResult: { name: "fixture", ok: true },
      evidence: [
        { seq: 0, at: 0, kind: "tool" as const, outcome: "committed" as const, effectId: "e1" },
      ],
      transcript: { version: 1 as const, turnId: state.turnId, responses: [], evidence: [] },
    }
    const results = checkTrajectoryInvariants(bad, {
      budgetSnapshots: [{ calls: 2 }, { calls: 3 }],
    })
    expect(results.find((result) => result.id === "ledger-evidence")?.ok).toBe(false)
    expect(results.find((result) => result.id === "budget-monotonic")?.ok).toBe(false)
    expect(() => assertTrajectoryInvariants(bad)).toThrow("trajectory invariants failed")
  })
})
