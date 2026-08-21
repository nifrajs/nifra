/**
 * Provider-neutral deployment lifecycle contracts.
 *
 * A deployment adapter is an execution seam, not a sandbox claim. The host owns activation,
 * authority, cancellation, and cleanup. Public reference adapters may be local, CI, or replay, but
 * only a capability report declaring real OS isolation can admit a hostile-code plan.
 */

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_LIMIT = 10_000_000_000

export type DeploymentRuntime = "local" | "ci" | "replay" | "worker" | "unknown"
export type DeploymentNetwork = "none" | "outbound" | "inbound" | "unrestricted"
export type DeploymentFilesystem = "none" | "workspace" | "host"
export type DeploymentProcess = "none" | "child"
export type DeploymentSecrets = "none" | "caller"
export type DeploymentCancellation = "none" | "cooperative" | "forced"
export type HostileCodeIsolation = "none" | "os"

export interface DeploymentCapabilities {
  readonly runtime: DeploymentRuntime
  readonly network: DeploymentNetwork
  readonly filesystem: DeploymentFilesystem
  readonly process: DeploymentProcess
  readonly secrets: DeploymentSecrets
  readonly workspace: {
    readonly mode: "none" | "scoped"
    readonly maxBytes: number
  }
  readonly cancellation: DeploymentCancellation
  readonly hostileCodeIsolation: HostileCodeIsolation
}

export interface DeploymentCapabilityReport {
  readonly schemaVersion: 1
  readonly adapterId: string
  readonly capabilities: DeploymentCapabilities
  readonly limitations: readonly string[]
}

export interface DeploymentAuthority {
  readonly workspaceMaxBytes: number
  readonly deadlineAt?: number
  readonly cancellation: DeploymentCancellation
  readonly hostileCodeIsolation: HostileCodeIsolation
}

export interface DeploymentActivationOptions {
  /** Host-owned approval obtained from a separately reviewed/certified isolation decision. */
  readonly approved?: boolean
}

export interface AgentDeploymentPlan {
  readonly deploymentId: string
  readonly hostileCode?: boolean
  readonly workspaceMaxBytes?: number
  readonly deadlineAt?: number
}

export interface DeploymentPrepareRequest {
  readonly plan: AgentDeploymentPlan
  readonly authority: DeploymentAuthority
  readonly signal: AbortSignal
}

export interface DeploymentPrepareResult {
  readonly deploymentId: string
  readonly state: "prepared"
  readonly preparedRef: string
}

export interface DeploymentStartRequest {
  readonly deploymentId: string
  readonly preparedRef: string
  readonly authority: DeploymentAuthority
  readonly signal: AbortSignal
}

export interface DeploymentStartResult {
  readonly deploymentId: string
  readonly state: "running"
  readonly handleRef: string
}

export interface DeploymentInspectRequest {
  readonly deploymentId: string
  readonly handleRef?: string
  readonly signal: AbortSignal
}

export type DeploymentState = "prepared" | "running" | "cancelled" | "disposed"

export interface DeploymentInspection {
  readonly deploymentId: string
  readonly state: DeploymentState
  readonly handleRef?: string
}

export interface DeploymentCancelRequest {
  readonly deploymentId: string
  readonly preparedRef?: string
  readonly handleRef?: string
  readonly signal: AbortSignal
}

export interface DeploymentCancelResult {
  readonly deploymentId: string
  readonly state: "cancelled"
}

export interface DeploymentDisposeRequest {
  readonly deploymentId: string
  readonly preparedRef?: string
  readonly handleRef?: string
  readonly signal: AbortSignal
}

export interface DeploymentDisposeResult {
  readonly deploymentId: string
  readonly state: "disposed"
}

export interface AgentDeploymentAdapter {
  readonly id: string
  capabilityReport(): DeploymentCapabilityReport | PromiseLike<DeploymentCapabilityReport>
  prepare(
    request: DeploymentPrepareRequest,
  ): DeploymentPrepareResult | PromiseLike<DeploymentPrepareResult>
  start(request: DeploymentStartRequest): DeploymentStartResult | PromiseLike<DeploymentStartResult>
  inspect(
    request: DeploymentInspectRequest,
  ): DeploymentInspection | PromiseLike<DeploymentInspection>
  cancel(
    request: DeploymentCancelRequest,
  ): DeploymentCancelResult | PromiseLike<DeploymentCancelResult>
  dispose(
    request: DeploymentDisposeRequest,
  ): DeploymentDisposeResult | PromiseLike<DeploymentDisposeResult>
}

