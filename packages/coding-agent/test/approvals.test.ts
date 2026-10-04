import { describe, expect, test } from "bun:test"
import {
  AGENT_PROTOCOL_VERSION,
  type AgentApprovalRequiredEvent,
  type DecisionCoordinate,
} from "@nifrajs/agent-protocol"
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

  test("a decision made while the broadcast is still in flight reaches the waiter", async () => {
    const manager: ApprovalManager = new ApprovalManager({
      onRequired: async (request) => {
        manager.resolve(request.id, true)
        await Bun.sleep(1)
      },
    })
    const approved = manager.request({
      id: "fast",
      sessionId: "session",
      action: "deploy",
      capability: "deploy",
    })
    await expect(approved).resolves.toBe(true)
    manager.close()
  })

  test("a second approval for a pending id is refused and leaves the first one waiting", async () => {
    const manager = new ApprovalManager({ timeoutMs: 60_000 })
    const input = { id: "dup", sessionId: "session", capability: "deploy" }
    const first = manager.request({ ...input, action: "deploy prod" })
    await expect(manager.request({ ...input, action: "deploy staging" })).resolves.toBe(false)
    expect(await manager.offer({ ...input, action: "deploy staging" })).toBeUndefined()
    expect(manager.pending.map((request) => request.action)).toEqual(["deploy prod"])
    manager.resolve("dup", true)
    await expect(first).resolves.toBe(true)
  })

  test("observes any protocol-valid approval, including a slash id and a long action", async () => {
    const manager = new ApprovalManager()
    const event: AgentApprovalRequiredEvent = {
      version: AGENT_PROTOCOL_VERSION,
      sessionId: "workspace/session-1",
      seq: 1,
      at: 0,
      type: "approval.required",
      turnId: "turn-1",
      approvalId: "tool/bash-1",
      action: "x".repeat(600),
      capability: "shell",
    }
    const observed = await manager.observe(event)
    expect(observed?.id).toBe("tool/bash-1")
    expect(observed?.action).toHaveLength(512)
    manager.close()
  })

  test("a failing onResolved broadcast does not surface as an unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", record)
    try {
      const manager = new ApprovalManager({
        onResolved: () => Promise.reject(new Error("broadcast down")),
      })
      await manager.offer({ id: "a", sessionId: "session", action: "deploy", capability: "deploy" })
      expect(manager.resolve("a", true)?.approved).toBe(true)
      await Bun.sleep(5)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", record)
    }
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

  test("the untyped path can deny a coordinate-bound approval but never approve it", async () => {
    const manager = await withBound()
    expect(manager.resolve("bound-1", true)).toBeUndefined()
    expect(manager.pending).toHaveLength(1)
    expect(manager.resolve("bound-1", false)?.approved).toBe(false)
    expect(manager.pending).toHaveLength(0)
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
