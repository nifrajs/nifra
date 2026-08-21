import { describe, expect, test } from "bun:test"
import {
  AGENT_PROTOCOL_VERSION,
  CURSOR_BEFORE_ALL,
  negotiateFeatures,
  parseRunSnapshot,
  resumeFromCursor,
} from "../src/index.ts"

describe("protocol v1 compatibility matrix", () => {
  test("old client to new host keeps legacy features and ignores additive snapshot fields", () => {
    const negotiated = negotiateFeatures(
      ["approvals", "resume", "workflows", "run-graph"],
      ["approvals", "resume"],
    )
    expect(negotiated).toEqual({ granted: ["approvals", "resume"], unsupported: [] })
    const snapshot = parseRunSnapshot({
      version: 1,
      runId: "run-1",
      plan: { id: "plan-1", digest: "a".repeat(64), nodeCount: 1 },
      state: "running",
      cursor: -1,
      counters: { total: 1, completed: 0, failed: 0 },
      updatedAt: 10,
      futureField: { ignored: true },
    })
    expect(snapshot).not.toHaveProperty("futureField")
    expect(AGENT_PROTOCOL_VERSION).toBe(1)
  })

  test("new client to old host reports unsupported features without a transport failure", () => {
    expect(
      negotiateFeatures(["approvals", "resume"], ["approvals", "handoff", "run-graph"]),
    ).toEqual({
      granted: ["approvals"],
      unsupported: ["handoff", "run-graph"],
    })
  })

  test("new client and new host use the feature intersection", () => {
    expect(
      negotiateFeatures(["approvals", "handoff", "resume"], ["resume", "handoff", "eval"]),
    ).toEqual({
      granted: ["handoff", "resume"],
      unsupported: ["eval"],
    })
  })

  test("a cursor gap is explicit in every version matrix cell", () => {
    expect(resumeFromCursor([{ seq: 4 }, { seq: 5 }], 0)).toEqual({
      status: "resync_required",
      reason: "stale_cursor",
      earliest: 4,
      latest: 5,
    })
    expect(resumeFromCursor([{ seq: 4 }, { seq: 5 }], CURSOR_BEFORE_ALL)).toEqual({
      status: "ok",
      events: [{ seq: 4 }, { seq: 5 }],
      nextCursor: 5,
    })
  })
})
