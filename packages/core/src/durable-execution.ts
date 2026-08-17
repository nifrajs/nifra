/**
 * Durable capability execution primitives. The public subpath remains the compatibility façade;
 * each domain now owns its implementation while records, transitions, and shared validation helpers
 * live behind explicit internal seams.
 */

export * from "./durable-approval.ts"
export * from "./durable-effect.ts"
export * from "./durable-saga.ts"
export type {
  CapabilityApprovalGate,
  CapabilityExecutionIdentity,
  CapabilityExecutionJournal,
} from "./internal/capability-runtime.ts"
export * from "./internal/durable-types.ts"
