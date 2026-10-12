import {
  type AgentBackend,
  type AgentSessionSnapshot,
  type CreateSessionInput,
  type ReloadResult,
  resumeFromCursor,
} from "@nifrajs/agent-protocol"
import { readProjectDiff } from "./diff.ts"
import { publicErrorDetails } from "./errors.ts"
import type { ExtensionHost } from "./extensions.ts"
import { CodingAgentHost, type CodingAgentHostOptions } from "./host.ts"
import { readBoundedText } from "./process.ts"
import type { ContextWindowOptions, SessionStore } from "./sessions.ts"
import { ReplayableTurn, type TurnReplayLimits } from "./turn-replay.ts"
import type { UiExtensionHost, UiExtensionManifest } from "./ui.ts"
import { isSafeReviewDiff, runNifraReview, runNifraVerification } from "./verification.ts"

export interface CodingAgentRpcServerOptions {
  readonly backend: AgentBackend
  readonly cwd: string
  readonly hostname?: string
  /** Remote binding is opt-in; the default only permits loopback hosts. */
  readonly allowRemote?: boolean
  readonly port?: number
  /** A random token is generated when omitted. Use an explicit token only for managed local launchers. */
  readonly authToken?: string
  /** Include bounded exception stacks in RPC failures only for trusted loopback debugging. */
  readonly exposeErrorStacks?: boolean
  readonly maxBodyBytes?: number
  /** Maximum UTF-8 bytes in one non-streaming JSON response. Defaults to 4 MiB. */
  readonly maxResponseBytes?: number
  readonly sessionStore?: SessionStore
  readonly contextWindow?: ContextWindowOptions
  readonly extensions?: ExtensionHost
  readonly ui?: UiExtensionHost
  readonly verifyAfterTurn?: readonly ("check" | "assure" | "test")[]
  readonly maxRepairAttempts?: number
  readonly verification?: CodingAgentHostOptions["verification"]
  readonly extensionEvents?: CodingAgentHostOptions["extensionEvents"]
  /**
   * The host's approval broker: how long an approval or a tool's question waits for its answer
   * (`timeoutMs`, default 5 minutes), how many may wait (`maxPending`, default 32),
   * and its `onRequired`/`onResolved` hooks.
   */
  readonly approvals?: CodingAgentHostOptions["approvals"]
  /**
   * Keep a `turn.send` running when its client disconnects, and let a client that comes back read
   * what it missed with `turn.attach` (an `afterSeq` cursor, or `Last-Event-ID`). The newest
   * `replayEvents` frames, up to `replayBytes`, are held (defaults 1024 and 8 MiB); a turn no client
   * has followed for `detachedTimeoutMs` (default 2 minutes) is cancelled. A client that stops reading
   * is dropped once it falls `replayBytes` behind what is held, and can attach again from its cursor.
   */
  readonly resumableTurns?:
    | boolean
    | {
        readonly replayEvents?: number
        readonly replayBytes?: number
        readonly detachedTimeoutMs?: number
      }
}

export interface CodingAgentRpcServerHandle {
  readonly url: string
  readonly token: string
  stop(): Promise<void>
}

interface RpcRequest {
  readonly method: string
  readonly params?: unknown
}

interface RpcServerLike {
  readonly url: URL
  stop(closeActiveConnections?: boolean): void
}

const MAX_RPC_BODY_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_RPC_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_RPC_RESPONSE_BYTES = 64 * 1024 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MIN_REMOTE_TOKEN_BYTES = 32
const AUTH_FAILURE_WINDOW_MS = 60_000
const AUTH_FAILURE_THRESHOLD = 3
const AUTH_MAX_BACKOFF_MS = 2_000
const MAX_REPLAY_EVENTS = 65_536
const MAX_REPLAY_BYTES = 256 * 1024 * 1024
const MAX_DETACHED_TIMEOUT_MS = 24 * 60 * 60 * 1000

interface ResumableTurnConfig extends TurnReplayLimits {
  readonly detachedTimeoutMs: number
}

/**
 * Minimal loopback RPC surface for the CLI, Workbench, CI clients, and a future mobile companion.
 * Turn output is SSE so clients do not need a WebSocket dependency; every event is still a versioned
 * protocol event from the backend.
 */
