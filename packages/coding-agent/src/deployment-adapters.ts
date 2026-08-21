/**
 * Truthful public deployment reference profiles.
 *
 * These adapters are deterministic lifecycle fixtures. They do not start a process, connect to a
 * network, distribute secrets, or isolate hostile code. A real deployment implementation belongs
 * behind the public `AgentDeploymentAdapter` contract and must provide its own security proof.
 */

import {
  type AgentDeploymentAdapter,
  type DeploymentCancelRequest,
  type DeploymentCancelResult,
  type DeploymentCapabilityReport,
  type DeploymentDisposeRequest,
  type DeploymentDisposeResult,
  DeploymentError,
  type DeploymentInspection,
  type DeploymentInspectRequest,
  type DeploymentPrepareRequest,
  type DeploymentPrepareResult,
  type DeploymentStartRequest,
  type DeploymentStartResult,
  parseDeploymentCapabilityReport,
} from "@nifrajs/agent"

type ReferenceState = "prepared" | "running" | "cancelled" | "disposed"

const LOCAL_PROCESS_CAPABILITIES: DeploymentCapabilityReport = Object.freeze({
  schemaVersion: 1,
  adapterId: "local-process",
  capabilities: Object.freeze({
    runtime: "local",
    network: "none",
    filesystem: "workspace",
    process: "child",
    secrets: "none",
    workspace: Object.freeze({ mode: "scoped", maxBytes: 10_000_000_000 }),
    cancellation: "cooperative",
    hostileCodeIsolation: "none",
  }),
  limitations: Object.freeze(["not-a-sandbox", "trusted-local"]),
})

const CI_CAPABILITIES: DeploymentCapabilityReport = Object.freeze({
  schemaVersion: 1,
  adapterId: "ci",
  capabilities: Object.freeze({
    runtime: "ci",
    network: "none",
    filesystem: "workspace",
    process: "child",
    secrets: "none",
    workspace: Object.freeze({ mode: "scoped", maxBytes: 10_000_000_000 }),
    cancellation: "cooperative",
    hostileCodeIsolation: "none",
  }),
  limitations: Object.freeze(["not-a-sandbox", "ephemeral"]),
})

const REPLAY_CAPABILITIES: DeploymentCapabilityReport = Object.freeze({
  schemaVersion: 1,
  adapterId: "replay",
  capabilities: Object.freeze({
    runtime: "replay",
    network: "none",
    filesystem: "none",
    process: "none",
    secrets: "none",
    workspace: Object.freeze({ mode: "none", maxBytes: 0 }),
    cancellation: "cooperative",
    hostileCodeIsolation: "none",
  }),
  limitations: Object.freeze(["not-a-sandbox", "no-side-effects"]),
})

abstract class DeterministicDeploymentAdapter implements AgentDeploymentAdapter {
  readonly id: string
  private readonly report: DeploymentCapabilityReport
  private readonly states = new Map<string, ReferenceState>()

  protected constructor(report: DeploymentCapabilityReport) {
    this.report = parseDeploymentCapabilityReport(report)
    this.id = this.report.adapterId
  }

  capabilityReport(): DeploymentCapabilityReport {
    return this.report
  }

  prepare(request: DeploymentPrepareRequest): DeploymentPrepareResult {
    this.assertActive(request.signal)
    const deploymentId = request.plan.deploymentId
    if (this.states.has(deploymentId)) throw new DeploymentError("invalid_transition")
    this.states.set(deploymentId, "prepared")
    return Object.freeze({
      deploymentId,
      state: "prepared",
      preparedRef: `${deploymentId}:prepared`,
    })
  }

  start(request: DeploymentStartRequest): DeploymentStartResult {
    this.assertActive(request.signal)
    if (
      this.states.get(request.deploymentId) !== "prepared" ||
      request.preparedRef !== `${request.deploymentId}:prepared`
    )
      throw new DeploymentError("invalid_transition")
    this.states.set(request.deploymentId, "running")
    return Object.freeze({
      deploymentId: request.deploymentId,
      state: "running",
      handleRef: `${request.deploymentId}:handle`,
    })
  }

  inspect(request: DeploymentInspectRequest): DeploymentInspection {
    this.assertActive(request.signal)
    const state = this.states.get(request.deploymentId)
    if (state === undefined) throw new DeploymentError("invalid_transition")
    return Object.freeze({
      deploymentId: request.deploymentId,
      state,
      ...(state === "running" ? { handleRef: `${request.deploymentId}:handle` } : {}),
    })
  }

  cancel(request: DeploymentCancelRequest): DeploymentCancelResult {
    this.assertActive(request.signal)
    const state = this.states.get(request.deploymentId)
    if (state !== "prepared" && state !== "running") throw new DeploymentError("invalid_transition")
    this.states.set(request.deploymentId, "cancelled")
    return Object.freeze({ deploymentId: request.deploymentId, state: "cancelled" })
  }

  dispose(request: DeploymentDisposeRequest): DeploymentDisposeResult {
    this.assertActive(request.signal)
    this.states.set(request.deploymentId, "disposed")
    return Object.freeze({ deploymentId: request.deploymentId, state: "disposed" })
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw new DeploymentError("cancelled")
  }
}

export class LocalProcessDeploymentAdapter extends DeterministicDeploymentAdapter {
  constructor() {
    super(LOCAL_PROCESS_CAPABILITIES)
  }
}

export class CiDeploymentAdapter extends DeterministicDeploymentAdapter {
  constructor() {
    super(CI_CAPABILITIES)
  }
}

export class ReplayDeploymentAdapter extends DeterministicDeploymentAdapter {
  constructor() {
    super(REPLAY_CAPABILITIES)
  }
}

export function createLocalProcessDeploymentAdapter(): LocalProcessDeploymentAdapter {
  return new LocalProcessDeploymentAdapter()
}

export function createCiDeploymentAdapter(): CiDeploymentAdapter {
  return new CiDeploymentAdapter()
}

export function createReplayDeploymentAdapter(): ReplayDeploymentAdapter {
  return new ReplayDeploymentAdapter()
}

export const DEPLOYMENT_REFERENCE_PROFILES = Object.freeze({
  localProcess: LOCAL_PROCESS_CAPABILITIES,
  ci: CI_CAPABILITIES,
  replay: REPLAY_CAPABILITIES,
})
