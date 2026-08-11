/**
 * The pure MCP (Model Context Protocol) JSON-RPC dispatch - no I/O, no `Bun.*`, no side effects, so it
 * unit-tests cleanly. A transport (stdio in `@nifrajs/cli`'s `mcp.ts`, Streamable-HTTP in {@link ./http.ts})
 * wires this to a byte stream; the tools/resources are injected, so the protocol logic is exercised
 * without spawning or reading streams.
 *
 * Beyond base MCP this also implements the server half of **MCP Apps (SEP-1865)** - interactive `ui://`
 * widgets: a tool links a UI resource via `_meta.ui.resourceUri`, `tools/call` returns `structuredContent`
 * for the widget to render, and `initialize` advertises the `io.modelcontextprotocol/ui` extension. All of
 * it is additive - a tool whose handler returns a plain `string` behaves exactly as before.
 */

/** The protocol revision this server advertises by default. A handshake-era version - the HTTP transport
 * still uses `initialize`; current clients reach it through their backward-compatibility fallback.
 * `initialize` echoes the client's own requested version instead when it's one this server also speaks
 * ({@link SUPPORTED_PROTOCOL_VERSIONS}). */
export const PROTOCOL_VERSION = "2025-06-18"
/** The handshake-era revisions this server speaks. `initialize` echoes the client's requested
 * `protocolVersion` when it's in this set (the smoothest negotiation), else answers {@link PROTOCOL_VERSION}. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
])

/** The stateless per-request revision (2026-07-28+). A request carrying its version in `_meta`
 * (`io.modelcontextprotocol/protocolVersion`) is served in modern mode; an `initialize` request stays
 * legacy. This server is dual-era: `handleRpc` answers both on the same dispatch, per request. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28"
/** MCP-reserved JSON-RPC error codes (2026-07-28 error-code policy carves out -32020..-32099 for the spec). */
export const MCP_ERROR = { HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022 } as const
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

/** The MIME type a UI resource MUST use so a host recognizes it as an MCP App widget (SEP-1865). */
export const UI_MIME = "text/html;profile=mcp-app"
/** The `capabilities.extensions` key advertising UI support in the `initialize` result (SEP-1865). */
export const UI_EXTENSION_KEY = "io.modelcontextprotocol/ui"

type RequestId = string | number
type JsonRpcId = RequestId | null
type ProgressToken = string | number

export interface McpToolContext {
  readonly signal: AbortSignal
  readonly requestId: JsonRpcId
  readonly progressToken?: ProgressToken
  readonly reportProgress: (progress: number, total?: number) => void
}

/** A single content block in a tool result. Today only text - the model-facing representation. */
export interface McpContentBlock {
  readonly type: "text"
  readonly text: string
}

/**
 * The rich result a tool handler may return instead of a bare string (MCP Apps). `content` is the
 * model-facing text (also shown by text-only hosts); `structuredContent` is the data a linked `ui://`
 * widget renders and is deliberately NOT added to the model's context; `_meta` carries the
 * `ui.resourceUri` link and any render hints. Returning a `string` is shorthand for one text block.
 */
export interface McpToolResult {
  readonly content?: readonly McpContentBlock[]
  readonly structuredContent?: Record<string, unknown>
  readonly _meta?: Record<string, unknown>
  readonly isError?: boolean
}

/** A tool the agent can call. `handler` returns the text shown to the agent, or a rich {@link McpToolResult}
 * (for MCP Apps: structured data + a `ui://` widget link). `_meta` is the per-tool descriptor metadata
 * surfaced in `tools/list` - for a widget tool it carries `ui.resourceUri`. */
/** MCP tool safety hints (`readOnlyHint`/`destructiveHint`/…) surfaced in `tools/list`, per the MCP spec. */
export interface McpToolAnnotations {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: McpToolAnnotations
  readonly _meta?: Record<string, unknown>
  readonly handler: (
    args: Record<string, unknown>,
    context: McpToolContext,
  ) => Promise<string | McpToolResult>
}

export interface McpResource {
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
  /** Descriptor `_meta` (MCP Apps: CSP / domain / border render hints under `ui`). */
  readonly _meta?: Record<string, unknown>
  readonly read: () => Promise<{ readonly text: string; readonly mimeType?: string }>
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant"
  readonly content: { readonly type: "text"; readonly text: string }
}

