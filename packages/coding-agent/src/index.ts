export { PiBackend, type PiBackendOptions } from "@nifrajs/pi"
export {
  type ApprovalDecision,
  ApprovalManager,
  type ApprovalManagerOptions,
  type ApprovalMatchRejection,
  type ApprovalMatchResult,
  type ApprovalRequest,
  approvalRequestFromEvent,
  approvalResolvedEvent,
} from "./approvals.ts"
export {
  AGENT_CAPABILITY_MANIFEST_VERSION,
  type AgentCapability,
  type AgentCapabilityManifest,
  createCapabilityManifest,
  deniedCapabilities,
  parseCapabilityManifest,
} from "./capabilities.ts"
export {
  type NifraContextOptions,
  type NifraContextResult,
  runNifraContext,
} from "./context.ts"
export {
  CiDeploymentAdapter,
  createCiDeploymentAdapter,
  createLocalProcessDeploymentAdapter,
  createReplayDeploymentAdapter,
  DEPLOYMENT_REFERENCE_PROFILES,
  LocalProcessDeploymentAdapter,
  ReplayDeploymentAdapter,
} from "./deployment-adapters.ts"
export { type ProjectDiffOptions, type ProjectDiffResult, readProjectDiff } from "./diff.ts"
export {
  type CodingAgentExtension,
  discoverExtensions,
  type ExtensionCommand,
  type ExtensionContext,
  type ExtensionEventHandler,
  ExtensionHost,
  type ExtensionHostOptions,
  type ExtensionProvider,
  type ExtensionReloadResult,
  type ExtensionSubagent,
  type ExtensionTool,
  validateExtensionModule,
} from "./extensions.ts"
export {
  HandoffCoordinator,
  type HandoffCoordinatorOptions,
  type HandoffDecision,
  HandoffError,
  type HandoffRejection,
  type HandoffView,
  type OpenHandoffInput,
} from "./handoffs.ts"
export {
  type HealingEvent,
  type HealingOptions,
  type HealingResult,
  type RepairProposal,
  SelfHealingController,
} from "./healing.ts"
export { CodingAgentHost, type CodingAgentHostOptions } from "./host.ts"
export {
  type IsolatedExtensionSnapshot,
  type IsolatedExtensionTool,
  IsolatedExtensionWorker,
  type IsolatedExtensionWorkerOptions,
} from "./isolated.ts"
export {
  createNativeGatewayModelPort,
  type NativeApprovalPort,
  type NativeGatewayModelPortOptions,
  type NativeMessage,
  type NativeModelChunk,
  type NativeModelPort,
  type NativeModelRequest,
  type NativeModelResponse,
  type NativeTool,
  NifraBackend,
  type NifraBackendOptions,
} from "./native.ts"
export {
  type AgentPlan,
  type PlanEvent,
  type PlanPhase,
  type PlanResult,
  PlanRunner,
  type PlanRunnerOptions,
} from "./plans.ts"
export {
  AGENT_PRESETS,
  type AgentPreset,
  type AgentPresetName,
  createPresetSpec,
  getAgentPreset,
} from "./presets.ts"
export { type BoundedText, readBoundedText } from "./process.ts"
export {
  type CapabilityDescriptor,
  type ExtensionDescriptorOptions,
  type ExtensionDescriptorSource,
  extensionDescriptor,
  extensionDescriptors,
} from "./registry.ts"
export { ReplayBackend, type ReplayBackendOptions, readReplayEvents } from "./replay.ts"
export {
  CodingAgentRpcServer,
  type CodingAgentRpcServerHandle,
  type CodingAgentRpcServerOptions,
} from "./rpc.ts"
export {
  type MigrateLegacySessionOptions,
  migrateLegacySession,
  parseSessionEvidenceRecord,
  SESSION_EVIDENCE_VERSION,
  type SessionEvidenceRecord,
  SessionMigrationError,
  type SessionMigrationReport,
  stableSessionEventCode,
} from "./session-migration.ts"
export {
  type CompactionReport,
  type ContextRecord,
  ContextWindow,
  type ContextWindowOptions,
  FileSessionStore,
  type FileSessionStoreOptions,
  type SessionLogEntry,
  type SessionStore,
} from "./sessions.ts"
export {
  BoundedSubagentRunner,
  type SubagentExecutor,
  type SubagentResult,
  type SubagentRunnerOptions,
  type SubagentSpec,
} from "./subagents.ts"
export { createNifraTools, NIFRA_AGENT_INSTRUCTIONS, type NifraAgentTool } from "./tools.ts"
export {
  UiExtensionHost,
  type UiExtensionHostOptions,
  type UiExtensionManifest,
  type UiExtensionSlot,
  type UiReloadResult,
  type UiStatusWidget,
  type UiThemeDescriptor,
} from "./ui.ts"
export {
  createVerificationRepairTask,
  runNifraVerification,
  type VerificationOptions,
  type VerificationRepairTask,
  type VerificationResult,
} from "./verification.ts"
export {
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowResult,
  WorkflowRunner,
  type WorkflowRunnerOptions,
  type WorkflowStep,
} from "./workflows.ts"