export type DeploymentEvidence = {
  readonly kind: "prepared" | "started" | "inspected" | "cancelled" | "disposed" | "failed"
  readonly deploymentId: string
  readonly state: DeploymentState | "new"
  readonly code?: DeploymentErrorCode
}

export type DeploymentErrorCode =
  | "invalid_capabilities"
  | "capability_denied"
  | "hostile_code_requires_isolation"
  | "authority_expanded"
  | "invalid_plan"
  | "invalid_transition"
  | "malformed_callback"
  | "adapter_error"
  | "cancelled"

export class DeploymentError extends Error {
  constructor(readonly code: DeploymentErrorCode) {
    super(`deployment ${code}`)
    this.name = "DeploymentError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedToken(
  value: unknown,
  _label: string,
  code: DeploymentErrorCode = "invalid_plan",
): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new DeploymentError(code)
  return value
}

function boundedLimit(
  value: unknown,
  _label: string,
  code: DeploymentErrorCode = "invalid_plan",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_LIMIT)
    throw new DeploymentError(code)
  return value
}

function exactKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  code: DeploymentErrorCode,
): void {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new DeploymentError(code)
}

const RUNTIMES: ReadonlySet<string> = new Set(["local", "ci", "replay", "worker", "unknown"])
const NETWORKS: ReadonlySet<string> = new Set(["none", "outbound", "inbound", "unrestricted"])
const FILESYSTEMS: ReadonlySet<string> = new Set(["none", "workspace", "host"])
const PROCESSES: ReadonlySet<string> = new Set(["none", "child"])
const SECRETS: ReadonlySet<string> = new Set(["none", "caller"])
const CANCELLATIONS: ReadonlySet<string> = new Set(["none", "cooperative", "forced"])
const ISOLATIONS: ReadonlySet<string> = new Set(["none", "os"])

function member<T extends string>(value: unknown, values: ReadonlySet<string>): T {
  if (typeof value !== "string" || !values.has(value))
    throw new DeploymentError("invalid_capabilities")
  return value as T
}

/** Parse an untrusted capability report before the host admits an adapter. */
export function parseDeploymentCapabilityReport(value: unknown): DeploymentCapabilityReport {
  if (!isRecord(value)) throw new DeploymentError("invalid_capabilities")
  exactKeys(
    value,
    new Set(["schemaVersion", "adapterId", "capabilities", "limitations"]),
    "invalid_capabilities",
  )
  if (value.schemaVersion !== 1) throw new DeploymentError("invalid_capabilities")
  const adapterId = boundedToken(value.adapterId, "adapterId", "invalid_capabilities")
  if (!isRecord(value.capabilities)) throw new DeploymentError("invalid_capabilities")
  const capabilities = value.capabilities
  exactKeys(
    capabilities,
    new Set([
      "runtime",
      "network",
      "filesystem",
      "process",
      "secrets",
      "workspace",
      "cancellation",
      "hostileCodeIsolation",
    ]),
    "invalid_capabilities",
  )
  if (!isRecord(capabilities.workspace)) throw new DeploymentError("invalid_capabilities")
  exactKeys(capabilities.workspace, new Set(["mode", "maxBytes"]), "invalid_capabilities")
  const workspaceMode = member<"none" | "scoped">(
    capabilities.workspace.mode,
    new Set(["none", "scoped"]),
  )
  const maxBytes = boundedLimit(
    capabilities.workspace.maxBytes,
    "workspace.maxBytes",
    "invalid_capabilities",
  )
  if (workspaceMode === "none" && maxBytes !== 0) throw new DeploymentError("invalid_capabilities")
  const limitations = value.limitations
  if (
    !Array.isArray(limitations) ||
    limitations.length > 32 ||
    limitations.some((item) => typeof item !== "string" || !TOKEN.test(item))
  )
    throw new DeploymentError("invalid_capabilities")
  return Object.freeze({
    schemaVersion: 1,
    adapterId,
    capabilities: Object.freeze({
      runtime: member<DeploymentRuntime>(capabilities.runtime, RUNTIMES),
      network: member<DeploymentNetwork>(capabilities.network, NETWORKS),
      filesystem: member<DeploymentFilesystem>(capabilities.filesystem, FILESYSTEMS),
      process: member<DeploymentProcess>(capabilities.process, PROCESSES),
      secrets: member<DeploymentSecrets>(capabilities.secrets, SECRETS),
      workspace: Object.freeze({ mode: workspaceMode, maxBytes }),
      cancellation: member<DeploymentCancellation>(capabilities.cancellation, CANCELLATIONS),
      hostileCodeIsolation: member<HostileCodeIsolation>(
        capabilities.hostileCodeIsolation,
        ISOLATIONS,
      ),
    }),
    limitations: Object.freeze([...limitations]),
  })
}

