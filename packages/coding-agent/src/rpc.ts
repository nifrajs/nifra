import {
  type AgentBackend,
  type AgentSessionSnapshot,
  type ReloadResult,
  resumeFromCursor,
} from "@nifrajs/agent-protocol"
import { readProjectDiff } from "./diff.ts"
import { publicErrorDetails } from "./errors.ts"
import type { ExtensionHost } from "./extensions.ts"
import { CodingAgentHost, type CodingAgentHostOptions } from "./host.ts"
import { readBoundedText } from "./process.ts"
import type { ContextWindowOptions, SessionStore } from "./sessions.ts"
import type { UiExtensionHost, UiExtensionManifest } from "./ui.ts"
import { runNifraVerification } from "./verification.ts"

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
  readonly sessionStore?: SessionStore
  readonly contextWindow?: ContextWindowOptions
  readonly extensions?: ExtensionHost
  readonly ui?: UiExtensionHost
  readonly verifyAfterTurn?: readonly ("check" | "assure" | "test")[]
  readonly verification?: CodingAgentHostOptions["verification"]
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
  private listener: RpcServerLike | undefined

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
      ...(options.verification === undefined ? {} : { verification: options.verification }),
    })
    this.token = options.authToken ?? crypto.randomUUID().replaceAll("-", "")
    if (!/^[A-Za-z0-9._~-]{16,256}$/.test(this.token))
      throw new TypeError("agent rpc: authToken must be a bounded token")
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1024)
      throw new RangeError("agent rpc: maxBodyBytes must be at least 1024")
  }

  async start(): Promise<CodingAgentRpcServerHandle> {
    if (this.listener !== undefined) throw new Error("agent rpc: server is already running")
    const hostname = this.options.hostname ?? "127.0.0.1"
    if (!this.options.allowRemote && !isLoopbackHost(hostname))
      throw new Error("agent rpc: remote binding requires allowRemote: true")
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
    await this.host.stop("rpc server stopped")
    listener?.stop(true)
  }

  private async fetch(request: Request): Promise<Response> {
    const cors = corsHeaders(request)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET")
      return json({ ok: true, protocol: 1 }, 200, cors)
    if (!authorized(request, this.token))
      return json(
        { error: { code: "unauthorized", message: "agent RPC authorization required" } },
        401,
        cors,
      )
    if (url.pathname !== "/rpc" || request.method !== "POST")
      return json(
        { error: { code: "not_found", message: "unknown agent RPC endpoint" } },
        404,
        cors,
      )
    const body = await this.readRequest(request)
    if (!body.ok)
      return json({ error: { code: "invalid_request", message: body.error } }, body.status, cors)
    let rpc: RpcRequest
    try {
      rpc = parseRpcRequest(body.text)
    } catch (error) {
      return json(
        { error: this.protocolError("invalid_request", error, "request body is invalid") },
        400,
        cors,
        this.options.exposeErrorStacks === true,
      )
    }
    try {
      return await this.dispatch(rpc, request, cors)
    } catch (error) {
      return json(
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
    switch (request.method) {
      case "session.create": {
        const params = record(request.params)
        const snapshot =
          this.host.snapshot ??
          (await this.host.start({
            cwd: this.options.cwd,
            backend: this.options.backend.info.name,
            ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
          }))
        return json(snapshot, 200, cors)
      }
      case "session.snapshot": {
        const snapshot = this.requireSnapshot()
        return json(snapshot, 200, cors)
      }
      case "session.resume": {
        const params = record(request.params)
        if (
          typeof params.sessionId !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(params.sessionId)
        )
          return json(
            { error: { code: "invalid_session", message: "sessionId is required" } },
            422,
            cors,
          )
        const snapshot =
          this.host.snapshot ??
          (await this.host.start({
            cwd: this.options.cwd,
            backend: this.options.backend.info.name,
            sessionId: params.sessionId,
          }))
        return json(snapshot, 200, cors)
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
        return json({ snapshot, resume: resumeFromCursor(window, cursor) }, 200, cors)
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
        if (params.targetSessionId !== undefined && typeof params.targetSessionId !== "string")
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
        const stream = this.host.prompt(params.message, httpRequest.signal)
        const encoder = new TextEncoder()
        const includeErrorStacks = this.options.exposeErrorStacks === true
        const turnError = (error: unknown) => ({
          code: "turn_failed",
          ...publicErrorDetails(error, "turn could not be completed", includeErrorStacks),
        })
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const event of stream)
                controller.enqueue(
                  encoder.encode(`data: ${serializeRpcValue(event, includeErrorStacks)}\n\n`),
                )
              controller.close()
            } catch (error) {
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify(turnError(error))}\n\n`),
              )
              controller.close()
            }
          },
        })
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
        return json({ pending: this.host.pendingApprovals }, 200, cors)
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
        return json(result, result.ok ? 200 : 422, cors, this.options.exposeErrorStacks === true)
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

  private requireSnapshot(): AgentSessionSnapshot {
    if (this.host.snapshot === undefined) throw new Error("agent RPC session has not been created")
    return this.host.snapshot
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
    const length = Number(request.headers.get("content-length") ?? "0")
    if (Number.isFinite(length) && length > this.maxBodyBytes)
      return { ok: false, status: 413, error: "request body is too large" }
    const result = await readBoundedText(request.body, this.maxBodyBytes)
    if (result.truncated) return { ok: false, status: 413, error: "request body is too large" }
    return { ok: true, text: result.text }
  }
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
): Response {
  const headers = new Headers(inherited)
  headers.set("content-type", "application/json; charset=utf-8")
  // lgtm [js/stack-trace-exposure] the default replacer removes stack fields from protocol data;
  // stacks are serialized only in explicitly opt-in, loopback-only diagnostics mode.
  return new Response(serializeRpcValue(value, includeErrorStacks), { status, headers })
}

function serializeRpcValue(value: unknown, includeErrorStacks: boolean): string {
  return JSON.stringify(
    value,
    includeErrorStacks
      ? undefined
      : (key: string, nested: unknown) => (key === "stack" ? undefined : nested),
  )
}
