import { expect, test } from "bun:test"
import {
  type AgentEventView,
  type BoundaryStateView,
  boundaryCommands,
  boundaryIsStale,
  toEvalComparisonView,
  toEventView,
  toEvidenceTimelineView,
  toFaultInjectionViews,
  toHandoffView,
  toRegistryCapabilityView,
  toRunStudioView,
  toRunView,
  virtualizeEvidenceRows,
} from "../src/view-models.ts"

const digest = "e".repeat(64)

test("run studio projections reconstruct branches, retries, and recovery from evidence", () => {
  const run = toRunStudioView({
    runId: "run-1",
    planId: "plan-1",
    planDigest: digest,
    cursor: 5,
    state: "running",
    traceRef: "trace-1",
    replayRef: "replay-1",
    nodes: [
      {
        nodeId: "node-2",
        dependsOn: ["node-1"],
        state: "recovered",
        attempt: 2,
        retryCount: 1,
        checkpointed: true,
        cancelled: false,
        recovered: true,
      },
      {
        nodeId: "node-1",
        dependsOn: [],
        state: "succeeded",
        attempt: 1,
        retryCount: 0,
        checkpointed: true,
        cancelled: false,
        recovered: false,
      },
    ],
  })
  expect(run?.nodes.map((node) => node.nodeId)).toEqual(["node-1", "node-2"])
  expect(run?.activeNodes).toBe(0)
  expect(run?.terminalNodes).toBe(1)
  expect(
    toRunStudioView({
      runId: "run",
      planId: "plan",
      planDigest: digest,
      cursor: 0,
      state: "running",
      nodes: [],
      output: "no",
    }),
  ).toBeUndefined()
})

test("a run graph that lists one node twice is refused, not counted twice", () => {
  const node = {
    nodeId: "node-1",
    dependsOn: [],
    state: "running",
    attempt: 1,
    retryCount: 0,
    checkpointed: false,
    cancelled: false,
    recovered: false,
  }
  const run = { runId: "run", planId: "plan", planDigest: digest, cursor: 0, state: "running" }
  expect(toRunStudioView({ ...run, nodes: [node] })?.activeNodes).toBe(1)
  expect(toRunStudioView({ ...run, nodes: [node, node] })).toBeUndefined()
})

test("a boundary whose expiry or clock is not a number is stale and offers no command", () => {
  const unreadable: BoundaryStateView = {
    kind: "approval",
    state: "pending",
    expiresAt: Number.NaN,
  }
  expect(boundaryIsStale(unreadable, 0)).toBe(true)
  expect(boundaryCommands(unreadable, { inbox: true, now: 0 })).toEqual([])
  const live: BoundaryStateView = { kind: "handoff", state: "pending", expiresAt: 10 }
  expect(boundaryCommands(live, { inbox: true, now: Number.NaN })).toEqual([])
  expect(boundaryCommands(live, { inbox: true, now: 0 }).length).toBeGreaterThan(0)
})

test("timeline and eval views drop content and retain opaque references", () => {
  const timeline = toEvidenceTimelineView([
    {
      seq: 2,
      eventId: "run:2",
      runId: "run",
      nodeId: "node",
      status: "completed",
      attempt: 2,
      replayRef: "replay",
      output: "never",
    },
    {
      seq: 1,
      eventId: "run:1",
      runId: "run",
      nodeId: "node",
      status: "retrying",
      attempt: 1,
      scheduleToken: "job:1",
    },
  ])
  expect(timeline.map((row) => row.seq)).toEqual([1])
  const evalView = toEvalComparisonView({
    suiteId: "suite",
    comparisons: [
      { caseId: "case", rubricId: "rubric", code: "regressed", regressionId: "suite/case/rubric" },
    ],
    regressions: ["suite/case/rubric"],
  })
  expect(evalView?.comparisons[0]?.code).toBe("regressed")
  expect(
    toFaultInjectionViews([
      {
        id: "fault",
        kind: "lease",
        scheduleToken: "seed:1",
        regressionId: "fault/1",
        ok: true,
        message: "drop",
      },
    ]),
  ).toEqual([])
})

test("histories over 1,000 rows are windowed", () => {
  const rows = Array.from({ length: 2_000 }, (_unused, index) => index)
  const window = virtualizeEvidenceRows(rows, 1_500, 100)
  expect(window.rows).toHaveLength(100)
  expect(window.offset).toBe(1_450)
})

