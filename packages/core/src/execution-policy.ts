import { validCapabilityId } from "./internal/capability-runtime.ts"

/** The filesystem access a child process is expected to have. */
export type ExecutionFilesystemScope = "none" | "cwd" | "declared"

/** Network access requested by an execution policy. */
export type ExecutionNetworkAccess = "deny" | "allow"

/**
 * A public, token-only execution policy. It describes a required capability; it is not an
 * isolation mechanism by itself.
 */
export interface ExecutionPolicy {
  readonly filesystem: ExecutionFilesystemScope
  readonly network: ExecutionNetworkAccess
  readonly timeMs: number
  readonly capabilityCeiling: readonly string[]
}

/** An adapter that can prove whether it satisfies a contract's execution policy. */
export interface ExecutionPolicyAdapter {
  readonly name: string
  canSatisfy(policy: ExecutionPolicy): boolean | PromiseLike<boolean>
  /** Token-only limitations are suitable for evidence and diagnostics. */
  limitations(policy: ExecutionPolicy): readonly string[]
}

export function defineExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  if (policy === null || typeof policy !== "object") {
    throw new TypeError("execution policy: policy must be an object")
  }
  if (
    policy.filesystem !== "none" &&
    policy.filesystem !== "cwd" &&
    policy.filesystem !== "declared"
  ) {
    throw new TypeError("execution policy: filesystem must be none, cwd, or declared")
  }
  if (policy.network !== "deny" && policy.network !== "allow") {
    throw new TypeError("execution policy: network must be deny or allow")
  }
  if (!Number.isSafeInteger(policy.timeMs) || policy.timeMs < 1) {
    throw new RangeError("execution policy: timeMs must be a positive safe integer")
  }
  if (
    !Array.isArray(policy.capabilityCeiling) ||
    policy.capabilityCeiling.some((value) => !validCapabilityId(value))
  ) {
    throw new TypeError("execution policy: capabilityCeiling must contain valid capabilities")
  }
  return Object.freeze({
    filesystem: policy.filesystem,
    network: policy.network,
    timeMs: policy.timeMs,
    capabilityCeiling: Object.freeze([...new Set(policy.capabilityCeiling)]),
  })
}