export function parseDeploymentPlan(value: unknown): AgentDeploymentPlan {
  if (!isRecord(value)) throw new DeploymentError("invalid_plan")
  exactKeys(
    value,
    new Set(["deploymentId", "hostileCode", "workspaceMaxBytes", "deadlineAt"]),
    "invalid_plan",
  )
  const deploymentId = boundedToken(value.deploymentId, "deploymentId")
  if (value.hostileCode !== undefined && typeof value.hostileCode !== "boolean")
    throw new DeploymentError("invalid_plan")
  const workspaceMaxBytes =
    value.workspaceMaxBytes === undefined
      ? undefined
      : boundedLimit(value.workspaceMaxBytes, "workspaceMaxBytes", "invalid_plan")
  const rawDeadlineAt = value.deadlineAt
  const deadlineAt =
    rawDeadlineAt === undefined
      ? undefined
      : typeof rawDeadlineAt === "number"
        ? rawDeadlineAt
        : null
  if (
    deadlineAt === null ||
    (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0))
  )
    throw new DeploymentError("invalid_plan")
  return Object.freeze({
    deploymentId,
    ...(value.hostileCode === undefined ? {} : { hostileCode: value.hostileCode }),
    ...(workspaceMaxBytes === undefined ? {} : { workspaceMaxBytes }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  })
}

function parseRef(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value))
    throw new DeploymentError("malformed_callback")
  return value
}

function parseCallbackState(value: unknown, expected: DeploymentState): boolean {
  return isRecord(value) && value.state === expected
}

function parsePrepare(value: unknown, deploymentId: string): DeploymentPrepareResult {
  if (
    !isRecord(value) ||
    value.deploymentId !== deploymentId ||
    !parseCallbackState(value, "prepared")
  )
    throw new DeploymentError("malformed_callback")
  return Object.freeze({
    deploymentId,
    state: "prepared",
    preparedRef: parseRef(value.preparedRef),
  })
}

function parseStart(value: unknown, deploymentId: string): DeploymentStartResult {
  if (
    !isRecord(value) ||
    value.deploymentId !== deploymentId ||
    !parseCallbackState(value, "running")
  )
    throw new DeploymentError("malformed_callback")
  return Object.freeze({ deploymentId, state: "running", handleRef: parseRef(value.handleRef) })
}

function parseInspection(value: unknown, deploymentId: string): DeploymentInspection {
  if (!isRecord(value) || value.deploymentId !== deploymentId || typeof value.state !== "string")
    throw new DeploymentError("malformed_callback")
  if (!["prepared", "running", "cancelled", "disposed"].includes(value.state))
    throw new DeploymentError("malformed_callback")
  const handleRef = value.handleRef === undefined ? undefined : parseRef(value.handleRef)
  return Object.freeze({
    deploymentId,
    state: value.state as DeploymentState,
    ...(handleRef === undefined ? {} : { handleRef }),
  })
}

function parseTerminal<State extends "cancelled" | "disposed">(
  value: unknown,
  deploymentId: string,
  state: State,
): { deploymentId: string; state: State } {
  if (!isRecord(value) || value.deploymentId !== deploymentId || !parseCallbackState(value, state))
    throw new DeploymentError("malformed_callback")
  return Object.freeze({ deploymentId, state })
}

function validateAuthority(authority: DeploymentAuthority): DeploymentAuthority {
  const workspaceMaxBytes = boundedLimit(
    authority.workspaceMaxBytes,
    "authority.workspaceMaxBytes",
    "authority_expanded",
  )
  if (
    authority.deadlineAt !== undefined &&
    (!Number.isSafeInteger(authority.deadlineAt) || authority.deadlineAt <= 0)
  )
    throw new DeploymentError("authority_expanded")
  if (!CANCELLATIONS.has(authority.cancellation) || !ISOLATIONS.has(authority.hostileCodeIsolation))
    throw new DeploymentError("authority_expanded")
  return Object.freeze({ ...authority, workspaceMaxBytes })
}

