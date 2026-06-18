/**
 * The pure MCP (Model Context Protocol) JSON-RPC dispatch — no I/O, no `Bun.*`, no side effects, so it
 * unit-tests cleanly. {@link runMcpServer} in `./mcp.ts` wires this to stdin/stdout; the tools are
 * injected, so the protocol logic is exercised without spawning or reading streams.
 */

export const PROTOCOL_VERSION = "2024-11-05"

type RequestId = string | number
type JsonRpcId = RequestId | null
type ProgressToken = string | number

export interface McpToolContext {
  readonly signal: AbortSignal
  readonly requestId: JsonRpcId
  readonly progressToken?: ProgressToken
  readonly reportProgress: (progress: number, total?: number) => void
}

/** A tool the agent can call. `handler` returns the text shown to the agent. */
export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly handler: (args: Record<string, unknown>, context: McpToolContext) => Promise<string>
}

export interface McpResource {
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
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
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } }

export const rpcResult = (id: JsonRpcId, value: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result: value,
})
export const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
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

function progressTokenOf(params: Record<string, unknown> | undefined): ProgressToken | undefined {
  const meta = params?._meta
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined
  const token = (meta as Record<string, unknown>).progressToken
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

  switch (method) {
    case "initialize":
      return rpcResult(rid, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          ...(resources.length > 0 ? { resources: {} } : {}),
          ...(prompts.length > 0 ? { prompts: {} } : {}),
        },
        serverInfo,
      })
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
      return rpcResult(
        rid,
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
              })),
            },
      )
    case "tools/describe": {
      const name = params?.name
      const tool = tools.find((t) => t.name === name)
      if (!tool) return rpcError(rid, -32602, `unknown tool: ${String(name)}`)
      return rpcResult(rid, {
        tool: {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
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
        const text = await tool.handler(args, {
          signal: controller.signal,
          requestId: rid,
          ...(progressToken !== undefined ? { progressToken } : {}),
          reportProgress,
        })
        if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError")
        reportProgress(1, 1)
        return rpcResult(rid, { content: [{ type: "text", text }] })
      } catch (err) {
        if (controller.signal.aborted) {
          return rpcResult(rid, {
            content: [{ type: "text", text: abortMessage(controller.signal) }],
            isError: true,
          })
        }
        const msg = err instanceof Error ? err.message : String(err)
        return rpcResult(rid, { content: [{ type: "text", text: `Error: ${msg}` }], isError: true })
      } finally {
        cleanupAbort()
        if (key !== undefined && state.activeRequests.get(key) === controller) {
          state.activeRequests.delete(key)
        }
      }
    }
    case "resources/list":
      return rpcResult(rid, {
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description !== undefined ? { description: r.description } : {}),
          ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
        })),
      })
    case "resources/read": {
      const uri = params?.uri
      const resource = resources.find((r) => r.uri === uri)
      if (!resource) return rpcError(rid, -32602, `unknown resource: ${String(uri)}`)
      try {
        const content = await resource.read()
        return rpcResult(rid, {
          contents: [
            {
              uri: resource.uri,
              mimeType: content.mimeType ?? resource.mimeType ?? "text/plain",
              text: content.text,
            },
          ],
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return rpcError(rid, -32000, msg)
      }
    }
    case "prompts/list":
      return rpcResult(rid, {
        prompts: prompts.map((p) => ({
          name: p.name,
          description: p.description,
          ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
        })),
      })
    case "prompts/get": {
      const name = params?.name
      const prompt = prompts.find((p) => p.name === name)
      if (!prompt) return rpcError(rid, -32602, `unknown prompt: ${String(name)}`)
      const args = (params?.arguments as Record<string, unknown>) ?? {}
      try {
        return rpcResult(rid, {
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
