import { expect, test } from "bun:test"
import { toEvidenceTimelineView, toRunStudioView, virtualizeEvidenceRows } from "@nifrajs/agent-app"

test("run studio reconstructs recovery evidence with bounded rows", () => {
  const digest = "f".repeat(64)
  const run = toRunStudioView({
    runId: "run-studio",
    planId: "plan-studio",
    planDigest: digest,
    cursor: 4,
    state: "recovered",
    nodes: [
      {
        nodeId: "node",
        dependsOn: [],
        state: "recovered",
        attempt: 2,
        retryCount: 1,
        checkpointed: true,
        cancelled: false,
        recovered: true,
      },
    ],
  })
  const timeline = toEvidenceTimelineView([
    {
      seq: 0,
      eventId: "run:0",
      runId: "run-studio",
      nodeId: "node",
      status: "retrying",
      attempt: 1,
    },
    {
      seq: 1,
      eventId: "run:1",
      runId: "run-studio",
      nodeId: "node",
      status: "recovered",
      attempt: 2,
      replayRef: "replay",
    },
  ])
  expect(run?.state).toBe("recovered")
  expect(timeline[1]?.replayRef).toBe("replay")
  expect(
    virtualizeEvidenceRows(
      Array.from({ length: 1_500 }, (_unused, index) => index),
      1_000,
    ).rows,
  ).toHaveLength(100)
})