export interface McpPrompt {
  readonly name: string
  readonly description: string
  readonly arguments?: readonly {
    readonly name: string
    readonly description?: string
    readonly required?: boolean
  }[]
  readonly handler: (args: Record<string, unknown>) => Promise<readonly McpPromptMessage[]>
}

export interface McpServerFeatures {
  readonly resources?: readonly McpResource[]
  readonly prompts?: readonly McpPrompt[]
  /** Advertise the MCP Apps UI extension in `initialize`. Present when the server serves `ui://` widgets;
   * `mimeTypes` defaults to `[UI_MIME]`. */
  readonly ui?: { readonly mimeTypes?: readonly string[] }
  /** Natural-language guidance for LLMs on how to use this server. Surfaced in the modern
   * `server/discover` result (2026-07-28) and in the legacy `initialize` result (`instructions` is an
   * optional field of that result in every handshake-era revision this server speaks). */
  readonly instructions?: string
}

export interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: JsonRpcId
  readonly method?: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: Record<string, unknown>
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }

export const rpcResult = (id: JsonRpcId, value: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result: value,
})
export const rpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data !== undefined ? { code, message, data } : { code, message },
})

export interface McpProtocolState {
  readonly activeRequests: Map<string, AbortController>
}

export interface McpProtocolOptions {
  readonly state?: McpProtocolState
  readonly signal?: AbortSignal
  readonly sendNotification?: (notification: JsonRpcNotification) => void
}

export function createMcpProtocolState(): McpProtocolState {
  return { activeRequests: new Map() }
}

function requestKey(id: unknown): string | undefined {
  if (typeof id === "string") return `s:${id}`
  return typeof id === "number" && Number.isFinite(id) ? `n:${id}` : undefined
}

function metaObject(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const meta = params?._meta
  return typeof meta === "object" && meta !== null && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined
}

/** The protocol version a modern (2026-07-28+) request declares in `_meta`, or `undefined` for a legacy
 * request. Its presence is what puts the dispatch in modern mode for that one request. */
export function modernVersionOf(params: Record<string, unknown> | undefined): string | undefined {
  const version = metaObject(params)?.[META_PROTOCOL_VERSION]
  return typeof version === "string" ? version : undefined
}

function progressTokenOf(params: Record<string, unknown> | undefined): ProgressToken | undefined {
  const token = metaObject(params)?.progressToken
  return typeof token === "string" || (typeof token === "number" && Number.isFinite(token))
    ? token
    : undefined
}

function cancellationReason(params: Record<string, unknown> | undefined): string | undefined {
  const reason = params?.reason
  return typeof reason === "string" && reason.length > 0 ? reason : undefined
}

function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => {}
  if (parent.aborted) {
    child.abort(parent.reason)
    return () => {}
  }
  const abort = (): void => child.abort(parent.reason)
  parent.addEventListener("abort", abort, { once: true })
  return () => parent.removeEventListener("abort", abort)
}

function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason
  if (typeof reason === "string" && reason.length > 0) return `Cancelled: ${reason}`
  return "Cancelled"
}

function compactDescription(description: string): string {
  const text = description.replace(/\s+/g, " ").trim()
  const sentenceEnd = text.search(/[.!?](?:\s|$)/)
  const sentence = sentenceEnd === -1 ? text : text.slice(0, sentenceEnd + 1)
  if (sentence.length <= 120) return sentence
  return `${sentence.slice(0, 117).trimEnd()}...`
}

/** Freshness hint for the static docs corpus - a modern client MAY cache list/read results this long. */
const DEFAULT_CACHE_TTL_MS = 3_600_000

/** Wrap a result in the 2026-07-28 completion envelope: `resultType`, a self-identifying `serverInfo`
 * under `_meta`, and - for the cacheable list/read methods - a public freshness hint. Legacy results skip
 * this entirely and keep their exact pre-2026-07-28 shape. */
