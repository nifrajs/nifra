import { describe, expect, jest, setSystemTime, test } from "bun:test"
import {
  AGENT_PROTOCOL_VERSION,
  type AgentApprovalRequiredEvent,
  type DecisionCoordinate,
} from "@nifrajs/agent-protocol"
import {
  APPROVAL_NEVER_EXPIRES_AT,
  ApprovalManager,
  approvalRequestFromEvent,
} from "../src/approvals.ts"

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

function requiredEvent(at: number): AgentApprovalRequiredEvent {
  return {
    version: AGENT_PROTOCOL_VERSION,
    sessionId: "session",
    seq: 1,
    at,
    type: "approval.required",
    turnId: "turn-1",
    approvalId: "tool-1",
    action: "write file",
    capability: "filesystem",
  }
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  jest.useFakeTimers()
  try {
    await run()
  } finally {
    jest.useRealTimers()
  }
}

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

  test("an approve that arrives after the deadline, before the late timer, is denied", async () => {
    setSystemTime(new Date(1_000_000))
    try {
      const manager = new ApprovalManager({ timeoutMs: 2_000 })
      const offered = await manager.offer({
        id: "approval-late",
        sessionId: "session",
        action: "write file",
        capability: "filesystem",
      })
      expect(offered?.expiresAt).toBe(1_002_000)
      setSystemTime(new Date(1_002_000))
      const decision = manager.resolve("approval-late", true, "looks good")
      expect(decision).toMatchObject({ approved: false, reason: "approval timed out" })
      manager.close()
    } finally {
      setSystemTime()
    }
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

describe("a broadcast hook that never settles", () => {
  const input = { sessionId: "session", action: "deploy", capability: "deploy" }
  const hung = (): Promise<void> => new Promise(() => {})
  // Drains microtasks only, so a caller still stuck on the hook reads as unsettled instead of hanging
  // the test (fake timers would stop a timeout from ever firing).
  async function settled<T>(promise: Promise<T>): Promise<{ value: T } | "unsettled"> {
    let outcome: { value: T } | "unsettled" = "unsettled"
    void promise.then((value) => {
      outcome = { value }
    })
    for (let i = 0; i < 100; i++) await null
    return outcome
  }

  test("the caller still gets the timeout", () =>
    withFakeTimers(async () => {
      const manager = new ApprovalManager({ timeoutMs: 10, onRequired: hung })
      const approved = manager.request({ ...input, id: "timeout" })
      const offered = manager.offer({ ...input, id: "offered" })
      jest.advanceTimersByTime(10)
      expect(await settled(approved)).toEqual({ value: false })
      expect(await settled(offered)).toMatchObject({ value: { id: "offered" } })
      expect(manager.pending).toHaveLength(0)
    }))

  test("the caller still gets an approval, a denial, and a close", async () => {
    const manager = new ApprovalManager({ timeoutMs: "never", onRequired: hung })
    const approved = manager.request({ ...input, id: "approved" })
    const denied = manager.request({ ...input, id: "denied" })
    const closed = manager.request({ ...input, id: "closed" })
    manager.resolve("approved", true)
    manager.resolve("denied", false)
    manager.close()
    expect(await settled(approved)).toEqual({ value: true })
    expect(await settled(denied)).toEqual({ value: false })
    expect(await settled(closed)).toEqual({ value: false })
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

describe("approval timeouts", () => {
  const input = { sessionId: "session", action: "deploy", capability: "deploy" }

  test("the default timeout is still 5 minutes and expires closed", () =>
    withFakeTimers(async () => {
      const manager = new ApprovalManager()
      expect(manager.timeoutMs).toBe(5 * MINUTE_MS)
      const approved = manager.request({ ...input, id: "default" })
      const [request] = manager.pending
      expect(request?.expiresAt).toBe((request?.createdAt ?? 0) + 5 * MINUTE_MS)
      jest.advanceTimersByTime(5 * MINUTE_MS - 1)
      expect(manager.pending).toHaveLength(1)
      jest.advanceTimersByTime(1)
      expect(manager.pending).toHaveLength(0)
      await expect(approved).resolves.toBe(false)
    }))

  test("a numeric timeout up to 24 hours expires closed at that timeout", () =>
    withFakeTimers(async () => {
      const decisions: (string | undefined)[] = []
      const manager = new ApprovalManager({
        timeoutMs: DAY_MS,
        onResolved: (decision) => {
          decisions.push(decision.reason)
        },
      })
      const approved = manager.request({ ...input, id: "day" })
      const [request] = manager.pending
      expect(request?.expiresAt).toBe((request?.createdAt ?? 0) + DAY_MS)
      jest.advanceTimersByTime(DAY_MS - 1)
      expect(manager.resolve("other", true)).toBeUndefined()
      expect(manager.pending).toHaveLength(1)
      jest.advanceTimersByTime(1)
      await expect(approved).resolves.toBe(false)
      expect(decisions).toEqual(["approval timed out"])
    }))

  test('a "never" approval is still pending and answerable after more than 24 hours', () =>
    withFakeTimers(async () => {
      const manager = new ApprovalManager({ timeoutMs: "never" })
      expect(manager.timeoutMs).toBe("never")
      const approved = manager.request({ ...input, id: "slow" })
      expect(jest.getTimerCount()).toBe(0)
      jest.advanceTimersByTime(DAY_MS + MINUTE_MS)
      const [request] = manager.pending
      expect(request?.id).toBe("slow")
      expect(request?.expiresAt).toBe(APPROVAL_NEVER_EXPIRES_AT)
      // The sentinel survives JSON and reads as live to the `now < expiresAt` a client runs.
      const wire: { expiresAt: number } = JSON.parse(JSON.stringify(request))
      expect(wire.expiresAt).toBe(APPROVAL_NEVER_EXPIRES_AT)
      expect(Date.now() < wire.expiresAt).toBe(true)
      expect(Number.isNaN(new Date(wire.expiresAt).getTime())).toBe(false)
      expect(manager.resolve("slow", true, "back from lunch")?.approved).toBe(true)
      await expect(approved).resolves.toBe(true)
    }))

  test('a "never" approval is still denied by an explicit answer and by close', () =>
    withFakeTimers(async () => {
      const manager = new ApprovalManager({ timeoutMs: "never" })
      const denied = manager.request({ ...input, id: "denied" })
      const closed = manager.request({ ...input, id: "closed" })
      jest.advanceTimersByTime(DAY_MS + MINUTE_MS)
      expect(manager.resolve("denied", false)?.approved).toBe(false)
      await expect(denied).resolves.toBe(false)
      manager.close()
      await expect(closed).resolves.toBe(false)
      expect(manager.pending).toHaveLength(0)
    }))

  test('maxPending still bounds "never" approvals', async () => {
    const manager = new ApprovalManager({ timeoutMs: "never", maxPending: 1 })
    expect(await manager.offer({ ...input, id: "first" })).toBeDefined()
    expect(await manager.offer({ ...input, id: "second" })).toBeUndefined()
    manager.close()
  })

  test("rejects every other timeout value", () => {
    // As an untyped caller (plain JS, a parsed config file) would pass them.
    const invalid: readonly unknown[] = [
      0,
      -1,
      1.5,
      DAY_MS + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "forever",
      "Never",
      "",
      "300000",
      false,
    ]
    for (const timeoutMs of invalid) {
      expect(() => Reflect.construct(ApprovalManager, [{ timeoutMs }])).toThrow(RangeError)
      expect(() =>
        Reflect.apply(approvalRequestFromEvent, undefined, [requiredEvent(0), timeoutMs]),
      ).toThrow(RangeError)
    }
    expect(new ApprovalManager({ timeoutMs: 1 }).timeoutMs).toBe(1)
    expect(new ApprovalManager({ timeoutMs: DAY_MS }).timeoutMs).toBe(DAY_MS)
  })

  test("approvalRequestFromEvent reports the configured timeout", () => {
    expect(approvalRequestFromEvent(requiredEvent(1_000)).expiresAt).toBe(1_000 + 5 * MINUTE_MS)
    expect(approvalRequestFromEvent(requiredEvent(1_000), 30_000).expiresAt).toBe(31_000)
    expect(approvalRequestFromEvent(requiredEvent(1_000), "never").expiresAt).toBe(
      APPROVAL_NEVER_EXPIRES_AT,
    )
    const manager = new ApprovalManager({ timeoutMs: "never" })
    expect(approvalRequestFromEvent(requiredEvent(1_000), manager.timeoutMs).expiresAt).toBe(
      APPROVAL_NEVER_EXPIRES_AT,
    )
  })
})
