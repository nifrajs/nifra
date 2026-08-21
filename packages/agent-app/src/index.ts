/**
 * `@nifrajs/agent-app` - a presentation-safe browser SDK for Nifra agent hosts.
 *
 * This package depends only on `@nifrajs/agent-protocol`. It has no backend, provider, storage, model,
 * or UI-framework dependency, so it can be bundled into browser-facing code without dragging a private
 * engine or payload content across the boundary. Everything it surfaces upward is a content-free view
 * model: identifiers, lifecycle statuses, counters, and opaque references.
 */

export {
  AGENT_APP_FEATURES,
  AgentAppClient,
  type AgentAppClientOptions,
  AgentAppError,
  type BoundaryDecisionResult,
  type BoundaryItemView,
  type CreateSessionInput,
  type PendingApprovalView,
  type ReplayEntryView,
  type ReplayResult,
  type ResolveHandoffInput,
  type ResumeInput,
} from "./client.ts"
export {
  type AgentTransport,
  AgentTransportError,
  type AgentTransportRequest,
  type AuthProvider,
  type CommandOutcome,
  HttpAgentTransport,
  type HttpAgentTransportOptions,
  parseEventStream,
} from "./transport.ts"
export {
  type AgentEventView,
  type ApprovalRequiredView,
  type ApprovalResolvedView,
  type AssistantChunkView,
  type BoundaryStateView,
  boundaryCommands,
  boundaryIsStale,
  type EvalComparisonView,
  type EvidenceTimelineView,
  type ExtensionReloadedView,
  type FaultInjectionView,
  type HandoffView,
  type MemoryCompactedView,
  OrderedEventBuffer,
  type RegistryCapabilityView,
  type RepairRequiredView,
  type RunStudioNodeState,
  type RunStudioNodeView,
  type RunStudioView,
  type RunView,
  type SessionFailedView,
  type SessionLifecycleView,
  type SessionStoppedView,
  type SessionView,
  type ToolCompletedView,
  type ToolDeltaView,
  type ToolStartedView,
  type TurnStartedView,
  toEvalComparisonView,
  toEventView,
  toEvidenceTimelineView,
  toFaultInjectionViews,
  toHandoffView,
  toRegistryCapabilityView,
  toRunStudioView,
  toRunView,
  toSessionView,
  type VerificationCompletedView,
  virtualizeEvidenceRows,
} from "./view-models.ts"
