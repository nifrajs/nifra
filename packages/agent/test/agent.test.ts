import { describe, expect, test } from "bun:test"
import { type BudgetClock, createRequestBudget } from "@nifrajs/core/budget"
import {
  createToolBudget,
  defineTool,
  MemoryToolIdempotencyStore,
} from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import {
  type AgentDefinition,
  type AgentDeltaSink,
  type AgentModelDelta,
  type AgentModelPort,
  type AgentStatePatchOp,
  type AgentStepEvidence,
  combineAgentDeltaSinks,
  combineAgentTelemetry,
  createAgentSharedState,
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
  const deadlineClock = (): BudgetClock & { wallMs: number; monotonicMs: number } => {
    const wallMs = 1_700_000_000_000
    return {
      wallMs,
      monotonicMs: 100,
      wall() {
        return this.wallMs
      },
      monotonic() {
        return this.monotonicMs
      },
    }
  }

  const requestDeadline = (
    clock: BudgetClock & { wallMs: number; monotonicMs: number },
    remainingMs: number,
  ) =>
    createRequestBudget({
      deadline: clock.wallMs + remainingMs,
      signal: new AbortController().signal,
      clock,
    })

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

  test("passes child deadlines to model, approval, and tool execution", async () => {
    const clock = deadlineClock()
    const deadline = requestDeadline(clock, 100)
    let modelDeadline: number | undefined
    let approvalDeadline: number | undefined
    let toolDeadline: number | undefined
    const tool = defineTool({
      name: "reference.deadline",
      description: "Observe the request deadline.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.deadline",
      approval: { kind: "required" },
      cost: { ms: 20 },
      execute: (_input, context) => {
        toolDeadline = context.deadline?.deadline
        return { ok: true }
      },
    })
    const result = await turn(
      { ...definition(tool), modelCost: { ms: 30 } },
      createAgentState("deadline-hops"),
      { value: { prompt: "deadline" } },
      {
        model: {
          complete: (request) => {
            modelDeadline = request.deadline?.deadline
            return { kind: "tool", name: "reference.deadline", input: { value: "x" } }
          },
        },
        capabilities: ["reference.deadline"],
        approval: {
          request: (request) => {
            approvalDeadline = request.deadline?.deadline
            return { status: "approved", approval: { granted: true } }
          },
        },
        deadline,
        clock: () => 1,
      },
    )
    expect(result.status).toBe("continue")
    expect(modelDeadline).toBe(deadline.deadline - 5)
    expect(approvalDeadline).toBe(deadline.deadline - 25)
    expect(toolDeadline).toBe(deadline.deadline - 5)
  })

  test("suspends before a model attempt when its deadline is exhausted", async () => {
    const clock = deadlineClock()
    let calls = 0
    const result = await turn(
      { ...definition(), modelCost: { ms: 1 } },
      createAgentState("deadline-model"),
      { value: { prompt: "deadline" } },
      {
        model: {
          complete: () => {
            calls += 1
            return { kind: "output", value: { answer: "late" } }
          },
        },
        capabilities: [],
        deadline: requestDeadline(clock, 4),
        clock: () => 1,
      },
    )
    expect(result.status).toBe("suspended")
    if (result.status === "suspended") {
      expect(result.reason).toBe("budget")
      expect(result.pending.kind).toBe("budget")
    }
    expect(calls).toBe(0)
    expect(
      result.evidence.some((item) => item.kind === "budget" && item.code === "deadline_exceeded"),
    ).toBe(true)
  })

  test("suspends before a tool attempt when its deadline cannot fit", async () => {
    const clock = deadlineClock()
    let executions = 0
    const tool = defineTool({
      name: "reference.late-tool",
      description: "A tool that cannot fit.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.late-tool",
      cost: { ms: 10 },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await turn(
      definition(tool),
      createAgentState("deadline-tool"),
      { value: { prompt: "deadline" } },
      {
        model: sequenceModel(
          [{ kind: "tool", name: "reference.late-tool", input: { value: "x" } }],
          { count: 0 },
        ),
        capabilities: ["reference.late-tool"],
        deadline: requestDeadline(clock, 10),
        clock: () => 1,
      },
    )
    expect(result.status).toBe("suspended")
    if (result.status === "suspended") expect(result.reason).toBe("budget")
    expect(executions).toBe(0)
    expect(
      result.evidence.some((item) => item.kind === "budget" && item.code === "deadline_exceeded"),
    ).toBe(true)
  })

  test("rechecks the deadline after a slow approval", async () => {
    const clock = deadlineClock()
    let executions = 0
    const tool = defineTool({
      name: "reference.slow-approval",
      description: "A tool whose approval consumes the remaining time.",
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "reference.slow-approval",
      approval: { kind: "required" },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const result = await turn(
      definition(tool),
      createAgentState("deadline-approval"),
      { value: { prompt: "deadline" } },
      {
        model: sequenceModel(
          [{ kind: "tool", name: "reference.slow-approval", input: { value: "x" } }],
          { count: 0 },
        ),
        capabilities: ["reference.slow-approval"],
        approval: {
          request: () => {
            clock.monotonicMs = 106
            return { status: "approved", approval: { granted: true } }
          },
        },
        deadline: requestDeadline(clock, 10),
        clock: () => 1,
      },
    )
    expect(result.status).toBe("suspended")
    if (result.status === "suspended") expect(result.reason).toBe("budget")
    expect(executions).toBe(0)
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

describe("combineAgentTelemetry", () => {
  test("awaits every port in argument order and skips undefined entries", async () => {
    const calls: string[] = []
    const port = (label: string) => ({
      step: (evidence: AgentStepEvidence) => {
        calls.push(`${label}:${evidence.seq}`)
      },
    })
    const combined = combineAgentTelemetry(undefined, port("a"), undefined, port("b"))
    expect(combined).toBeDefined()
    await combined?.step({ seq: 7, at: 0, kind: "model", outcome: "started" })
    expect(calls).toEqual(["a:7", "b:7"])
  })

  test("collapses to the single live port and to undefined when none remain", () => {
    const only = { step: () => {} }
    expect(combineAgentTelemetry(undefined, only)).toBe(only)
    expect(combineAgentTelemetry(undefined, undefined)).toBeUndefined()
  })
})

describe("model deltas", () => {
  test("plumbs the delta sink into the model request and never persists deltas", async () => {
    const seen: AgentModelDelta[] = []
    const result = await runAgent(
      definition(),
      { value: { prompt: "stream" } },
      {
        model: {
          complete: (request) => {
            request.onDelta?.({ kind: "text", text: "he" })
            request.onDelta?.({ kind: "text", text: "llo" })
            return { kind: "output", value: { answer: "hello" } }
          },
        },
        capabilities: [],
        deltas: { delta: (delta) => seen.push(delta) },
      },
      { state: createAgentState("delta-run") },
    )
    expect(result.status).toBe("completed")
    expect(seen).toEqual([
      { kind: "text", text: "he" },
      { kind: "text", text: "llo" },
    ])
    expect(JSON.stringify(result.evidence)).not.toContain("hello")
  })

  test("omits onDelta when no sink is wired", async () => {
    let sawCallback: boolean | undefined
    const result = await runAgent(
      definition(),
      { value: { prompt: "plain" } },
      {
        model: {
          complete: (request) => {
            sawCallback = request.onDelta !== undefined
            return { kind: "output", value: { answer: "plain" } }
          },
        },
        capabilities: [],
      },
      { state: createAgentState("no-delta-run") },
    )
    expect(result.status).toBe("completed")
    expect(sawCallback).toBe(false)
  })

  test("a throwing sink never fails the model step", async () => {
    const result = await runAgent(
      definition(),
      { value: { prompt: "boom" } },
      {
        model: {
          complete: (request) => {
            request.onDelta?.({ kind: "text", text: "x" })
            return { kind: "output", value: { answer: "boom" } }
          },
        },
        capabilities: [],
        deltas: {
          delta: () => {
            throw new Error("sink down")
          },
        },
      },
      { state: createAgentState("delta-throw") },
    )
    expect(result.status).toBe("completed")
  })
})

describe("combineAgentDeltaSinks", () => {
  test("fans out in order, isolates a throwing sink, and collapses like telemetry", () => {
    const calls: string[] = []
    const sink = (label: string, fail = false): AgentDeltaSink => ({
      delta: (delta) => {
        if (fail) throw new Error("down")
        calls.push(`${label}:${delta.kind}`)
      },
    })
    const combined = combineAgentDeltaSinks(undefined, sink("a", true), sink("b"))
    combined?.delta({ kind: "reasoning", text: "t" })
    expect(calls).toEqual(["b:reasoning"])
    const only = sink("solo")
    expect(combineAgentDeltaSinks(undefined, only)).toBe(only)
    expect(combineAgentDeltaSinks(undefined, undefined)).toBeUndefined()
  })
})

describe("createAgentSharedState", () => {
  test("applies the RFC 6902 subset and snapshots defensively", () => {
    const state = createAgentSharedState<Record<string, unknown>>({ items: ["a"], keep: 1 })
    state.patch([
      { op: "add", path: "/items/-", value: "b" },
      { op: "add", path: "/items/0", value: "z" },
      { op: "replace", path: "/keep", value: 2 },
      { op: "add", path: "/x~1y", value: true },
      { op: "remove", path: "/items/1" },
    ])
    const snapshot = state.snapshot()
    expect(snapshot).toEqual({ items: ["z", "b"], keep: 2, "x/y": true })
    ;(snapshot.items as string[]).push("mutated")
    expect(state.snapshot().items).toEqual(["z", "b"])
  })

  test("rejects a bad batch atomically and guards prototype paths", () => {
    const state = createAgentSharedState<Record<string, unknown>>({ a: 1 })
    expect(() =>
      state.patch([
        { op: "replace", path: "/a", value: 2 },
        { op: "replace", path: "/missing", value: 3 },
      ]),
    ).toThrow(TypeError)
    expect(state.snapshot()).toEqual({ a: 1 })
    expect(() => state.patch([{ op: "add", path: "/__proto__/polluted", value: 1 }])).toThrow(
      TypeError,
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(() => state.patch([{ op: "remove", path: "" }])).toThrow(TypeError)
    expect(() => state.patch([{ op: "add", path: "no-slash", value: 1 }])).toThrow(TypeError)
  })

  test("notifies subscribers with the applied ops and isolates listener failures", () => {
    const state = createAgentSharedState<Record<string, unknown>>({})
    const seen: (readonly AgentStatePatchOp[])[] = []
    state.subscribe(() => {
      throw new Error("listener down")
    })
    const unsubscribe = state.subscribe((ops) => seen.push(ops))
    state.patch([{ op: "add", path: "/a", value: 1 }])
    expect(seen).toEqual([[{ op: "add", path: "/a", value: 1 }]])
    unsubscribe()
    state.patch([{ op: "replace", path: "/a", value: 2 }])
    expect(seen).toHaveLength(1)
    expect(state.snapshot()).toEqual({ a: 2 })
  })

  test("replaces the whole document through the root path", () => {
    const state = createAgentSharedState<unknown>({ old: true })
    state.patch([{ op: "replace", path: "", value: { fresh: true } }])
    expect(state.snapshot()).toEqual({ fresh: true })
  })
})
