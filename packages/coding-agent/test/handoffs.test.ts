import { beforeEach, describe, expect, test } from "bun:test"
import type { DecisionCoordinate } from "@nifrajs/agent-protocol"
import { ApprovalManager } from "../src/approvals.ts"
import { HandoffCoordinator, HandoffError, type HandoffView } from "../src/handoffs.ts"

let clock = 1_000
const now = () => clock

function coordOf(view: HandoffView): DecisionCoordinate {
  return {
    runId: view.runId,
    nodeId: view.nodeId,
    capability: view.capability,
    requestId: view.requestId,
    vector: view.vector,
    expiresAt: view.expiresAt,
  }
}

function open(
  coordinator: HandoffCoordinator,
  requestId = "req-1",
  nodeId = "node-1",
): HandoffView {
  return coordinator.open({
    runId: "run-1",
    nodeId,
    capability: "delegate",
    requestId,
    from: "planner",
    expiresInMs: 1_000,
  })
}

beforeEach(() => {
  clock = 1_000
})

describe("HandoffCoordinator lifecycle", () => {
  test("opens pending with a monotonic per-run vector", () => {
    const coordinator = new HandoffCoordinator({ now })
    const a = open(coordinator, "req-1", "node-1")
    const b = open(coordinator, "req-2", "node-2")
    expect(a.state).toBe("pending")
    expect(a.vector).toBe(0)
    expect(b.vector).toBe(1)
    expect(coordinator.list(true)).toHaveLength(2)
  })

  test("rejects a duplicate request id", () => {
    const coordinator = new HandoffCoordinator({ now })
    open(coordinator, "req-1")
    expect(() => open(coordinator, "req-1")).toThrow(HandoffError)
  })

  test("rejects an unknown boundary", () => {
    const coordinator = new HandoffCoordinator({ now })
    const missing: DecisionCoordinate = {
      runId: "run-1",
      nodeId: "node-1",
      capability: "delegate",
      requestId: "ghost",
      vector: 0,
      expiresAt: clock + 1_000,
    }
    expect(() => coordinator.accept({ coordinate: missing })).toThrow(
      expect.objectContaining({ code: "unknown_boundary" }),
    )
  })

  test("rejects a mismatched identity", () => {
    const coordinator = new HandoffCoordinator({ now })
    const view = open(coordinator)
    const wrongNode = { ...coordOf(view), nodeId: "other" }
    expect(() => coordinator.accept({ coordinate: wrongNode })).toThrow(
      expect.objectContaining({ code: "identity_mismatch" }),
    )
  })

  test("rejects a superseded child vector as stale", () => {
    const coordinator = new HandoffCoordinator({ now })
    const view = open(coordinator)
    const stale = { ...coordOf(view), vector: view.vector + 5 }
    expect(() => coordinator.accept({ coordinate: stale })).toThrow(
      expect.objectContaining({ code: "stale_vector" }),
    )
  })

  test("expires closed at the deadline and resumes no work", () => {
    const coordinator = new HandoffCoordinator({ now })
    const view = open(coordinator)
    clock = view.expiresAt // at expiry: fails closed
    expect(() => coordinator.resolve({ coordinate: coordOf(view) })).toThrow(
      expect.objectContaining({ code: "expired" }),
    )
    expect(coordinator.inspect(view.requestId)?.state).toBe("expired")
  })

  test("rejects an illegal transition from a terminal state", () => {
    const coordinator = new HandoffCoordinator({ now })
    const view = open(coordinator)
    coordinator.decline({ coordinate: coordOf(view) })
    expect(() => coordinator.accept({ coordinate: coordOf(view) })).toThrow(
      expect.objectContaining({ code: "illegal_transition" }),
    )
  })

  test("rejects an authority-expanding decision on an assigned boundary", () => {
    const coordinator = new HandoffCoordinator({ now })
    const view = open(coordinator)
    coordinator.assign({ coordinate: coordOf(view), by: "owner-a" })
    expect(() => coordinator.accept({ coordinate: coordOf(view), by: "owner-b" })).toThrow(
      expect.objectContaining({ code: "authority_expanded" }),
    )
  })

  test("assign then resolve by the owner resumes exactly one boundary", () => {
    const coordinator = new HandoffCoordinator({ now })
    const view = open(coordinator)
    const assigned = coordinator.assign({ coordinate: coordOf(view), by: "owner-a" })
    expect(assigned.state).toBe("assigned")
    expect(assigned.to).toBe("owner-a")
    const resolved = coordinator.resolve({ coordinate: coordOf(view), by: "owner-a" })
    expect(resolved.state).toBe("resolved")
    expect(coordinator.list(true)).toHaveLength(0)
  })

  test("resolves a paired approval on accept when composed with an ApprovalManager", () => {
    const approvals = new ApprovalManager({ timeoutMs: 60_000 })
    const coordinator = new HandoffCoordinator({ now, approvals })
    const view = coordinator.open({
      runId: "run-1",
      nodeId: "node-1",
      capability: "delegate",
      requestId: "req-approval",
      from: "planner",
      requireApproval: true,
      expiresInMs: 1_000,
    })
    expect(approvals.pending.map((request) => request.id)).toContain("req-approval")
    coordinator.accept({ coordinate: coordOf(view) })
    expect(approvals.pending).toHaveLength(0)
    approvals.close()
  })
})
