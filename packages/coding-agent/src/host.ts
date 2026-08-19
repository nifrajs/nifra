import {
  type AgentApprovalRequiredEvent,
  type AgentBackend,
  type AgentEvent,
  type AgentSessionSnapshot,
  agentError,
  type CreateSessionInput,
  type ForkSessionResult,
  type ReloadResult,
} from "@nifrajs/agent-protocol"
import {
  type ApprovalDecision,
  ApprovalManager,
  type ApprovalManagerOptions,
  type ApprovalRequest,
} from "./approvals.ts"
import type { ExtensionHost } from "./extensions.ts"
import {
  type CompactionReport,
  ContextWindow,
  type ContextWindowOptions,
  type SessionStore,
} from "./sessions.ts"
import {
  createVerificationRepairTask,
  runNifraVerification,
  type VerificationOptions,
} from "./verification.ts"

export interface CodingAgentHostOptions {
  readonly backend: AgentBackend
  readonly sessionStore?: SessionStore
  readonly contextWindow?: ContextWindowOptions
  readonly extensions?: ExtensionHost
  readonly approvals?: ApprovalManagerOptions
  /** Optional post-turn gates. Disabled by default to keep the hot path fast. */
  readonly verifyAfterTurn?: readonly ("check" | "assure" | "test")[]
  readonly verification?: Pick<
    VerificationOptions,
    "command" | "timeoutMs" | "maxOutputBytes" | "env"
  >
}

/** Small lifecycle host shared by the CLI, RPC server, and future Workbench. */
export class CodingAgentHost {
  readonly backend: AgentBackend
  private session: AgentSessionSnapshot | undefined
  private readonly sessionStore: SessionStore | undefined
  private readonly context: ContextWindow
  private readonly extensions: ExtensionHost | undefined
  readonly approvals: ApprovalManager
  private readonly verifyAfterTurn: readonly ("check" | "assure" | "test")[]
  private readonly verification:
    | Pick<VerificationOptions, "command" | "timeoutMs" | "maxOutputBytes" | "env">
    | undefined

  constructor(options: CodingAgentHostOptions) {
    this.backend = options.backend
    this.sessionStore = options.sessionStore
    this.context = new ContextWindow(options.contextWindow)
    this.extensions = options.extensions
    this.approvals = new ApprovalManager(options.approvals)
    this.verifyAfterTurn = Object.freeze([...(options.verifyAfterTurn ?? [])])
    this.verification = options.verification
  }

  async start(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (this.session !== undefined) throw new Error("coding agent: a session is already active")
    this.session = await this.backend.createSession(input)
    if (input.sessionId !== undefined && this.sessionStore !== undefined) {
      const history = await this.sessionStore.read(input.sessionId)
      this.context.restore(history.map(sessionEntryToContextRecord))
    } else {
      this.context.restore([])
    }
    await this.extensions?.reload()
    await this.sessionStore?.append(this.session.id, "session.started", this.session)
    return this.session
  }

  get snapshot(): AgentSessionSnapshot | undefined {
    return this.session
  }

