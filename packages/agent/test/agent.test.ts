import { describe, expect, test } from "bun:test"
import {
  createToolBudget,
  defineTool,
  MemoryToolIdempotencyStore,
} from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import {
  type AgentDefinition,
  type AgentModelPort,
  createAgentState,
  MemoryAgentStateStore,
  replayAgent,
  resumeAgent,
  runAgent,
  turn,
} from "../src/index.ts"

const input = t.object({ prompt: t.string() })
const output = t.object({ answer: t.string() })

function definition(
  tool: AgentDefinition<typeof input, typeof output>["tools"][number] | undefined = undefined,
): AgentDefinition<typeof input, typeof output> {
  return {
    name: "reference-agent",
    instruction: "Return a concise answer.",
    input,
    output,
    tools: tool === undefined ? [] : [tool],
  }
}

function sequenceModel(responses: readonly unknown[], calls: { count: number }): AgentModelPort {
  return {
    complete: () => {
      const response = responses[calls.count]
      calls.count += 1
      if (response === undefined) throw new Error("test model exhausted")
      return response
    },
  }
}

describe("agent turns", () => {
  test("validates typed model output and completes", async () => {
    const calls = { count: 0 }
    const result = await turn(
      definition(),
      createAgentState("typed-output"),
      { value: { prompt: "hello" } },
      {
        model: sequenceModel([{ kind: "output", value: { answer: "hello" } }], calls),
        capabilities: [],
        clock: () => 1,
      },
    )
    expect(result.status).toBe("completed")
    if (result.status === "completed") expect(result.output).toEqual({ answer: "hello" })
    expect(calls.count).toBe(1)
  })

  test("returns a typed capability error without executing a denied tool", async () => {
    let executions = 0
    const tool = defineTool({
      name: "reference.write",
      description: "Write a reference value.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.write",
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await turn(
      definition(tool),
      createAgentState("capability-denial"),
      { value: { prompt: "write" } },
      {
        model: sequenceModel([{ kind: "tool", name: "reference.write", input: { value: "x" } }], {
          count: 0,
        }),
        capabilities: [],
        clock: () => 1,
      },
    )
    expect(result.status).toBe("continue")
    if (result.status === "continue")
      expect(result.toolResult.error).toMatchObject({ code: "capability_denied" })
    expect(executions).toBe(0)
  })

  test("suspends for approval and resumes without another model call", async () => {
    let executions = 0
    let requestedEffectId: string | undefined
    let executedEffectId: string | undefined
    const tool = defineTool({
      name: "reference.approve",
      description: "Run an approved reference action.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.approve",
      approval: { kind: "required" },
      execute: (_input, context) => {
        executions += 1
        executedEffectId = context.effectId
        return { ok: true }
      },
    })
    const state = createAgentState("approval-resume")
    const first = await turn(
      definition(tool),
      state,
      { value: { prompt: "approve" } },
      {
        model: sequenceModel([{ kind: "tool", name: "reference.approve", input: { value: "x" } }], {
          count: 0,
        }),
        capabilities: ["reference.approve"],
        approval: {
          request: ({ effectId }) => {
            requestedEffectId = effectId
            return { status: "pending", effectId }
          },
        },
        clock: () => 1,
      },
    )
    expect(first.status).toBe("suspended")
    if (first.status !== "suspended") return
    const resumed = await turn(
      definition(tool),
      first.state,
      {
        value: { prompt: "approve" },
        resume: { continuation: first.pending, approval: { granted: true } },
      },
      {
        model: sequenceModel([], { count: 0 }),
        capabilities: ["reference.approve"],
        clock: () => 2,
      },
    )
    expect(resumed.status).toBe("continue")
    expect(executions).toBe(1)
    expect(executedEffectId).toBe(requestedEffectId)
  })

  test("retries a model suspension from its saved token-only state", async () => {
    let calls = 0
    const state = new MemoryAgentStateStore()
    const ports = {
      model: {
        complete: () => {
          calls += 1
          if (calls === 1) throw new Error("provider interrupted")
          return { kind: "output", value: { answer: "resumed" } }
        },
      },
      capabilities: [],
      state,
      clock: () => 1,
    }
    const first = await turn(
      definition(),
      createAgentState("model-retry"),
      { value: { prompt: "retry" } },
      ports,
    )
    expect(first.status).toBe("suspended")
    const resumed = await resumeAgent(
      definition(),
      "model-retry",
      { value: { prompt: "retry" } },
      ports,
      { maxTurns: 1 },
    )
    expect(resumed.status).toBe("completed")
    expect(calls).toBe(2)
  })

  test("passes a policy adapter through to policy-bound tools", async () => {
    let executions = 0
    const tool = defineTool({
      name: "reference.policy",
      description: "Run a policy-bound reference action.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.policy",
      policy: {
        filesystem: "cwd",
        network: "allow",
        timeMs: 100,
        capabilityCeiling: ["reference.policy"],
      },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await runAgent(
      definition(tool),
      { value: { prompt: "policy" } },
      {
        model: sequenceModel(
          [
            { kind: "tool", name: "reference.policy", input: { value: "x" } },
            { kind: "output", value: { answer: "done" } },
          ],
          { count: 0 },
        ),
        capabilities: ["reference.policy"],
        executionPolicy: {
          name: "reference-policy",
          canSatisfy: (policy) => policy.capabilityCeiling.includes("reference.policy"),
          limitations: () => [],
        },
        clock: () => 1,
      },
      { state: createAgentState("policy-agent"), maxTurns: 2 },
    )
    expect(result.status).toBe("completed")
    expect(executions).toBe(1)
  })

  test("suspends on model or tool budget exhaustion with evidence", async () => {
    const tool = defineTool({
      name: "reference.cost",
      description: "Consume one counter.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.cost",
      cost: { calls: 1 },
      execute: () => ({ ok: true }),
    })
    const result = await turn(
      definition(tool),
      createAgentState("budget-suspend"),
      { value: { prompt: "cost" } },
      {
        model: sequenceModel([{ kind: "tool", name: "reference.cost", input: { value: "x" } }], {
          count: 0,
        }),
        capabilities: ["reference.cost"],
        budget: createToolBudget({ limits: { calls: 0 } }),
        clock: () => 1,
      },
    )
    expect(result.status).toBe("suspended")
    expect(
      result.evidence.some((item) => item.kind === "budget" && item.code === "budget_exceeded"),
    ).toBe(true)
  })

  test("suspends a provider failure as a model suspension, not a budget one", async () => {
    const result = await turn(
      definition(),
      createAgentState("model-failure"),
      { value: { prompt: "hello" } },
      {
        model: {
          complete: () => {
            throw new Error("provider unavailable")
          },
        },
        capabilities: [],
        clock: () => 1,
      },
    )
    expect(result.status).toBe("suspended")
    if (result.status === "suspended") {
      expect(result.reason).toBe("model")
      expect(result.pending.kind).toBe("model")
    }
    expect(
      result.evidence.some((item) => item.kind === "model" && item.code === "model_failed"),
    ).toBe(true)
  })

  test("bounds a loop that never reaches its goal", async () => {
    const calls = { count: 0 }
    const result = await runAgent(
      definition(),
      { value: { prompt: "repeat" } },
      {
        model: {
          complete: () => {
            calls.count += 1
            return { kind: "output", value: { answer: "not-yet" } }
          },
        },
        capabilities: [],
        clock: () => 1,
      },
      { state: createAgentState("bounded-loop"), maxTurns: 3, goal: () => false },
    )
    expect(result.status).toBe("suspended")
    if (result.status === "suspended") expect(result.reason).toBe("max_turns")
    expect(calls.count).toBe(3)
  })

  test("replays with no provider calls and no tool effects", async () => {
    let executions = 0
    const tool = defineTool({
      name: "reference.effect",
      description: "Perform a reference effect.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.effect",
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const calls = { count: 0 }
    const recorded = await runAgent(
      definition(tool),
      { value: { prompt: "do it" } },
      {
        model: sequenceModel(
          [
            { kind: "tool", name: "reference.effect", input: { value: "x" } },
            { kind: "output", value: { answer: "done" } },
          ],
          calls,
        ),
        capabilities: ["reference.effect"],
        clock: () => 1,
      },
      { state: createAgentState("replay-recorded"), maxTurns: 2 },
    )
    expect(recorded.status).toBe("completed")
    expect(executions).toBe(1)
    let providerCalls = 0
    const replayed = await replayAgent(
      definition(tool),
      { value: { prompt: "do it" } },
      { capabilities: [], clock: () => 1 },
      recorded.transcript,
      { state: createAgentState("replay-recorded"), maxTurns: 2 },
    )
    providerCalls += calls.count
    expect(replayed.status).toBe("completed")
    expect(providerCalls).toBe(2)
    expect(executions).toBe(1)
  })

  test("resumes a saved state without duplicating an idempotent effect", async () => {
    let executions = 0
    const tool = defineTool({
      name: "reference.once",
      description: "Perform one idempotent reference effect.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.once",
      idempotency: { scope: "request", key: (value) => value.value },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const state = new MemoryAgentStateStore()
    const idempotency = new MemoryToolIdempotencyStore()
    const responses: unknown[] = [
      { kind: "tool", name: "reference.once", input: { value: "one" } },
      { kind: "tool", name: "reference.once", input: { value: "one" } },
      { kind: "output", value: { answer: "done" } },
    ]
    const ports = {
      model: { complete: () => responses.shift() },
      capabilities: ["reference.once"],
      state,
      idempotency,
      clock: () => 1,
    }
    const first = await turn(
      definition(tool),
      createAgentState("resume-once"),
      { value: { prompt: "one" } },
      ports,
    )
    expect(first.status).toBe("continue")
    const resumed = await resumeAgent(
      definition(tool),
      "resume-once",
      { value: { prompt: "one" } },
      ports,
      { maxTurns: 2 },
    )
    expect(resumed.status).toBe("completed")
    expect(executions).toBe(1)
  })
})