function withEnvelope(
  value: Record<string, unknown>,
  serverInfo: { name: string; version: string },
  cacheable: boolean,
): Record<string, unknown> {
  const existingMeta =
    typeof value._meta === "object" && value._meta !== null && !Array.isArray(value._meta)
      ? (value._meta as Record<string, unknown>)
      : undefined
  return {
    ...value,
    resultType: "complete",
    _meta: { ...(existingMeta ?? {}), [META_SERVER_INFO]: serverInfo },
    ...(cacheable ? { ttlMs: DEFAULT_CACHE_TTL_MS, cacheScope: "public" } : {}),
  }
}

/** Normalize a handler's return into the `tools/call` result object. A `string` becomes a single text
 * block (base-MCP behavior, unchanged); a {@link McpToolResult} passes `content`/`structuredContent`
 * through, and inherits the tool descriptor's `_meta` (the `ui.resourceUri` link) when it sets none. */
function toolCallResult(result: string | McpToolResult, tool: McpTool): Record<string, unknown> {
  if (typeof result === "string") return { content: [{ type: "text", text: result }] }
  const meta =
    tool._meta !== undefined || result._meta !== undefined
      ? { ...(tool._meta ?? {}), ...(result._meta ?? {}) }
      : undefined
  return {
    content: result.content ?? [],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  }
}

/**
 * Dispatch one JSON-RPC message against the given tools. Returns the response, or `null` for a
 * notification (no reply). Tool errors are reported in-band (`isError`) so the agent can react to them.
 */
