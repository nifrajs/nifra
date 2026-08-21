import { expect, test } from "bun:test"
import {
  toEvalComparisonView,
  toEvidenceTimelineView,
  toFaultInjectionViews,
  toRunStudioView,
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