  async *prompt(message: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.session === undefined) throw new Error("coding agent: start a session first")
    const sessionId = this.session.id
    const stream = this.backend.send({
      sessionId,
      message,
      ...(signal === undefined ? {} : { signal }),
    })
    for await (const event of stream) {
      if (
        event.type === "session.updated" ||
        event.type === "session.completed" ||
        event.type === "session.started"
      )
        this.session = event.snapshot
      if (event.type === "approval.required")
        await this.approvals.observe(event as AgentApprovalRequiredEvent)
      await this.sessionStore?.append(sessionId, event.type, event, {
        pinned: event.type === "approval.required" || event.type === "verification.completed",
      })
      await this.extensions?.emit(event.type, event).catch(() => {})
      const report = this.context.append({
        kind: event.type,
        content: eventText(event),
        pinned: event.type === "approval.required" || event.type === "verification.completed",
      })
      if (report !== undefined)
        await this.sessionStore?.append(sessionId, "memory.compacted", report, { pinned: true })
      yield event
    }
    for (const name of this.verifyAfterTurn) {
      const result = await runNifraVerification(name, {
        cwd: this.session.cwd,
        ...this.verification,
      })
      const at = Date.now()
      const verificationEvent: AgentEvent = Object.freeze({
        version: 1 as const,
        sessionId,
        seq: this.session.lastSeq + 1,
        at,
        type: "verification.completed" as const,
        name,
        ok: result.ok,
        report: result,
      }) as AgentEvent
      this.session = Object.freeze({
        ...this.session,
        lastSeq: verificationEvent.seq,
        updatedAt: at,
      })
      await this.sessionStore?.append(sessionId, "verification.completed", verificationEvent, {
        pinned: true,
      })
      this.context.append({
        kind: "verification.completed",
        content: JSON.stringify(result),
        pinned: true,
      })
      yield verificationEvent
      const repairTask = createVerificationRepairTask(result, this.session.cwd)
      if (repairTask !== undefined) {
        const repairEvent: AgentEvent = Object.freeze({
          version: 1 as const,
          sessionId,
          seq: this.session.lastSeq + 1,
          at: Date.now(),
          type: "repair.required" as const,
          ...(this.session.activeTurnId === undefined ? {} : { turnId: this.session.activeTurnId }),
          task: repairTask,
        }) as AgentEvent
        this.session = Object.freeze({
          ...this.session,
          lastSeq: repairEvent.seq,
          updatedAt: repairEvent.at,
        })
        await this.sessionStore?.append(sessionId, "repair.required", repairEvent, { pinned: true })
        await this.extensions?.emit(repairEvent.type, repairEvent).catch(() => {})
        yield repairEvent
      }
    }
  }

  async reload(): Promise<ReloadResult> {
    if (this.session === undefined) throw new Error("coding agent: start a session first")
    await this.sessionStore?.checkpoint(this.session.id, this.session)
    const local = await this.extensions?.reload()
    const backend = await this.backend.reload(this.session.id)
    const result: ReloadResult = {
      revision: backend.revision,
      loaded: Object.freeze([...(local?.loaded ?? []), ...backend.loaded]),
      disabled: Object.freeze([...(local?.disabled ?? []), ...backend.disabled]),
      rolledBack: local?.rolledBack === true || backend.rolledBack,
      ...(local?.error === undefined && backend.error === undefined
        ? {}
        : {
            error:
              local?.error === undefined
                ? backend.error
                : agentError("EXTENSION_RELOAD", local.error),
          }),
    }
    await this.sessionStore?.append(this.session.id, "extension.reloaded", result)
    return result
  }

  async checkpoint(payload?: unknown): Promise<void> {
    if (this.session === undefined) throw new Error("coding agent: start a session first")
    const value = payload === undefined ? this.session : payload
    if (this.backend.checkpoint !== undefined) await this.backend.checkpoint(this.session.id, value)
    await this.sessionStore?.checkpoint(this.session.id, value)
    await this.sessionStore?.append(this.session.id, "session.checkpoint", value, { pinned: true })
  }

  async compact(reason: CompactionReport["reason"] = "manual"): Promise<CompactionReport> {
    if (this.session === undefined) throw new Error("coding agent: start a session first")
    const report = this.context.compact(reason)
    if (report.removed > 0)
      await this.sessionStore?.append(this.session.id, "memory.compacted", report, { pinned: true })
    return report
  }

  async fork(targetSessionId?: string): Promise<ForkSessionResult> {
    if (this.session === undefined) throw new Error("coding agent: start a session first")
    if (this.backend.fork !== undefined)
      return this.backend.fork({
        sessionId: this.session.id,
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      })
    if (this.sessionStore === undefined)
      throw new Error("coding agent: no session store is configured")
    const sessionId = await this.sessionStore.fork(this.session.id, targetSessionId)
    await this.sessionStore.append(
      sessionId,
      "session.forked",
      { parentSessionId: this.session.id },
      { pinned: true },
    )
    return { sessionId, parentSessionId: this.session.id }
  }

  async history(limit = 512): Promise<readonly import("./sessions.ts").SessionLogEntry[]> {
    if (this.session === undefined) throw new Error("coding agent: start a session first")
    if (this.sessionStore === undefined) return Object.freeze([])
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
      throw new RangeError("coding agent: history limit must be between 1 and 4096")
    const entries = await this.sessionStore.read(this.session.id)
    return Object.freeze(entries.slice(-limit))
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.session === undefined) return
    const id = this.session.id
    this.session = undefined
    await this.sessionStore?.append(id, "session.stopped", { reason })
    await this.backend.cancel(id, reason).catch(() => {})
    await this.backend.close(id).catch(() => {})
    await this.extensions?.close().catch(() => {})
    this.approvals.close()
  }

  get pendingApprovals(): readonly ApprovalRequest[] {
    return this.approvals.pending
  }

  async offerApproval(
    input: Omit<ApprovalRequest, "sessionId" | "createdAt" | "expiresAt"> & {
      readonly sessionId?: string
    },
  ): Promise<ApprovalRequest | undefined> {
    const session = this.session
    if (session === undefined) throw new Error("coding agent: start a session first")
    return this.approvals.offer({ ...input, sessionId: input.sessionId ?? session.id })
  }

  async requestApproval(
    input: Omit<ApprovalRequest, "sessionId" | "createdAt" | "expiresAt"> & {
      readonly sessionId?: string
    },
  ): Promise<boolean> {
    const session = this.session
    if (session === undefined) throw new Error("coding agent: start a session first")
    return this.approvals.request({ ...input, sessionId: input.sessionId ?? session.id })
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<ApprovalDecision | undefined> {
    if (this.session !== undefined && this.backend.resolveApproval !== undefined)
      await this.backend.resolveApproval(this.session.id, approvalId, approved, reason)
    const decision = this.approvals.resolve(approvalId, approved, reason)
    if (decision !== undefined && this.session !== undefined)
      await this.sessionStore?.append(this.session.id, "approval.resolved", decision, {
        pinned: true,
      })
    return decision
  }

  get contextWindow(): ContextWindow {
    return this.context
  }
}

function eventText(event: AgentEvent): string {
  switch (event.type) {
    case "assistant.delta":
      return event.text
    case "assistant.message":
      return event.text
    case "turn.started":
      return event.prompt
    case "tool.started":
      return `${event.name} ${JSON.stringify(event.input ?? "")}`
    case "tool.delta":
      return event.text
    case "tool.completed":
      return `${event.name} ${JSON.stringify(event.output ?? event.error ?? "")}`
    case "approval.required":
      return `${event.capability}: ${event.action}`
    case "repair.required":
      return `${event.task.verification}: ${event.task.reason}`
    case "session.failed":
      return event.error.message
    default:
      return event.type
  }
}

function sessionEntryToContextRecord(
  entry: import("./sessions.ts").SessionLogEntry,
): import("./sessions.ts").ContextRecord {
  const payload = entry.payload
  let content: string
  try {
    content = typeof payload === "string" ? payload : JSON.stringify(payload ?? "")
  } catch {
    content = "[unserializable session evidence]"
  }
  return {
    kind: entry.type,
    content: content.slice(0, 4096),
    ...(entry.pinned === true ? { pinned: true } : {}),
  }
}