test("the event projection rejects malformed payloads instead of dereferencing them", () => {
  expect(() =>
    toEventView({
      version: 1,
      sessionId: "s",
      seq: 1,
      at: 1,
      type: "assistant.delta",
      turnId: "t",
      text: null,
    } as never),
  ).toThrow("agent event is invalid")
})

test("an extension event projects to its type and turn, never its data", () => {
  const base = { version: 1, sessionId: "s", seq: 4, at: 9 } as const
  const view = toEventView({ ...base, type: "x-codex.plan", turnId: "t", data: { secret: "plan" } })
  expect(view).toEqual({ seq: 4, at: 9, kind: "x-codex.plan", turnId: "t", hasData: true })
  expect(toEventView({ ...base, type: "x-acme.ping" })).toEqual({
    seq: 4,
    at: 9,
    kind: "x-acme.ping",
    hasData: false,
  })
})

test("reasoning, plan, and usage events project to counts", () => {
  const base = { version: 1, sessionId: "s", seq: 1, at: 2 } as const
  expect(toEventView({ ...base, type: "reasoning.delta", turnId: "t", text: "abc" })).toEqual({
    seq: 1,
    at: 2,
    kind: "reasoning.delta",
    turnId: "t",
    chars: 3,
  })
  expect(
    toEventView({
      ...base,
      type: "plan.updated",
      turnId: "t",
      entries: [
        { content: "secret step", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ],
    }),
  ).toEqual({
    seq: 1,
    at: 2,
    kind: "plan.updated",
    turnId: "t",
    entries: 3,
    inProgress: 1,
    completed: 1,
  })
  expect(
    toEventView({ ...base, type: "context.usage", usedTokens: 300, windowTokens: 200 }),
  ).toEqual({
    seq: 1,
    at: 2,
    kind: "context.usage",
    usedTokens: 300,
    windowTokens: 200,
    fill: 1,
    estimated: false,
  })
  expect(toEventView({ ...base, type: "context.usage", usedTokens: 5, estimated: true })).toEqual({
    seq: 1,
    at: 2,
    kind: "context.usage",
    usedTokens: 5,
    estimated: true,
  })
})

test("every protocol event kind projects to ids and counts, never its content", () => {
  const base = { version: 1, sessionId: "s", seq: 3, at: 7 } as const
  const view = { seq: 3, at: 7 }
  const snapshot = {
    version: 1,
    id: "s",
    backend: "native",
    cwd: "/secret/path",
    status: "running",
    createdAt: 1,
    updatedAt: 2,
    lastSeq: 3,
    extensionRevision: "rev-2",
    capabilities: ["read"],
  } as const
  const cases: [Parameters<typeof toEventView>[0], AgentEventView][] = [
    [
      { ...base, type: "session.updated", snapshot },
      {
        ...view,
        kind: "session.updated",
        session: {
          id: "s",
          backend: "native",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
          lastSeq: 3,
          extensionRevision: "rev-2",
          capabilities: ["read"],
        },
      },
    ],
    [
      { ...base, type: "turn.started", turnId: "t", prompt: "secret prompt" },
      { ...view, kind: "turn.started", turnId: "t" },
    ],
    [
      { ...base, type: "tool.started", turnId: "t", callId: "c", name: "read", input: { a: 1 } },
      { ...view, kind: "tool.started", turnId: "t", callId: "c", name: "read", hasInput: true },
    ],
    [
      { ...base, type: "tool.delta", turnId: "t", callId: "c", text: "secret" },
      { ...view, kind: "tool.delta", turnId: "t", callId: "c", chars: 6 },
    ],
    [
      {
        ...base,
        type: "tool.completed",
        turnId: "t",
        callId: "c",
        name: "read",
        ok: false,
        error: { code: "TOOL_FAILED", message: "secret" },
      },
      {
        ...view,
        kind: "tool.completed",
        turnId: "t",
        callId: "c",
        name: "read",
        ok: false,
        errorCode: "TOOL_FAILED",
      },
    ],
    [
      {
        ...base,
        type: "approval.required",
        turnId: "t",
        approvalId: "a",
        action: "deploy",
        capability: "deploy",
      },
      {
        ...view,
        kind: "approval.required",
        turnId: "t",
        approvalId: "a",
        action: "deploy",
        capability: "deploy",
      },
    ],
    [
      { ...base, type: "approval.resolved", turnId: "t", approvalId: "a", approved: true },
      { ...view, kind: "approval.resolved", approvalId: "a", approved: true, turnId: "t" },
    ],
    [
      {
        ...base,
        type: "repair.required",
        turnId: "t",
        task: {
          id: "r",
          verification: "check",
          cwd: "/secret",
          reason: "secret",
          capabilities: ["write"],
        },
      },
      {
        ...view,
        kind: "repair.required",
        taskId: "r",
        verification: "check",
        capabilities: ["write"],
        turnId: "t",
      },
    ],
    [
      { ...base, type: "verification.completed", name: "test", ok: true },
      { ...view, kind: "verification.completed", name: "test", ok: true },
    ],
    [
      { ...base, type: "memory.compacted", before: 9, after: 4, reason: "threshold" },
      { ...view, kind: "memory.compacted", before: 9, after: 4, reason: "threshold" },
    ],
    [
      {
        ...base,
        type: "extension.reloaded",
        revision: "r2",
        loaded: ["a", "b"],
        disabled: ["c"],
        rolledBack: false,
      },
      {
        ...view,
        kind: "extension.reloaded",
        revision: "r2",
        loadedCount: 2,
        disabledCount: 1,
        rolledBack: false,
      },
    ],
    [
      {
        ...base,
        type: "session.failed",
        error: { code: "MODEL_FAILED", message: "secret" },
        recoverable: true,
      },
      { ...view, kind: "session.failed", errorCode: "MODEL_FAILED", recoverable: true },
    ],
    [
      { ...base, type: "session.stopped", reason: "done" },
      { ...view, kind: "session.stopped" },
    ],
  ]
  for (const [event, expected] of cases) {
    const projected = toEventView(event)
    expect(projected).toEqual(expected)
    expect(JSON.stringify(projected)).not.toContain("secret")
  }
})

test("run and handoff views keep progress and routing, never the handoff reason", () => {
  expect(
    toRunView({
      version: 1,
      runId: "run-1",
      plan: { id: "plan-1", digest, nodeCount: 4 },
      state: "failed",
      cursor: 7,
      counters: { total: 4, completed: 2, failed: 1 },
      updatedAt: 99,
      failureCode: "node_failed",
    }),
  ).toEqual({
    runId: "run-1",
    planId: "plan-1",
    planDigest: digest,
    nodeCount: 4,
    state: "failed",
    cursor: 7,
    total: 4,
    completed: 2,
    failed: 1,
    updatedAt: 99,
    failureCode: "node_failed",
  })
  expect(
    toHandoffView({
      version: 1,
      runId: "run-1",
      nodeId: "node-1",
      seq: 3,
      from: "planner",
      to: "coder",
      status: "accepted",
      reason: "secret reason",
    }),
  ).toEqual({
    runId: "run-1",
    nodeId: "node-1",
    seq: 3,
    from: "planner",
    to: "coder",
    status: "accepted",
  })
})

test("a registry descriptor projects to its identity card or to nothing", () => {
  const descriptor = {
    kind: "tool",
    name: "read_file",
    version: "1.0.0",
    schemaDigest: digest,
    requiredCapabilities: ["read"],
    approval: { kind: "threshold", level: 2 },
    retry: "idempotent",
    idempotency: "request",
    isolation: "process",
    description: "secret instructions",
    inputSchema: { secret: true },
  }
  expect(toRegistryCapabilityView(descriptor)).toEqual({
    kind: "tool",
    name: "read_file",
    version: "1.0.0",
    schemaDigest: digest,
    requiredCapabilities: ["read"],
    approval: "threshold",
    approvalLevel: 2,
    retry: "idempotent",
    idempotency: "request",
    isolation: "process",
  })
  expect(toRegistryCapabilityView({ ...descriptor, approval: { kind: "required" } })).toMatchObject(
    { approval: "required" },
  )
  for (const broken of [
    null,
    [],
    { ...descriptor, kind: "plugin" },
    { ...descriptor, name: "" },
    { ...descriptor, schemaDigest: "abc" },
    { ...descriptor, requiredCapabilities: [1] },
    { ...descriptor, retry: "always" },
    { ...descriptor, isolation: "vm" },
    { ...descriptor, approval: "required" },
    { ...descriptor, approval: { kind: "threshold", level: 1.5 } },
  ])
    expect(toRegistryCapabilityView(broken)).toBeUndefined()
})
