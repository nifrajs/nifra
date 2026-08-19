import { describe, expect, test } from "bun:test"
import { ApprovalManager } from "../src/approvals.ts"

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
