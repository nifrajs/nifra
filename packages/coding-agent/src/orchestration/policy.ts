/**
 * Host policy admission for the orchestration host (REG-06) and the monotonic child-vector allocator
 * (REG-07).
 *
 * A {@link HostPolicy} is the authority: it declares which capability kinds may run, an allowlist of
 * required capabilities, an isolation floor, and whether every capability must be approved. A
 * {@link CapabilityDescriptor} is only a request - {@link admitCapability} lets the descriptor tighten
 * nothing it did not already promise and, crucially, cannot loosen the policy. A descriptor asking for
 * weaker isolation than the floor, declaring a capability outside the allowlist, or offering `none`
 * approval where the host requires approval is refused with a stable code. Descriptors, plans, models,
 * extensions, and clients therefore cannot override host policy.
 *
 * The {@link ChildVectorTracker} hands each newly opened decision boundary a strictly increasing
 * per-run vector. A decision must later carry the exact vector its boundary opened with, so a replayed
 * or superseded decision cannot resume work. The tracker never allocates a non-advancing vector.
 */

import type {
  ApprovalClass,
  CapabilityDescriptor,
  CapabilityKind,
  IsolationClass,
} from "@nifrajs/agent/registry"

/** The authoritative admission policy. Empty allowlists deny everything of that kind. */
export interface HostPolicy {
  /** Capability kinds the host will admit. A descriptor of any other kind is refused. */
  readonly allowedKinds: readonly CapabilityKind[]
  /** Required-capability allowlist. Every `requiredCapabilities` entry must be present. */
  readonly allowedCapabilities: readonly string[]
  /** Isolation floor. A descriptor offering weaker isolation than this is refused. */
  readonly minIsolation: IsolationClass
  /** When true, a descriptor whose approval class is `none` is refused as a downgrade. */
  readonly requireApproval: boolean
}

/** Stable, content-free reasons the host refuses to admit a capability. */
export type AdmissionRejection =
  | "kind_not_allowed"
  | "capability_not_allowed"
  | "isolation_too_weak"
  | "approval_downgrade"

export type Admission =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AdmissionRejection }

/** Thrown when the host refuses admission and the caller wants an exception rather than a result. */
export class PolicyError extends Error {
  readonly code: AdmissionRejection

  constructor(code: AdmissionRejection) {
    super(`host policy: ${code}`)
    this.code = code
    this.name = "PolicyError"
  }
}

// Isolation is a total order: a higher rank is stronger and satisfies any lower floor.
const ISOLATION_RANK: Readonly<Record<IsolationClass, number>> = {
  inherit: 0,
  process: 1,
  sandbox: 2,
}

function approvalIsNone(approval: ApprovalClass): boolean {
  return approval.kind === "none"
}

/**
 * Admit a capability descriptor against the host policy. The policy is the floor; the descriptor can
 * only meet or exceed it. Returns the first failing reason, or `{ ok: true }` when every gate passes.
 */
export function admitCapability(policy: HostPolicy, descriptor: CapabilityDescriptor): Admission {
  if (!policy.allowedKinds.includes(descriptor.kind)) return { ok: false, code: "kind_not_allowed" }
  const allowed = new Set(policy.allowedCapabilities)
  for (const capability of descriptor.requiredCapabilities)
    if (!allowed.has(capability)) return { ok: false, code: "capability_not_allowed" }
  if (ISOLATION_RANK[descriptor.isolation] < ISOLATION_RANK[policy.minIsolation])
    return { ok: false, code: "isolation_too_weak" }
  if (policy.requireApproval && approvalIsNone(descriptor.approval))
    return { ok: false, code: "approval_downgrade" }
  return { ok: true }
}

/** Admit or throw {@link PolicyError}. Use at the host boundary where a refusal must stop the run. */
export function assertAdmitted(policy: HostPolicy, descriptor: CapabilityDescriptor): void {
  const admission = admitCapability(policy, descriptor)
  if (!admission.ok) throw new PolicyError(admission.code)
}

/**
 * Per-run monotonic child-vector allocator. `open` returns the next strictly increasing vector for a
 * run; `last` reports the high-water mark (`-1` before the first boundary). A vector is never reused,
 * so a decision carrying anything other than its boundary's opened vector is provably stale.
 */
export class ChildVectorTracker {
  private readonly highWater = new Map<string, number>()

  /** Allocate the next vector for a run. Strictly greater than every previously allocated vector. */
  open(runId: string): number {
    const next = (this.highWater.get(runId) ?? -1) + 1
    this.highWater.set(runId, next)
    return next
  }

  /** The last allocated vector for a run, or `-1` when none has opened. */
  last(runId: string): number {
    return this.highWater.get(runId) ?? -1
  }

  /** Forget a run's vectors once it is terminal. Idempotent. */
  release(runId: string): void {
    this.highWater.delete(runId)
  }
}
