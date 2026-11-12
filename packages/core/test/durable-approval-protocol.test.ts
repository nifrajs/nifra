/** The approval state machine on its own: who may decide, and every answer a consume can give. */
import { describe, expect, test } from "bun:test"
import { durableApprovalProtocol } from "../src/internal/durable-approval-protocol.ts"
import type { ApprovalRecord, ApprovalState } from "../src/internal/durable-types.ts"

const NOW = 1_000

const record = (patch: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approvalId: "approval-1",
  effectId: "effect-1",
  capability: "payments.refund",
  target: "order-7",
  digest: "digest-a",
  tenantId: "tenant-a",
  principalId: "user-1",
  tokenHash: "token-hash-a",
  state: "pending",
  createdAt: 100,
  expiresAt: NOW + 500,
  updatedAt: 100,
  version: 3,
  ...patch,
})

const decision = (patch: Record<string, unknown> = {}) => ({
  approvalId: "approval-1",
  tenantId: "tenant-a",
  decision: "approved" as const,
  decidedBy: "reviewer-1",
  now: NOW,
  ...patch,
})

const consumption = (patch: Record<string, unknown> = {}) => ({
  approvalId: "approval-1",
  tenantId: "tenant-a",
  principalId: "user-1",
  capability: "payments.refund",
  target: "order-7",
  digest: "digest-a",
  tokenHash: "token-hash-a",
  now: NOW,
  ...patch,
})

describe("decide", () => {
  test("records the decision on a frozen copy, one version on, and leaves the original alone", () => {
    const current = record()
    for (const choice of ["approved", "denied"] as const) {
      const next = durableApprovalProtocol.decide(current, decision({ decision: choice }))
      expect(next).toEqual({
        ...current,
        state: choice,
        decidedBy: "reviewer-1",
        updatedAt: NOW,
        version: 4,
      })
      expect(Object.isFrozen(next)).toBe(true)
    }
    expect(current.state).toBe("pending")
    expect(current.version).toBe(3)
  })

  test("refuses a missing record, another tenant, a settled record and an expired one", () => {
    expect(durableApprovalProtocol.decide(undefined, decision())).toBeUndefined()
    expect(
      durableApprovalProtocol.decide(record(), decision({ tenantId: "tenant-b" })),
    ).toBeUndefined()
    for (const state of ["approved", "denied", "consumed", "expired"] as const) {
      expect(durableApprovalProtocol.decide(record({ state }), decision())).toBeUndefined()
    }
    // The deadline itself is already past: a decision made at `expiresAt` comes too late.
    expect(durableApprovalProtocol.decide(record({ expiresAt: NOW }), decision())).toBeUndefined()
    expect(durableApprovalProtocol.decide(record({ expiresAt: NOW + 1 }), decision())).toBeDefined()
  })
})

describe("consume", () => {
  test("a missing record is missing", () => {
    expect(durableApprovalProtocol.consume(undefined, consumption())).toEqual({
      result: { state: "missing" },
    })
  })

  test("any binding field that differs is a binding failure, before the token is looked at", () => {
    const approved = record({ state: "approved" })
    for (const patch of [
      { tenantId: "tenant-b" },
      { principalId: "user-2" },
      { capability: "payments.void" },
      { target: "order-8" },
      { target: undefined },
      { digest: "digest-b" },
      { digest: undefined },
    ]) {
      expect(durableApprovalProtocol.consume(approved, consumption(patch))).toEqual({
        result: { state: "binding" },
      })
    }
    // Binding outranks a wrong token, so a stranger learns nothing about the token.
    expect(
      durableApprovalProtocol.consume(
        approved,
        consumption({ principalId: "user-2", tokenHash: "wrong" }),
      ),
    ).toEqual({ result: { state: "binding" } })
  })

  test("a record bound to no target or digest is consumed only by a request that names none", () => {
    const { target: _target, digest: _digest, ...rest } = record({ state: "approved" })
    const open: ApprovalRecord = rest
    expect(
      durableApprovalProtocol.consume(open, consumption({ target: undefined, digest: undefined }))
        .result,
    ).toEqual({ state: "consumed" })
    expect(durableApprovalProtocol.consume(open, consumption()).result).toEqual({
      state: "binding",
    })
  })

  test("a wrong token is a token failure whatever the state", () => {
    for (const state of ["pending", "approved", "denied", "consumed", "expired"] as const) {
      expect(
        durableApprovalProtocol.consume(record({ state }), consumption({ tokenHash: "wrong" })),
      ).toEqual({ result: { state: "token" } })
    }
  })

  test("a settled record answers with its state and changes nothing", () => {
    const answers: readonly (readonly [ApprovalState, "replay" | "denied" | "pending"])[] = [
      ["consumed", "replay"],
      ["denied", "denied"],
      ["pending", "pending"],
    ]
    for (const [state, answer] of answers) {
      const transition = durableApprovalProtocol.consume(record({ state }), consumption())
      expect(transition).toEqual({ result: { state: answer } })
      expect(transition.next).toBeUndefined()
    }
  })

  test("an approved record past its deadline expires, and the expiry is written once", () => {
    for (const expiresAt of [NOW, NOW - 1]) {
      const current = record({ state: "approved", expiresAt })
      const transition = durableApprovalProtocol.consume(current, consumption())
      expect(transition.result).toEqual({ state: "expired" })
      expect(transition.next).toEqual({ ...current, state: "expired", updatedAt: NOW, version: 4 })
      expect(Object.isFrozen(transition.next)).toBe(true)
    }
    // Already marked expired: the answer is the same and there is nothing more to write.
    const marked = durableApprovalProtocol.consume(
      record({ state: "expired", expiresAt: NOW + 500 }),
      consumption(),
    )
    expect(marked).toEqual({ result: { state: "expired" } })
    expect(marked.next).toBeUndefined()
  })

  test("an approved record inside its deadline is consumed once, as a frozen copy one version on", () => {
    const current = record({ state: "approved" })
    const transition = durableApprovalProtocol.consume(current, consumption())
    expect(transition.result).toEqual({ state: "consumed" })
    expect(transition.next).toEqual({ ...current, state: "consumed", updatedAt: NOW, version: 4 })
    expect(Object.isFrozen(transition.next)).toBe(true)
    expect(current.state).toBe("approved")
    if (transition.next === undefined) throw new Error("a consumed approval has a next record")
    expect(durableApprovalProtocol.consume(transition.next, consumption()).result).toEqual({
      state: "replay",
    })
  })

  test("a state the protocol does not know is refused as a token failure", () => {
    const unknown = record({ state: "revoked" as unknown as ApprovalState })
    expect(durableApprovalProtocol.consume(unknown, consumption())).toEqual({
      result: { state: "token" },
    })
  })
})
