import type { ApprovalConsumeResult, ApprovalRecord, ApprovalStore } from "./durable-types.ts"
import { safeEqual } from "./safe-equal.ts"

export type DurableApprovalDecisionInput = Parameters<ApprovalStore["decide"]>[0]
export type DurableApprovalConsumeInput = Parameters<ApprovalStore["consume"]>[0]

export interface DurableApprovalConsumeTransition {
  readonly result: ApprovalConsumeResult
  readonly next?: ApprovalRecord
}

export interface DurableApprovalProtocol {
  decide(
    current: ApprovalRecord | undefined,
    input: DurableApprovalDecisionInput,
  ): ApprovalRecord | undefined
  consume(
    current: ApprovalRecord | undefined,
    input: DurableApprovalConsumeInput,
  ): DurableApprovalConsumeTransition
}

function decideApproval(
  current: ApprovalRecord | undefined,
  input: DurableApprovalDecisionInput,
): ApprovalRecord | undefined {
  if (
    current === undefined ||
    current.tenantId !== input.tenantId ||
    current.state !== "pending" ||
    current.expiresAt <= input.now
  ) {
    return undefined
  }
  return Object.freeze({
    ...current,
    state: input.decision,
    decidedBy: input.decidedBy,
    updatedAt: input.now,
    version: current.version + 1,
  })
}

function consumeApproval(
  current: ApprovalRecord | undefined,
  input: DurableApprovalConsumeInput,
): DurableApprovalConsumeTransition {
  if (current === undefined) return { result: { state: "missing" } }
  if (
    current.tenantId !== input.tenantId ||
    current.principalId !== input.principalId ||
    current.capability !== input.capability ||
    current.target !== input.target ||
    !safeEqual(current.digest, input.digest)
  ) {
    return { result: { state: "binding" } }
  }
  if (!safeEqual(current.tokenHash, input.tokenHash)) return { result: { state: "token" } }
  if (current.state === "consumed") return { result: { state: "replay" } }
  if (current.state === "denied") return { result: { state: "denied" } }
  if (current.state === "pending") return { result: { state: "pending" } }
  if (current.state === "expired" || current.expiresAt <= input.now) {
    return {
      result: { state: "expired" },
      ...(current.state === "expired"
        ? {}
        : {
            next: Object.freeze({
              ...current,
              state: "expired" as const,
              updatedAt: input.now,
              version: current.version + 1,
            }),
          }),
    }
  }
  if (current.state !== "approved") return { result: { state: "token" } }
  return {
    result: { state: "consumed" },
    next: Object.freeze({
      ...current,
      state: "consumed" as const,
      updatedAt: input.now,
      version: current.version + 1,
    }),
  }
}

export const durableApprovalProtocol: DurableApprovalProtocol = Object.freeze({
  decide: decideApproval,
  consume: consumeApproval,
})