export async function handleRpc(
  message: JsonRpcRequest,
  tools: readonly McpTool[],
  serverInfo: { name: string; version: string },
  features: McpServerFeatures = {},
  options: McpProtocolOptions = {},
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = message
  const isNotification = id === undefined
  const rid = id ?? null
  const resources = features.resources ?? []
  const prompts = features.prompts ?? []
  const state = options.state ?? createMcpProtocolState()

  // A request that declares its version in `_meta` is a modern (2026-07-28+) request. We speak exactly one
  // modern revision; any other declared version is rejected so the client can retry with a supported one.
  const requestedVersion = modernVersionOf(params)
  const isModern = requestedVersion !== undefined
  if (isModern && requestedVersion !== MODERN_PROTOCOL_VERSION) {
    return rpcError(rid, MCP_ERROR.UNSUPPORTED_VERSION, "Unsupported protocol version", {
      supported: [MODERN_PROTOCOL_VERSION],
      requested: requestedVersion,
    })
  }
  // Modern results carry the completion envelope; legacy results keep their exact prior shape. Every data
  // case returns through `reply` so the one `isModern` decision drives the whole response shape.
  const reply = (value: Record<string, unknown>, cacheable = false): JsonRpcResponse =>
    rpcResult(rid, isModern ? withEnvelope(value, serverInfo, cacheable) : value)

  switch (method) {
    case "initialize": {
      // Handshake version negotiation: answer with the client's requested version when we speak it too,
      // otherwise our default. The client then decides whether our answer is acceptable.
      const requested = params?.protocolVersion
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : PROTOCOL_VERSION
      return rpcResult(rid, {
        protocolVersion,
        capabilities: {
          tools: {},
          ...(resources.length > 0 ? { resources: {} } : {}),
          ...(prompts.length > 0 ? { prompts: {} } : {}),
          ...(features.ui !== undefined
            ? {
                extensions: {
                  [UI_EXTENSION_KEY]: { mimeTypes: features.ui.mimeTypes ?? [UI_MIME] },
                },
              }
            : {}),
        },
        serverInfo,
        ...(features.instructions !== undefined ? { instructions: features.instructions } : {}),
      })
    }
    case "server/discover":
      // The modern capability/identity probe (replaces `initialize` for 2026-07-28 clients). Always
      // enveloped and cacheable - it is a modern-only RPC.
      return rpcResult(
        rid,
        withEnvelope(
          {
            supportedVersions: [MODERN_PROTOCOL_VERSION],
            capabilities: {
              tools: {},
              ...(resources.length > 0 ? { resources: {} } : {}),
              ...(prompts.length > 0 ? { prompts: {} } : {}),
              ...(features.ui !== undefined
                ? {
                    extensions: {
                      [UI_EXTENSION_KEY]: { mimeTypes: features.ui.mimeTypes ?? [UI_MIME] },
                    },
                  }
                : {}),
            },
            ...(features.instructions !== undefined ? { instructions: features.instructions } : {}),
          },
          serverInfo,
          true,
        ),
      )
    case "notifications/initialized":
      return null
    case "notifications/cancelled": {
      const key = requestKey(params?.requestId)
      if (key !== undefined) state.activeRequests.get(key)?.abort(cancellationReason(params))
      return null
    }
    case "ping":
      return rpcResult(rid, {})
    case "tools/list":
      return reply(
        params?.compact === true
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: compactDescription(t.description),
              })),
            }
          : {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
                ...(t._meta !== undefined ? { _meta: t._meta } : {}),
              })),
            },
        true,
      )
    case "tools/describe": {
      const name = params?.name
      const tool = tools.find((t) => t.name === name)
      if (!tool) return rpcError(rid, -32602, `unknown tool: ${String(name)}`)
      return reply({
        tool: {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
        },
      })
    }
    case "tools/call": {
      const name = params?.name
      const tool = tools.find((t) => t.name === name)
      if (!tool) return rpcError(rid, -32602, `unknown tool: ${String(name)}`)
      const args = (params?.arguments as Record<string, unknown>) ?? {}
      const controller = new AbortController()
      const key = requestKey(id)
      const cleanupAbort = linkAbortSignal(options.signal, controller)
      if (key !== undefined) state.activeRequests.set(key, controller)
      const progressToken = progressTokenOf(params)
      let lastProgress = Number.NEGATIVE_INFINITY
      const reportProgress = (progress: number, total?: number): void => {
        if (
          progressToken === undefined ||
          !Number.isFinite(progress) ||
          progress <= lastProgress ||
          (total !== undefined && !Number.isFinite(total))
        ) {
          return
        }
        lastProgress = progress
        options.sendNotification?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
          },
        })
      }
      try {
        reportProgress(0, 1)
        if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError")
        const result = await tool.handler(args, {
          signal: controller.signal,
          requestId: rid,
          ...(progressToken !== undefined ? { progressToken } : {}),
          reportProgress,
        })
        if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError")
        reportProgress(1, 1)
        return reply(toolCallResult(result, tool))
      } catch (err) {
        if (controller.signal.aborted) {
          return reply({
            content: [{ type: "text", text: abortMessage(controller.signal) }],
            isError: true,
          })
        }
        const msg = err instanceof Error ? err.message : String(err)
        return reply({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true })
      } finally {
        cleanupAbort()
        if (key !== undefined && state.activeRequests.get(key) === controller) {
          state.activeRequests.delete(key)
        }
      }
    }
    case "resources/list":
      return reply(
        {
          resources: resources.map((r) => ({
            uri: r.uri,
            name: r.name,
            ...(r.description !== undefined ? { description: r.description } : {}),
            ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
            ...(r._meta !== undefined ? { _meta: r._meta } : {}),
          })),
        },
        true,
      )
    case "resources/read": {
      const uri = params?.uri
      const resource = resources.find((r) => r.uri === uri)
      if (!resource) return rpcError(rid, -32602, `unknown resource: ${String(uri)}`)
      try {
        const content = await resource.read()
        return reply(
          {
            contents: [
              {
                uri: resource.uri,
                mimeType: content.mimeType ?? resource.mimeType ?? "text/plain",
                text: content.text,
                ...(resource._meta !== undefined ? { _meta: resource._meta } : {}),
              },
            ],
          },
          true,
        )
      } catch {
        // Don't surface the raw read error - it can leak a filesystem path. Return a generic message.
        return rpcError(rid, -32000, `failed to read resource: ${String(uri)}`)
      }
    }
    case "prompts/list":
      return reply(
        {
          prompts: prompts.map((p) => ({
            name: p.name,
            description: p.description,
            ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
          })),
        },
        true,
      )
    case "prompts/get": {
      const name = params?.name
      const prompt = prompts.find((p) => p.name === name)
      if (!prompt) return rpcError(rid, -32602, `unknown prompt: ${String(name)}`)
      const args = (params?.arguments as Record<string, unknown>) ?? {}
      try {
        return reply({
          description: prompt.description,
          messages: await prompt.handler(args),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return rpcError(rid, -32000, msg)
      }
    }
    default:
      if (isNotification) return null
      return rpcError(rid, -32601, `method not found: ${String(method)}`)
  }
}