export class CodingAgentRpcServer {
  readonly host: CodingAgentHost
  private readonly options: CodingAgentRpcServerOptions
  private readonly token: string
  private readonly maxBodyBytes: number
  private readonly maxResponseBytes: number
  private listener: RpcServerLike | undefined
  private authFailures = 0
  private authLastFailureAt = 0
  private authBackoffUntil = 0
  private creating: Promise<AgentSessionSnapshot> | undefined
  private readonly resumable: ResumableTurnConfig | undefined
  private turn: ReplayableTurn | undefined
  private turnController: AbortController | undefined
  private detachedTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: CodingAgentRpcServerOptions) {
    this.options = Object.freeze({ ...options })
    this.host = new CodingAgentHost({
      backend: options.backend,
      ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
      ...(options.verifyAfterTurn === undefined
        ? {}
        : { verifyAfterTurn: options.verifyAfterTurn }),
      ...(options.maxRepairAttempts === undefined
        ? {}
        : { maxRepairAttempts: options.maxRepairAttempts }),
      exposeErrorStacks: options.exposeErrorStacks === true,
      ...(options.verification === undefined ? {} : { verification: options.verification }),
      ...(options.extensionEvents === undefined
        ? {}
        : { extensionEvents: options.extensionEvents }),
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    })
    this.resumable = resumableTurnConfig(options.resumableTurns)
    this.token = options.authToken ?? randomAuthToken()
    if (!/^[A-Za-z0-9._~-]{16,256}$/.test(this.token))
      throw new TypeError("agent rpc: authToken must be a bounded token")
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576
    if (
      !Number.isSafeInteger(this.maxBodyBytes) ||
      this.maxBodyBytes < 1024 ||
      this.maxBodyBytes > MAX_RPC_BODY_BYTES
    )
      throw new RangeError(`agent rpc: maxBodyBytes must be between 1024 and ${MAX_RPC_BODY_BYTES}`)
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RPC_RESPONSE_BYTES
    if (
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1024 ||
      this.maxResponseBytes > MAX_RPC_RESPONSE_BYTES
    )
      throw new RangeError(
        `agent rpc: maxResponseBytes must be between 1024 and ${MAX_RPC_RESPONSE_BYTES}`,
      )
  }

  async start(): Promise<CodingAgentRpcServerHandle> {
    if (this.listener !== undefined) throw new Error("agent rpc: server is already running")
    const hostname = this.options.hostname ?? "127.0.0.1"
    if (!this.options.allowRemote && !isLoopbackHost(hostname))
      throw new Error("agent rpc: remote binding requires allowRemote: true")
    if (
      this.options.authToken !== undefined &&
      !isLoopbackHost(hostname) &&
      new TextEncoder().encode(this.token).byteLength < MIN_REMOTE_TOKEN_BYTES
    )
      throw new Error(
        `agent rpc: explicit remote authToken must be at least ${MIN_REMOTE_TOKEN_BYTES} bytes`,
      )
    if (this.options.exposeErrorStacks === true && this.options.allowRemote === true)
      throw new Error("agent rpc: exposeErrorStacks is only allowed for local-only binding")
    this.listener = Bun.serve({
      hostname,
      port: this.options.port ?? 0,
      fetch: (request) => this.fetch(request),
    })
    const listener = this.listener
    return {
      url: listener.url.toString().replace(/\/$/, ""),
      token: this.token,
      stop: async () => {
        await this.stop()
      },
    }
  }

  async stop(): Promise<void> {
    const listener = this.listener
    this.listener = undefined
    clearTimeout(this.detachedTimer)
    this.turnController?.abort()
    try {
      await this.host.stop("rpc server stopped")
    } finally {
      // The audit write is best effort from a transport-lifecycle perspective. Even when the host
      // reports a persistence failure, the listening socket must not remain reachable or leaked.
      listener?.stop(true)
    }
  }

  private async fetch(request: Request): Promise<Response> {
    const cors = corsHeaders(request)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET")
      return this.response({ ok: true, protocol: 1 }, 200, cors)
    if (!authorized(request, this.token)) {
      // Only failed attempts are throttled. A caller holding the token is served during a backoff,
      // or anyone who can reach the port could keep the real client locked out with wrong guesses.
      const backoffMs = this.authBackoffMs()
      if (backoffMs > 0) {
        const throttledCors = new Headers(cors)
        throttledCors.set("retry-after", String(Math.ceil(backoffMs / 1000)))
        return this.response(
          { error: { code: "auth_throttled", message: "too many failed authorization attempts" } },
          429,
          throttledCors,
        )
      }
      this.noteAuthFailure()
      return this.response(
        { error: { code: "unauthorized", message: "agent RPC authorization required" } },
        401,
        cors,
      )
    }
    if (url.pathname !== "/rpc" || request.method !== "POST")
      return this.response(
        { error: { code: "not_found", message: "unknown agent RPC endpoint" } },
        404,
        cors,
      )
    let body: Awaited<ReturnType<CodingAgentRpcServer["readRequest"]>>
    try {
      body = await this.readRequest(request)
    } catch {
      return this.response(
        { error: { code: "invalid_request", message: "request body could not be read" } },
        400,
        cors,
      )
    }
    if (!body.ok)
      return this.response(
        { error: { code: "invalid_request", message: body.error } },
        body.status,
        cors,
      )
    let rpc: RpcRequest
    try {
      rpc = parseRpcRequest(body.text)
    } catch (error) {
      return this.response(
        { error: this.protocolError("invalid_request", error, "request body is invalid") },
        400,
        cors,
        this.options.exposeErrorStacks === true,
      )
    }
    try {
      return await this.dispatch(rpc, request, cors)
    } catch (error) {
      return this.response(
        { error: this.protocolError("rpc_failed", error, "request could not be completed") },
        500,
        cors,
        this.options.exposeErrorStacks === true,
      )
    }
  }

  private async dispatch(
    request: RpcRequest,
    httpRequest: Request,
    cors: Headers,
  ): Promise<Response> {
    const json = (
      value: unknown,
      status: number,
      inherited: Headers,
      includeErrorStacks = false,
    ): Response => this.response(value, status, inherited, includeErrorStacks)
    switch (request.method) {
      case "session.create": {
        const params = record(request.params)
        if (params.sessionId !== undefined && !isValidSessionId(params.sessionId))
          return json(
            { error: { code: "invalid_session", message: "sessionId is invalid" } },
            422,
            cors,
          )
        const snapshot = await this.ensureSession({
          cwd: this.options.cwd,
          backend: this.options.backend.info.name,
          ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
        })
        return json(this.advertised(snapshot), 200, cors)
      }
      case "session.snapshot": {
        const snapshot = this.requireSnapshot()
        return json(this.advertised(snapshot), 200, cors)
      }
      case "session.resume": {
        const params = record(request.params)
        if (!isValidSessionId(params.sessionId))
          return json(
            { error: { code: "invalid_session", message: "sessionId is required" } },
            422,
            cors,
          )
        const snapshot = await this.ensureSession({
          cwd: this.options.cwd,
          backend: this.options.backend.info.name,
          sessionId: params.sessionId,
        })
        return json(this.advertised(snapshot), 200, cors)
      }
      case "session.events": {
        const snapshot = this.requireSnapshot()
        const params = record(request.params)
        const limit = params.limit === undefined ? 512 : Number(params.limit)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
          return json(
            {
              error: { code: "invalid_history_limit", message: "limit must be between 1 and 4096" },
            },
            422,
            cors,
          )
        const window = await this.host.history(limit)
        // Legacy shape when no cursor is requested; a cursor opts into bounded snapshot + resume.
        if (params.cursor === undefined) return json({ entries: window }, 200, cors)
        const cursor = Number(params.cursor)
        if (!Number.isSafeInteger(cursor) || cursor < -1)
          return json(
            { error: { code: "invalid_cursor", message: "cursor must be a safe integer >= -1" } },
            422,
            cors,
          )
        return json(
          { snapshot: this.advertised(snapshot), resume: resumeFromCursor(window, cursor) },
          200,
          cors,
        )
      }
      case "session.checkpoint": {
        this.requireSnapshot()
        const params = record(request.params)
        await this.host.checkpoint(params.payload)
        return json({ ok: true }, 200, cors)
      }
      case "session.fork": {
        this.requireSnapshot()
        const params = record(request.params)
        if (params.targetSessionId !== undefined && !isValidSessionId(params.targetSessionId))
          return json(
            { error: { code: "invalid_session", message: "targetSessionId must be a string" } },
            422,
            cors,
          )
        return json(await this.host.fork(params.targetSessionId as string | undefined), 201, cors)
      }
      case "turn.send": {
        const params = record(request.params)
        if (
          typeof params.message !== "string" ||
          params.message.trim().length === 0 ||
          params.message.length > this.maxBodyBytes
        )
          return json(
            {
              error: {
                code: "invalid_message",
                message: "message must be a non-empty bounded string",
              },
            },
            422,
            cors,
          )
        if (this.resumable !== undefined)
          return this.sendResumableTurn(params.message, this.resumable, cors)
        const stream = this.host.prompt(params.message, httpRequest.signal)
        const sessionId = this.host.snapshot?.id
        const encoder = new TextEncoder()
        const includeErrorStacks = this.options.exposeErrorStacks === true
        const maxResponseBytes = this.maxResponseBytes
        // Pulled, not pushed: the turn advances only as the client reads, so one that stops reading
        // holds the backend still instead of the server queueing the rest of the turn for it.
        const events = stream[Symbol.asyncIterator]()
        let finished = false
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (finished) return
            try {
              const next = await events.next()
              if (finished) return
              if (next.done === true) {
                finished = true
                controller.close()
                return
              }
              const frame = eventFrame(next.value, includeErrorStacks)
              if (serializedByteLength(frame) > maxResponseBytes)
                throw new Error("turn event exceeded the configured response limit")
              controller.enqueue(encoder.encode(frame))
            } catch (error) {
              if (finished) return
              finished = true
              try {
                controller.enqueue(
                  encoder.encode(turnErrorFrame(error, includeErrorStacks, maxResponseBytes)),
                )
                controller.close()
              } catch {
                // A disconnected client has already cancelled the stream; there is no response
                // channel left on which to report the producer error.
              }
            }
          },
          cancel: async () => {
            if (finished) return
            finished = true
            void events.return?.()
            if (sessionId !== undefined)
              await this.host.backend.cancel(sessionId, "client disconnected").catch(() => {})
          },
        })
        return eventStreamResponse(body, cors)
      }
      case "turn.attach": {
        if (this.resumable === undefined)
          return json(
            {
              error: {
                code: "feature_unsupported",
                message: "this server does not keep turns for clients that come back",
              },
            },
            501,
            cors,
          )
        const params = record(request.params)
        const header = httpRequest.headers.get("last-event-id")
        const raw = params.afterSeq ?? (header === null || header === "" ? undefined : header)
        const cursor = raw === undefined ? undefined : Number(raw)
        if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < -1))
          return json(
            { error: { code: "invalid_cursor", message: "afterSeq must be a safe integer >= -1" } },
            422,
            cors,
          )
        const turn = this.turn
        if (turn === undefined)
          return json(
            { error: { code: "no_turn", message: "no turn has run on this server" } },
            404,
            cors,
          )
        const stream = turn.attach(cursor)
        if (stream === undefined)
          return json(
            {
              error: {
                code: "resync_required",
                message: "the events after that seq are no longer held; read session.events",
              },
            },
            409,
            cors,
          )
        return eventStreamResponse(stream, cors)
      }
      case "session.reload": {
        const result: ReloadResult = await this.host.reload()
        return json(result, 200, cors)
      }
      case "session.compact": {
        this.requireSnapshot()
        return json(await this.host.compact("manual"), 200, cors)
      }
      case "approval.list": {
        this.requireSnapshot()
        // `approvalId` is the name `approval.resolve` takes; `id` stays for existing readers.
        const pending = this.host.pendingApprovals.map((request) => ({
          ...request,
          approvalId: request.id,
        }))
        return json({ pending }, 200, cors)
      }
      case "approval.request": {
        const params = record(request.params)
        if (typeof params.action !== "string" || typeof params.capability !== "string")
          return json(
            { error: { code: "invalid_approval", message: "action and capability are required" } },
            422,
            cors,
          )
        this.requireSnapshot()
        const approval = await this.host.offerApproval({
          ...(typeof params.approvalId === "string"
            ? { id: params.approvalId }
            : { id: crypto.randomUUID().replaceAll("-", "") }),
          action: params.action,
          capability: params.capability,
          ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
          ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        })
        if (approval === undefined)
          return json(
            { error: { code: "approval_limit", message: "too many pending approvals" } },
            429,
            cors,
          )
        return json(approval, 201, cors)
      }
      case "approval.resolve": {
        const params = record(request.params)
        if (typeof params.approvalId !== "string" || typeof params.approved !== "boolean")
          return json(
            {
              error: { code: "invalid_approval", message: "approvalId and approved are required" },
            },
            422,
            cors,
          )
        this.requireSnapshot()
        const decision = await this.host.resolveApproval(
          params.approvalId,
          params.approved,
          typeof params.reason === "string" ? params.reason : undefined,
        )
        if (decision === undefined)
          return json(
            { error: { code: "approval_not_found", message: "approval is not pending" } },
            404,
            cors,
          )
        return json(decision, 200, cors)
      }
      case "ui.snapshot": {
        this.requireSnapshot()
        return json(
          this.options.ui === undefined
            ? { revision: "0", active: [] }
            : { revision: this.options.ui.currentRevision, active: this.options.ui.extensions },
          200,
          cors,
        )
      }
      case "ui.reload": {
        this.requireSnapshot()
        if (this.options.ui === undefined)
          return json(
            { error: { code: "ui_unavailable", message: "UI extension host is not configured" } },
            409,
            cors,
          )
        const params = record(request.params)
        if (!Array.isArray(params.manifests))
          return json(
            { error: { code: "invalid_ui", message: "manifests must be an array" } },
            422,
            cors,
          )
        return json(this.options.ui.reload(params.manifests as UiExtensionManifest[]), 200, cors)
      }
      case "ui.preview": {
        this.requireSnapshot()
        if (this.options.ui === undefined)
          return json(
            { error: { code: "ui_unavailable", message: "UI extension host is not configured" } },
            409,
            cors,
          )
        const params = record(request.params)
        if (!Array.isArray(params.manifests))
          return json(
            { error: { code: "invalid_ui", message: "manifests must be an array" } },
            422,
            cors,
          )
        return json(this.options.ui.preview(params.manifests as UiExtensionManifest[]), 200, cors)
      }
      case "workflow.list": {
        this.requireSnapshot()
        return json({ workflows: this.options.extensions?.availableWorkflows ?? [] }, 200, cors)
      }
      case "subagent.list": {
        this.requireSnapshot()
        return json({ subagents: this.options.extensions?.availableSubagents ?? [] }, 200, cors)
      }
      case "provider.list": {
        this.requireSnapshot()
        return json({ providers: this.options.extensions?.availableProviders ?? [] }, 200, cors)
      }
      case "workflow.run": {
        this.requireSnapshot()
        if (this.options.extensions === undefined)
          return json(
            { error: { code: "workflow_unavailable", message: "workflow host is not configured" } },
            409,
            cors,
          )
        const params = record(request.params)
        if (typeof params.name !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(params.name))
          return json(
            { error: { code: "invalid_workflow", message: "name must be a bounded workflow id" } },
            422,
            cors,
          )
        const result = await this.options.extensions.runWorkflow(params.name, {
          ...(httpRequest.signal === undefined ? {} : { signal: httpRequest.signal }),
          ...(typeof params.maxSteps === "number" &&
          Number.isSafeInteger(params.maxSteps) &&
          params.maxSteps > 0
            ? { maxSteps: Math.min(params.maxSteps, 512) }
            : {}),
          ...(typeof params.maxDepth === "number" &&
          Number.isSafeInteger(params.maxDepth) &&
          params.maxDepth > 0
            ? { maxDepth: Math.min(params.maxDepth, 16) }
            : {}),
          exposeErrorStacks: this.options.exposeErrorStacks === true,
        })
        return json(
          // A Map serialises to `{}`; the wire carries the values as a plain object.
          { ...result, values: Object.fromEntries(result.values) },
          result.ok ? 200 : 422,
          cors,
          this.options.exposeErrorStacks === true,
        )
      }
      case "verification.run": {
        const params = record(request.params)
        const name = params.name
        if (name !== "check" && name !== "assure" && name !== "test")
          return json(
            {
              error: {
                code: "invalid_verification",
                message: "name must be check, assure, or test",
              },
            },
            422,
            cors,
          )
        this.requireSnapshot()
        return json(
          await runNifraVerification(name, {
            cwd: this.options.cwd,
            exposeErrorStacks: this.options.exposeErrorStacks === true,
          }),
          200,
          cors,
          this.options.exposeErrorStacks === true,
        )
      }
      case "review.run": {
        const params = record(request.params)
        const allowed = new Set(["strict", "diff"])
        if (Object.keys(params).some((key) => !allowed.has(key)))
          return json(
            { error: { code: "invalid_review", message: "review accepts only strict and diff" } },
            422,
            cors,
          )
        if (params.strict !== undefined && typeof params.strict !== "boolean")
          return json(
            { error: { code: "invalid_review", message: "strict must be a boolean" } },
            422,
            cors,
          )
        if (params.diff !== undefined && !isSafeReviewDiff(params.diff))
          return json(
            { error: { code: "invalid_review", message: "diff must be a safe Git ref" } },
            422,
            cors,
          )
        return json(
          await runNifraReview({
            cwd: this.options.cwd,
            ...(this.options.verification === undefined ? {} : this.options.verification),
            ...(params.strict === undefined ? {} : { strict: params.strict }),
            ...(params.diff === undefined ? {} : { diff: params.diff }),
          }),
          200,
          cors,
        )
      }
      case "project.diff": {
        this.requireSnapshot()
        return json(
          await readProjectDiff({
            cwd: this.options.cwd,
            exposeErrorStacks: this.options.exposeErrorStacks === true,
          }),
          200,
          cors,
          this.options.exposeErrorStacks === true,
        )
      }
      case "session.stop": {
        await this.host.stop("rpc request")
        return json({ ok: true }, 200, cors)
      }
      default:
        return json(
          { error: { code: "method_not_found", message: `unknown method: ${request.method}` } },
          404,
          cors,
        )
    }
  }

  private sendResumableTurn(message: string, config: ResumableTurnConfig, cors: Headers): Response {
    if (this.turn !== undefined && !this.turn.done)
      return this.response(
        {
          error: {
            code: "turn_running",
            message: "a turn is already running; follow it with turn.attach",
          },
        },
        409,
        cors,
      )
    clearTimeout(this.detachedTimer)
    const controller = new AbortController()
    const turn = new ReplayableTurn(this.turn?.latestSeq ?? -1, config, (count) => {
      clearTimeout(this.detachedTimer)
      if (count > 0 || this.turn !== turn) return
      this.detachedTimer = setTimeout(() => {
        if (this.turn !== turn || turn.done || turn.following > 0) return
        controller.abort()
        const sessionId = this.host.snapshot?.id
        if (sessionId !== undefined)
          void this.host.backend.cancel(sessionId, "no client followed the turn").catch(() => {})
      }, config.detachedTimeoutMs)
    })
    this.turn = turn
    this.turnController = controller
    const stream = turn.follow()
    const includeErrorStacks = this.options.exposeErrorStacks === true
    const maxResponseBytes = this.maxResponseBytes
    const encoder = new TextEncoder()
    void (async () => {
      try {
        for await (const event of this.host.prompt(message, controller.signal)) {
          const frame = eventFrame(event, includeErrorStacks)
          if (serializedByteLength(frame) > maxResponseBytes)
            throw new Error("turn event exceeded the configured response limit")
          turn.push(event.seq, encoder.encode(frame))
        }
        turn.end()
      } catch (error) {
        turn.end(encoder.encode(turnErrorFrame(error, includeErrorStacks, maxResponseBytes)))
      } finally {
        if (this.turn === turn) clearTimeout(this.detachedTimer)
      }
    })()
    return eventStreamResponse(stream, cors)
  }

  /** The active session, or one started from `input`; concurrent requests share a single start. */
  private async ensureSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    const active = this.host.snapshot
    if (active !== undefined) return active
    this.creating ??= this.host.start(input).finally(() => {
      this.creating = undefined
    })
    return await this.creating
  }

  /** The backend's capabilities plus the Agent App features this server answers itself. */
  private advertised(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
    const { backend, sessionStore, extensions } = this.options
    const served = ["approvals", "resume"]
    if (backend.checkpoint !== undefined || sessionStore !== undefined) served.push("checkpoint")
    if (backend.fork !== undefined || sessionStore !== undefined) served.push("fork")
    if (extensions !== undefined) served.push("workflows")
    const capabilities = [...new Set([...snapshot.capabilities, ...served])]
    return Object.freeze({ ...snapshot, capabilities: Object.freeze(capabilities) })
  }

  private requireSnapshot(): AgentSessionSnapshot {
    if (this.host.snapshot === undefined) throw new Error("agent RPC session has not been created")
    return this.host.snapshot
  }

  private authBackoffMs(): number {
    const now = Date.now()
    if (this.authFailures === 0) return 0
    if (now - this.authLastFailureAt > AUTH_FAILURE_WINDOW_MS) {
      this.resetAuthFailures()
      return 0
    }
    return Math.max(0, this.authBackoffUntil - now)
  }

  private noteAuthFailure(): void {
    const now = Date.now()
    if (now - this.authLastFailureAt > AUTH_FAILURE_WINDOW_MS) this.authFailures = 0
    this.authLastFailureAt = now
    this.authFailures = Math.min(this.authFailures + 1, 31)
    if (this.authFailures >= AUTH_FAILURE_THRESHOLD) {
      const exponent = this.authFailures - AUTH_FAILURE_THRESHOLD
      const delay = Math.min(AUTH_MAX_BACKOFF_MS, 250 * 2 ** exponent)
      this.authBackoffUntil = now + delay
    }
  }

  private resetAuthFailures(): void {
    this.authFailures = 0
    this.authLastFailureAt = 0
    this.authBackoffUntil = 0
  }

  private response(
    value: unknown,
    status: number,
    inherited: Headers,
    includeErrorStacks = false,
  ): Response {
    return json(value, status, inherited, includeErrorStacks, this.maxResponseBytes)
  }

  private protocolError(
    code: string,
    error: unknown,
    fallback: string,
  ): { readonly code: string; readonly message: string; readonly stack?: string } {
    return { code, ...publicErrorDetails(error, fallback, this.options.exposeErrorStacks === true) }
  }

  private async readRequest(
    request: Request,
  ): Promise<
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly status: 400 | 413; readonly error: string }
  > {
    const declared = request.headers.get("content-length")
    if (declared !== null) {
      const length = decimalContentLength(declared)
      if (length === undefined)
        return { ok: false, status: 400, error: "content-length is invalid" }
      if (length > this.maxBodyBytes)
        return { ok: false, status: 413, error: "request body is too large" }
    }
    const result = await readBoundedText(request.body, this.maxBodyBytes)
    if (result.truncated) return { ok: false, status: 413, error: "request body is too large" }
    return { ok: true, text: result.text }
  }
}