/** Prove a child deployment authority is a subset of its parent's authority. */
export function assertDeploymentAuthorityMonotonic(
  parent: DeploymentAuthority,
  child: DeploymentAuthority,
): void {
  const p = validateAuthority(parent)
  const c = validateAuthority(child)
  if (c.workspaceMaxBytes > p.workspaceMaxBytes) throw new DeploymentError("authority_expanded")
  if (p.deadlineAt !== undefined && (c.deadlineAt === undefined || c.deadlineAt > p.deadlineAt))
    throw new DeploymentError("authority_expanded")
  if (p.cancellation === "none" && c.cancellation !== "none")
    throw new DeploymentError("authority_expanded")
  if (p.cancellation === "cooperative" && c.cancellation === "forced")
    throw new DeploymentError("authority_expanded")
  if (p.hostileCodeIsolation === "none" && c.hostileCodeIsolation !== "none")
    throw new DeploymentError("authority_expanded")
}

function assertCapabilityPlan(
  report: DeploymentCapabilityReport,
  plan: AgentDeploymentPlan,
  authority: DeploymentAuthority,
  approved: boolean,
): void {
  const capabilities = report.capabilities
  if (plan.hostileCode === true && capabilities.hostileCodeIsolation !== "os")
    throw new DeploymentError("hostile_code_requires_isolation")
  if (plan.hostileCode === true && authority.hostileCodeIsolation !== "os")
    throw new DeploymentError("hostile_code_requires_isolation")
  if (plan.hostileCode === true && !approved)
    throw new DeploymentError("hostile_code_requires_isolation")
  if (
    plan.workspaceMaxBytes !== undefined &&
    (capabilities.workspace.mode !== "scoped" ||
      plan.workspaceMaxBytes > capabilities.workspace.maxBytes)
  )
    throw new DeploymentError("capability_denied")
  if (plan.workspaceMaxBytes !== undefined && plan.workspaceMaxBytes > authority.workspaceMaxBytes)
    throw new DeploymentError("authority_expanded")
  if (authority.cancellation !== "none" && capabilities.cancellation === "none")
    throw new DeploymentError("capability_denied")
  if (
    plan.deadlineAt !== undefined &&
    authority.deadlineAt !== undefined &&
    plan.deadlineAt > authority.deadlineAt
  )
    throw new DeploymentError("authority_expanded")
}

export function createDeploymentAuthority(input: {
  readonly workspaceMaxBytes: number
  readonly deadlineAt?: number
  readonly cancellation?: DeploymentCancellation
  readonly hostileCodeIsolation?: HostileCodeIsolation
}): DeploymentAuthority {
  return validateAuthority({
    workspaceMaxBytes: input.workspaceMaxBytes,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    cancellation: input.cancellation ?? "cooperative",
    hostileCodeIsolation: input.hostileCodeIsolation ?? "none",
  })
}

/** Host-owned deterministic lifecycle wrapper for an adapter. */
export class AgentDeployment {
  readonly id: string
  private deploymentId: string | undefined
  private state: "new" | DeploymentState = "new"
  private preparedRef: string | undefined
  private handleRef: string | undefined
  private report: DeploymentCapabilityReport | undefined
  private readonly evidence: DeploymentEvidence[] = []

  constructor(
    private readonly adapter: AgentDeploymentAdapter,
    authority: DeploymentAuthority,
    private readonly signal: AbortSignal = new AbortController().signal,
    options: DeploymentActivationOptions = {},
  ) {
    this.id = boundedToken(adapter.id, "adapter.id")
    this.authority = validateAuthority(authority)
    this.approved = options.approved === true
  }

  private readonly authority: DeploymentAuthority
  private readonly approved: boolean

  get lifecycleState(): "new" | DeploymentState {
    return this.state
  }

  get evidenceRecords(): readonly DeploymentEvidence[] {
    return Object.freeze([...this.evidence])
  }

  async capabilityReport(): Promise<DeploymentCapabilityReport> {
    if (this.report !== undefined) return this.report
    try {
      this.report = parseDeploymentCapabilityReport(await this.adapter.capabilityReport())
      if (this.report.adapterId !== this.id) throw new DeploymentError("invalid_capabilities")
      return this.report
    } catch (error) {
      throw asDeploymentError(error, "invalid_capabilities")
    }
  }

