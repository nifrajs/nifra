/**
 * `@nifrajs/coding-agent/orchestration` - declarative RunPlans compiled onto the existing
 * WorkflowRunner, with content-free evidence, a caller-owned artifact seam, and content-free
 * idempotency keys. No second engine; no payload sink. See the P0 addendum for the design lock.
 */

export type {
  ArtifactContext,
  ArtifactPort,
  ArtifactRef,
  NodeEffectKey,
  RunEvidence,
  RunEvidenceStatus,
  RunNode,
  RunNodeKind,
  RunPlan,
} from "@nifrajs/agent-protocol"
export {
  assertEvidenceSize,
  EVIDENCE_MAX_BYTES,
  FORBIDDEN_CONTENT_KEYS,
  parseArtifactRef,
  parseRunEvidence,
  parseRunPlan,
  RUN_PLAN_VERSION,
  RunContractError,
} from "@nifrajs/agent-protocol"

export {
  type MemoryArtifactPort,
  memoryArtifactPort,
  noopArtifactPort,
} from "./artifact-port.ts"
export {
  type CatalogStep,
  createStepCatalog,
  type StepCatalog,
  type StepEffectContext,
  type StepRunContext,
} from "./catalog.ts"
export {
  CompileError,
  type CompileOptions,
  compileRunPlan,
  digestRunPlan,
} from "./compile.ts"
export { deriveNodeEffectKey, type EffectKeyMaterial } from "./effect-key.ts"
export { canonicalJson, sha256Hex, sha256HexOf } from "./hash.ts"
export { type RunTraceOptions, type RunTraceResult, runTrace } from "./tracer.ts"