function decimalContentLength(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  let length = 0
  for (const character of value) {
    length = length * 10 + (character.charCodeAt(0) - 48)
    if (!Number.isSafeInteger(length)) return Number.POSITIVE_INFINITY
  }
  return length
}

function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value)
}

function parseRpcRequest(text: string): RpcRequest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("request body must be JSON")
  }
  const object = record(value)
  if (typeof object.method !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(object.method))
    throw new Error("request method is invalid")
  return {
    method: object.method,
    ...(Object.hasOwn(object, "params") ? { params: object.params } : {}),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization")
  if (header === null || !header.startsWith("Bearer ")) return false
  return constantTimeEqual(header.slice(7), token)
}

function randomAuthToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(MIN_REMOTE_TOKEN_BYTES))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return difference === 0
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    vary: "Origin",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  })
  const origin = request.headers.get("origin")
  if (origin !== null && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin))
    headers.set("access-control-allow-origin", origin)
  return headers
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  )
}

function json(
  value: unknown,
  status: number,
  inherited: Headers,
  includeErrorStacks = false,
  maxBytes = DEFAULT_MAX_RPC_RESPONSE_BYTES,
): Response {
  const headers = new Headers(inherited)
  headers.set("content-type", "application/json; charset=utf-8")
  // lgtm [js/stack-trace-exposure] the default replacer removes stack fields from protocol data;
  // stacks are serialized only in explicitly opt-in, loopback-only diagnostics mode.
  let body: string
  let responseStatus = status
  try {
    body = serializeRpcValue(value, includeErrorStacks)
  } catch {
    body = JSON.stringify({
      error: {
        code: "response_serialization_failed",
        message: "RPC response could not be serialized",
      },
    })
    responseStatus = 500
  }
  if (serializedByteLength(body) > maxBytes) {
    body = JSON.stringify({
      error: {
        code: "response_too_large",
        message: "RPC response exceeded the configured size limit",
      },
    })
    responseStatus = 500
  }
  return new Response(body, { status: responseStatus, headers })
}

