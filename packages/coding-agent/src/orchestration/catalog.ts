/**
 * The StepCatalog: the local, closure-holding registry that resolves a plan node's `step` name to a
 * runnable handler. A {@link RunPlan} is serializable and content-free precisely because it names
 * steps by string; the executable behavior lives here, in-process, and never in the plan.
 *
 * A step declares a `version` and the `capabilities` it needs. The compiler uses both to fail closed:
 * a node that pins a drifted version, or a step that needs a capability the host did not grant, is
 * rejected before any node runs (ORC-05, ORC-07).
 */

import type { ArtifactPort, RunNodeKind } from "@nifrajs/agent-protocol"
import type { SubagentExecutor, SubagentSpec } from "../subagents.ts"

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
 * One catalog handler. `kind` must match the plan node's kind at compile time.
 *
 * - Leaf kinds `task`/`verify`/`approve`/`checkpoint`/`handoff` implement {@link CatalogStep.run}.
 * - `subagent` implements {@link CatalogStep.spec} and supplies an {@link CatalogStep.executor};
 *   the compiler drives it through a {@link BoundedSubagentRunner} (never a private copy).
 * - `branch` implements {@link CatalogStep.when}, a content-free predicate.
 *
 * `selectEffect`, when present, marks the step idempotent and projects its identity-bearing input
 * into content-free bytes for `deriveNodeEffectKey`. It MUST be pure and read-only.
 */
export interface CatalogStep {
  readonly kind: RunNodeKind
  /** Positive step version. Defaults to 1 when omitted. A node may pin an exact version. */
  readonly version?: number
  /** Capabilities this step needs. The host's allow-list is the ceiling; a superset fails closed. */
  readonly capabilities?: readonly string[]
  run?(context: StepRunContext): unknown | PromiseLike<unknown>
  selectEffect?(context: StepEffectContext): Uint8Array
  /** `subagent` kind: the bounded child executor and the content-free spec projection. */
  readonly executor?: SubagentExecutor
  spec?(context: StepRunContext): SubagentSpec | PromiseLike<SubagentSpec>
  /** `branch` kind: a content-free predicate selecting `then` or `otherwise`. */
  when?(context: StepRunContext): boolean | PromiseLike<boolean>
}

/** Thrown on a catalog construction fault: a key collision across merged catalogs. */
export class CatalogError extends Error {
  constructor(readonly reason: string) {
    super(`step catalog: ${reason}`)
    this.name = "CatalogError"
  }
}

/** The effective version of a step (defaults to 1). */
export function stepVersion(step: CatalogStep): number {
  return step.version ?? 1
}

/** Resolves step names to handlers. Immutable after construction; lookup is deterministic. */
export interface StepCatalog {
  get(step: string): CatalogStep | undefined
  has(step: string): boolean
  /** Sorted for deterministic enumeration. */
  readonly keys: readonly string[]
}

function fromMap(map: ReadonlyMap<string, CatalogStep>): StepCatalog {
  return {
    get: (step) => map.get(step),
    has: (step) => map.has(step),
    keys: Object.freeze([...map.keys()].sort()),
  }
}

/** Build a StepCatalog from a name -> handler map. */
export function createStepCatalog(entries: Readonly<Record<string, CatalogStep>>): StepCatalog {
  return fromMap(new Map(Object.entries(entries)))
}

/** Merge catalogs into one. Throws {@link CatalogError} on any duplicate step key (collision). */
export function mergeStepCatalogs(...catalogs: readonly StepCatalog[]): StepCatalog {
  const map = new Map<string, CatalogStep>()
  for (const catalog of catalogs) {
    for (const key of catalog.keys) {
      if (map.has(key)) throw new CatalogError(`duplicate step key '${key}'`)
      map.set(key, catalog.get(key) as CatalogStep)
    }
  }
  return fromMap(map)
}
