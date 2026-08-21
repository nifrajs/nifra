import { describe, expect, test } from "bun:test"
import {
  CURSOR_BEFORE_ALL,
  evidenceEventId,
  negotiateFeatures,
  parseHandoffSnapshot,
  parseRunEvidenceEvent,
  parseRunPlanRef,
  parseRunSnapshot,
  RUN_LIFECYCLE_VERSION,
  RunContractError,
  resumeFromCursor,
} from "../src/index.ts"

const DIGEST = "a".repeat(64)

const evidence = (runId: string, seq: number, extra: Record<string, unknown> = {}) => ({
  version: 1,
  runId,
  planDigest: DIGEST,
  nodeId: "n1",
  status: "completed" as const,
  seq,
  idempotent: false,
  ...extra,
})

describe("feature negotiation", () => {
  test("splits requested features into granted and unsupported, sorted and deduped", () => {
    const result = negotiateFeatures(["a", "b", "c"], ["c", "a", "z", "z"])
    expect(result.granted).toEqual(["a", "c"])
    expect(result.unsupported).toEqual(["z"])
  })

  test("an empty request grants nothing", () => {
    const result = negotiateFeatures(["a"], [])
    expect(result.granted).toEqual([])
    expect(result.unsupported).toEqual([])
  })
})

describe("cursor resume", () => {
  const window = [{ seq: 3 }, { seq: 4 }, { seq: 5 }]

  test("a fresh subscription replays the whole window", () => {
    const undefinedCursor = resumeFromCursor(window)
    const beforeAll = resumeFromCursor(window, CURSOR_BEFORE_ALL)
    for (const result of [undefinedCursor, beforeAll]) {
      expect(result.status).toBe("ok")
      if (result.status !== "ok") throw new Error("unreachable")
      expect(result.events.map((e) => e.seq)).toEqual([3, 4, 5])
      expect(result.nextCursor).toBe(5)
    }
  })

  test("a valid cursor resumes at the next sequence", () => {
    const result = resumeFromCursor(window, 3)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.events.map((e) => e.seq)).toEqual([4, 5])
    expect(result.nextCursor).toBe(5)
  })

  test("resuming at the tip yields nothing and holds the cursor", () => {
    const result = resumeFromCursor(window, 5)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.events).toEqual([])
    expect(result.nextCursor).toBe(5)
  })

  test("a real cursor whose next record was evicted forces a resync", () => {
    // The client holds seq 0 and wants seq 1, but the bounded window now starts at 3: a gap.
    const result = resumeFromCursor(window, 0)
    expect(result.status).toBe("resync_required")
    if (result.status !== "resync_required") throw new Error("unreachable")
    expect(result.reason).toBe("stale_cursor")
    expect(result.earliest).toBe(3)
    expect(result.latest).toBe(5)
  })

  test("a contiguous cursor at earliest-1 is not a gap", () => {
    const result = resumeFromCursor(window, 2)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.events.map((e) => e.seq)).toEqual([3, 4, 5])
  })

  test("an empty window is ok and preserves the cursor", () => {
    const result = resumeFromCursor([], 7)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.events).toEqual([])
    expect(result.nextCursor).toBe(7)
  })

  test("rejects an unsorted window and a bad cursor", () => {
    expect(() => resumeFromCursor([{ seq: 5 }, { seq: 4 }])).toThrow(RunContractError)
    expect(() => resumeFromCursor(window, 1.5)).toThrow(/safe integer/)
    expect(() => resumeFromCursor(window, -2)).toThrow(/safe integer/)
  })
})

describe("evidence event envelope", () => {
  test("derives a stable event id and validates the inner record strictly", () => {
    const event = parseRunEvidenceEvent({ version: 1, evidence: evidence("run-1", 2) })
    expect(event.eventId).toBe("run-1:2")
    expect(event.eventId).toBe(evidenceEventId("run-1", 2))
    expect(event.evidence.seq).toBe(2)
  })

  test("rejects a mismatched event id", () => {
    expect(() =>
      parseRunEvidenceEvent({ version: 1, eventId: "run-1:99", evidence: evidence("run-1", 2) }),
    ).toThrow(/must match/)
  })

  test("rejects a content key smuggled onto the inner record", () => {
    expect(() =>
      parseRunEvidenceEvent({ version: 1, evidence: evidence("run-1", 2, { output: "secret" }) }),
    ).toThrow(RunContractError)
  })

  test("rejects a content key smuggled onto the envelope", () => {
    expect(() =>
      parseRunEvidenceEvent({ version: 1, prompt: "leak", evidence: evidence("run-1", 2) }),
    ).toThrow(/forbidden content key/)
  })
})

describe("forward-compatible transport decoders", () => {
  test("run snapshot ignores unknown additive fields but rejects content", () => {
    const snapshot = parseRunSnapshot({
      version: 1,
      runId: "run-1",
      plan: { id: "p", digest: DIGEST, nodeCount: 3, extraPlanField: "future" },
      state: "running",
      cursor: 4,
      counters: { total: 3, completed: 1, failed: 0 },
      updatedAt: 1000,
      futureField: { added: "later" },
    })
    expect(snapshot.state).toBe("running")
    expect(snapshot.plan.nodeCount).toBe(3)
    expect(snapshot.version).toBe(RUN_LIFECYCLE_VERSION)
    expect(() =>
      parseRunSnapshot({
        version: 1,
        runId: "run-1",
        plan: { id: "p", digest: DIGEST, nodeCount: 3 },
        state: "running",
        cursor: 4,
        counters: { total: 3, completed: 1, failed: 0 },
        updatedAt: 1000,
        prompt: "leak",
      }),
    ).toThrow(/forbidden content key/)
  })

  test("run snapshot rejects an invalid state and cursor", () => {
    const base = {
      version: 1,
      runId: "run-1",
      plan: { id: "p", digest: DIGEST, nodeCount: 1 },
      counters: { total: 1, completed: 0, failed: 0 },
      updatedAt: 1,
    }
    expect(() => parseRunSnapshot({ ...base, state: "exploded", cursor: 0 })).toThrow(/state/)
    expect(() => parseRunSnapshot({ ...base, state: "running", cursor: -2 })).toThrow(/cursor/)
  })

  test("plan ref requires a sha256 digest", () => {
    expect(() => parseRunPlanRef({ id: "p", digest: "short", nodeCount: 1 })).toThrow(/sha256/)
  })

  test("handoff snapshot decodes forward-compatibly and validates status", () => {
    const handoff = parseHandoffSnapshot({
      version: 1,
      runId: "run-1",
      nodeId: "n1",
      seq: 5,
      from: "planner",
      to: "executor",
      status: "pending",
      futureField: 1,
    })
    expect(handoff.status).toBe("pending")
    expect(handoff.to).toBe("executor")
    expect(() =>
      parseHandoffSnapshot({
        version: 1,
        runId: "run-1",
        nodeId: "n1",
        seq: 5,
        from: "planner",
        to: "executor",
        status: "sideways",
      }),
    ).toThrow(/status/)
  })
})