function resumableTurnConfig(
  option: CodingAgentRpcServerOptions["resumableTurns"],
): ResumableTurnConfig | undefined {
  if (option === undefined || option === false) return undefined
  const settings = option === true ? {} : option
  const config: ResumableTurnConfig = {
    maxEvents: settings.replayEvents ?? 1024,
    maxBytes: settings.replayBytes ?? 8 * 1024 * 1024,
    detachedTimeoutMs: settings.detachedTimeoutMs ?? 120_000,
  }
  if (
    !Number.isSafeInteger(config.maxEvents) ||
    config.maxEvents < 1 ||
    config.maxEvents > MAX_REPLAY_EVENTS
  )
    throw new RangeError(`agent rpc: replayEvents must be between 1 and ${MAX_REPLAY_EVENTS}`)
  if (
    !Number.isSafeInteger(config.maxBytes) ||
    config.maxBytes < 1024 ||
    config.maxBytes > MAX_REPLAY_BYTES
  )
    throw new RangeError(`agent rpc: replayBytes must be between 1024 and ${MAX_REPLAY_BYTES}`)
  if (
    !Number.isSafeInteger(config.detachedTimeoutMs) ||
    config.detachedTimeoutMs < 1 ||
    config.detachedTimeoutMs > MAX_DETACHED_TIMEOUT_MS
  )
    throw new RangeError(
      `agent rpc: detachedTimeoutMs must be between 1 and ${MAX_DETACHED_TIMEOUT_MS}`,
    )
  return Object.freeze(config)
}

