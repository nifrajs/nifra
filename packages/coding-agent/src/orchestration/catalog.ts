/**
 * The StepCatalog: the local, closure-holding registry that resolves a plan node's `step` name to a
 * runnable handler. A {@link RunPlan} is serializable and content-free precisely because it names
 * steps by string; the executable behavior lives here, in-process, and never in the plan.
 */

import type { ArtifactPort, RunNodeKind } from "@nifrajs/agent-protocol"

/** Read-only view handed to a step's pure effect selector. No port, no mutation. */
export interface StepEffectContext {
  readonly nodeId: string
  readonly planDigest: string
  readonly values: ReadonlyMap<string, unknown>
}

/** Runtime context handed to a step body. Payloads leave only through {@link StepRunContext.artifact}. */
export interface StepRunContext {
  readonly nodeId: string
  readonly planDigest: string
  readonly signal: AbortSignal
  /** Caller-owned artifact sink. The step routes any raw payload here to get a content-free ref. */
  readonly artifact: ArtifactPort
  readonly values: ReadonlyMap<string, unknown>
  set(name: string, value: unknown): void
}

/**
 * One catalog handler. `kind` must match the plan node's kind at compile time. `selectEffect`, when
 * present, marks the step idempotent and projects its identity-bearing input into content-free bytes
 * for {@link deriveNodeEffectKey}. It MUST be pure and read-only.
 */
export interface CatalogStep {
  readonly kind: RunNodeKind
  run(context: StepRunContext): unknown | PromiseLike<unknown>
  selectEffect?(context: StepEffectContext): Uint8Array
}

/** Resolves step names to handlers. Immutable after construction. */
export interface StepCatalog {
  get(step: string): CatalogStep | undefined
  has(step: string): boolean
  readonly keys: readonly string[]
}

/** Build a StepCatalog from a name -> handler map. */
export function createStepCatalog(entries: Readonly<Record<string, CatalogStep>>): StepCatalog {
  const map = new Map<string, CatalogStep>(Object.entries(entries))
  return {
    get: (step) => map.get(step),
    has: (step) => map.has(step),
    keys: Object.freeze([...map.keys()]),
  }
}
