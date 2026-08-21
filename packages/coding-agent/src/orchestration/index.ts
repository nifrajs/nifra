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
  RunBranchNode,
  RunEvidence,
  RunEvidenceStatus,
  RunLeafKind,
  RunLeafNode,
  RunNode,
  RunNodeKind,
  RunParallelNode,
  RunPlan,
  RunRetryNode,
  RunRetryPolicy,
  RunSequenceNode,
  RunStructuralKind,
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
  CatalogError,
  type CatalogStep,
  createStepCatalog,
  mergeStepCatalogs,
  type StepCatalog,
  type StepEffectContext,
  type StepRunContext,
  stepVersion,
} from "./catalog.ts"
export {
  CompileError,
  type CompileOptions,
  compileRunPlan,
  compileRunPlanLayers,
  digestRunPlan,
  type OrchestrationLimits,
} from "./compile.ts"
export { deriveNodeEffectKey, type EffectKeyMaterial } from "./effect-key.ts"
export {
  type EvidenceCounters,
  type EvidenceStore,
  FileEvidenceStore,
  type FileEvidenceStoreOptions,
  MemoryEvidenceStore,
  type MemoryEvidenceStoreOptions,
} from "./evidence-store.ts"
export { canonicalJson, sha256Hex, sha256HexOf } from "./hash.ts"
export {
  OrchestrationHost,
  type OrchestrationHostOptions,
  OrchestrationStateError,
  type RunResult,
  type RunState,
  type RunStatus,
  type SubmitOptions,
} from "./host.ts"
export {
  type Admission,
  type AdmissionRejection,
  admitCapability,
  assertAdmitted,
  ChildVectorTracker,
  type HostPolicy,
  PolicyError,
} from "./policy.ts"
export { type RunTraceOptions, type RunTraceResult, runTrace } from "./tracer.ts"