function eventFrame(event: { readonly seq: number }, includeErrorStacks: boolean): string {
  return `id: ${event.seq}\ndata: ${serializeRpcValue(event, includeErrorStacks)}\n\n`
}

function turnErrorFrame(
  error: unknown,
  includeErrorStacks: boolean,
  maxResponseBytes: number,
): string {
  const detail = JSON.stringify({
    code: "turn_failed",
    ...publicErrorDetails(error, "turn could not be completed", includeErrorStacks),
  })
  const frame = `event: error\ndata: ${detail}\n\n`
  return serializedByteLength(frame) <= maxResponseBytes
    ? frame
    : 'event: error\ndata: {"code":"turn_failed","message":"turn could not be completed"}\n\n'
}

function eventStreamResponse(body: ReadableStream<Uint8Array>, cors: Headers): Response {
  return new Response(body, {
    status: 200,
    headers: new Headers({
      ...Object.fromEntries(cors),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    }),
  })
}

function serializeRpcValue(value: unknown, includeErrorStacks: boolean): string {
  const serialized = JSON.stringify(
    value,
    includeErrorStacks
      ? undefined
      : (key: string, nested: unknown) => (key === "stack" ? undefined : nested),
  )
  if (serialized === undefined) throw new TypeError("RPC value is not JSON serializable")
  return serialized
}

function serializedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
