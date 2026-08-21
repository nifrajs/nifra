import { describe, expect, test } from "bun:test"
import type { DecisionCoordinate } from "@nifrajs/agent-protocol"
import { ApprovalManager } from "../src/approvals.ts"

function coordinate(overrides: Partial<DecisionCoordinate> = {}): DecisionCoordinate {
  return {
    runId: "run-1",
    nodeId: "node-1",
    capability: "filesystem",
    requestId: "bound-1",
    vector: 3,
    expiresAt: 5_000,
    ...overrides,
  }
}

describe("bounded approvals", () => {
  test("offers and resolves a host-owned approval", async () => {
    const manager = new ApprovalManager({ timeoutMs: 2_000 })
    const offered = await manager.offer({
      id: "approval-1",
      sessionId: "session",
      action: "write file",
      capability: "filesystem",
    })
    expect(offered?.id).toBe("approval-1")
    const decision = manager.resolve("approval-1", true, "looks good")
    expect(decision?.approved).toBe(true)
    expect(manager.pending).toHaveLength(0)
    manager.close()
  })

  test("waits for a decision and expires closed", async () => {
    const manager = new ApprovalManager({ timeoutMs: 10 })
    const result = manager.request({
      id: "approval-2",
      sessionId: "session",
      action: "run tests",
      capability: "process",
    })
    await expect(result).resolves.toBe(false)
    manager.close()
  })
})

describe("coordinate-matched approvals", () => {
  async function withBound(): Promise<ApprovalManager> {
    const manager = new ApprovalManager({ timeoutMs: 60_000 })
    await manager.offer({
      id: "bound-1",
      sessionId: "session",
      action: "write file",
      capability: "filesystem",
      coordinate: coordinate(),
    })
    return manager
  }

  test("admits a decision that matches the bound coordinate and is fresh", async () => {
    const manager = await withBound()
    const result = manager.resolveMatched(coordinate(), true, 1_000)
    expect(result).toEqual({
      ok: true,
      decision: expect.objectContaining({ approvalId: "bound-1", approved: true }),
    })
    expect(manager.pending).toHaveLength(0)
    manager.close()
  })

  test("fails closed for an unknown boundary", () => {
    const manager = new ApprovalManager({ timeoutMs: 60_000 })
    expect(manager.resolveMatched(coordinate(), true, 1_000)).toEqual({
      ok: false,
      code: "unknown_boundary",
    })
    manager.close()
  })

  test("fails closed for a coordinate-less approval", async () => {
    const manager = new ApprovalManager({ timeoutMs: 60_000 })
    await manager.offer({
      id: "bound-1",
      sessionId: "session",
      action: "write file",
      capability: "filesystem",
    })
    expect(manager.resolveMatched(coordinate(), true, 1_000)).toEqual({
      ok: false,
      code: "identity_mismatch",
    })
    manager.close()
  })

  test("rejects a mismatched identity", async () => {
    const manager = await withBound()
    expect(manager.resolveMatched(coordinate({ nodeId: "other" }), true, 1_000)).toEqual({
      ok: false,
      code: "identity_mismatch",
    })
    manager.close()
  })

  test("rejects a superseded child vector as stale", async () => {
    const manager = await withBound()
    expect(manager.resolveMatched(coordinate({ vector: 99 }), true, 1_000)).toEqual({
      ok: false,
      code: "stale_vector",
    })
    manager.close()
  })

  test("expires closed at the deadline", async () => {
    const manager = await withBound()
    expect(manager.resolveMatched(coordinate(), true, 5_000)).toEqual({
      ok: false,
      code: "expired",
    })
    expect(manager.pending).toHaveLength(0)
    manager.close()
  })
})