  async prepare(planInput: AgentDeploymentPlan | unknown): Promise<DeploymentPrepareResult> {
    if (this.state !== "new") return this.fail("invalid_transition")
    const plan = parseDeploymentPlan(planInput)
    this.deploymentId = plan.deploymentId
    if (this.signal.aborted) return this.fail("cancelled")
    const report = await this.capabilityReport()
    assertCapabilityPlan(report, plan, this.authority, this.approved)
    try {
      const result = parsePrepare(
        await this.adapter.prepare({ plan, authority: this.authority, signal: this.signal }),
        plan.deploymentId,
      )
      this.preparedRef = result.preparedRef
      this.state = "prepared"
      this.evidence.push({ kind: "prepared", deploymentId: plan.deploymentId, state: "prepared" })
      return result
    } catch (error) {
      return this.fail(asDeploymentError(error, "adapter_error").code)
    }
  }

  async start(): Promise<DeploymentStartResult> {
    if (
      this.state !== "prepared" ||
      this.preparedRef === undefined ||
      this.deploymentId === undefined
    )
      return this.fail("invalid_transition")
    if (this.signal.aborted) return this.fail("cancelled")
    try {
      const result = parseStart(
        await this.adapter.start({
          deploymentId: this.deploymentId,
          preparedRef: this.preparedRef,
          authority: this.authority,
          signal: this.signal,
        }),
        this.deploymentId,
      )
      this.handleRef = result.handleRef
      this.state = "running"
      this.evidence.push({ kind: "started", deploymentId: this.deploymentId, state: "running" })
      return result
    } catch (error) {
      return this.fail(asDeploymentError(error, "adapter_error").code)
    }
  }

  async inspect(): Promise<DeploymentInspection> {
    if (this.state === "new" || this.state === "disposed" || this.deploymentId === undefined)
      return this.fail("invalid_transition")
    try {
      const result = parseInspection(
        await this.adapter.inspect({
          deploymentId: this.deploymentId,
          ...(this.handleRef === undefined ? {} : { handleRef: this.handleRef }),
          signal: this.signal,
        }),
        this.deploymentId,
      )
      this.evidence.push({
        kind: "inspected",
        deploymentId: this.deploymentId,
        state: result.state,
      })
      return result
    } catch (error) {
      return this.fail(asDeploymentError(error, "adapter_error").code)
    }
  }

  async cancel(): Promise<DeploymentCancelResult> {
    if ((this.state !== "prepared" && this.state !== "running") || this.deploymentId === undefined)
      return this.fail("invalid_transition")
    try {
      const result = parseTerminal(
        await this.adapter.cancel({
          deploymentId: this.deploymentId,
          ...(this.preparedRef === undefined ? {} : { preparedRef: this.preparedRef }),
          ...(this.handleRef === undefined ? {} : { handleRef: this.handleRef }),
          signal: this.signal,
        }),
        this.deploymentId,
        "cancelled",
      )
      this.state = "cancelled"
      this.evidence.push({ kind: "cancelled", deploymentId: this.deploymentId, state: "cancelled" })
      return result
    } catch (error) {
      return this.fail(asDeploymentError(error, "adapter_error").code)
    }
  }

  async dispose(): Promise<DeploymentDisposeResult> {
    if (this.state === "disposed")
      return { deploymentId: this.deploymentId ?? this.id, state: "disposed" }
    try {
      const result = parseTerminal(
        await this.adapter.dispose({
          deploymentId: this.deploymentId ?? this.id,
          ...(this.preparedRef === undefined ? {} : { preparedRef: this.preparedRef }),
          ...(this.handleRef === undefined ? {} : { handleRef: this.handleRef }),
          signal: this.signal,
        }),
        this.deploymentId ?? this.id,
        "disposed",
      )
      this.state = "disposed"
      this.evidence.push({
        kind: "disposed",
        deploymentId: this.deploymentId ?? this.id,
        state: "disposed",
      })
      return result
    } catch (error) {
      return this.fail(asDeploymentError(error, "adapter_error").code)
    }
  }

  private fail(code: DeploymentErrorCode): never {
    this.evidence.push({
      kind: "failed",
      deploymentId: this.deploymentId ?? this.id,
      state: this.state,
      code,
    })
    throw new DeploymentError(code)
  }
}

function asDeploymentError(error: unknown, fallback: DeploymentErrorCode): DeploymentError {
  return error instanceof DeploymentError ? error : new DeploymentError(fallback)
}
