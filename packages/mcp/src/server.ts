/**
 * `createMcpServer` — assemble a mountable MCP server for a nifra app, with MCP Apps (`ui://`) widgets.
 *
 * Pass tools (ideally from {@link ./tool.ts | defineMcpTool}) and widgets (from {@link ./widget.ts |
 * defineMcpWidget}); the widgets' resources are registered and the `io.modelcontextprotocol/ui` capability
 * is advertised automatically. Mount it in a nifra backend by handing the raw request to {@link McpServer.fetch}:
 *
 * ```ts
 * const mcp = createMcpServer({ name: "orders", version: "1.0.0", tools, widgets })
 * export const backend = server()
 *   .get("/mcp", (c) => mcp.fetch(c.req))
 *   .post("/mcp", (c) => mcp.fetch(c.req))
 * ```
 *
 * {@link McpServer.handle} dispatches a single JSON-RPC message directly (for headless verification / tests).
 */

import { respondMcpHttp } from "./http.ts"
import {
  handleRpc,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpPrompt,
  type McpResource,
  type McpServerFeatures,
  type McpTool,
  UI_MIME,
} from "./protocol.ts"
import type { McpWidget } from "./widget.ts"

export interface CreateMcpServerOptions {
  readonly name: string
  readonly version: string
  readonly tools?: readonly McpTool[]
  /** MCP Apps widgets — their resources are registered and the UI capability is advertised. */
  readonly widgets?: readonly McpWidget[]
  /** Extra (non-widget) resources to expose. */
  readonly resources?: readonly McpResource[]
  readonly prompts?: readonly McpPrompt[]
  /** GET health-page text. */
  readonly health?: string
  /** Max JSON-RPC body size in bytes (default 1 MB). */
  readonly maxBodyBytes?: number
}

export interface McpServer {
  readonly tools: McpTool[]
  readonly features: McpServerFeatures
  readonly serverInfo: { name: string; version: string }
  /** Web `fetch` handler — mount at `POST /mcp` (GET is a health page, OPTIONS the CORS preflight). */
  fetch(request: Request): Promise<Response>
  /** Dispatch one JSON-RPC message directly (no HTTP) — for headless verification and unit tests. */
  handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null>
}

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const tools = [...(opts.tools ?? [])]
  const widgets = opts.widgets ?? []
  // Widget resources first (a widget is discovered through its tool's _meta, but listing it is harmless
  // and lets a host fetch it via resources/read).
  const resources: McpResource[] = [...widgets.map((w) => w.resource), ...(opts.resources ?? [])]
  const serverInfo = { name: opts.name, version: opts.version }
  const features: McpServerFeatures = {
    ...(resources.length > 0 ? { resources } : {}),
    ...(opts.prompts !== undefined ? { prompts: opts.prompts } : {}),
    ...(widgets.length > 0 ? { ui: { mimeTypes: [UI_MIME] } } : {}),
  }
  return {
    tools,
    features,
    serverInfo,
    fetch: (request) =>
      respondMcpHttp(request, tools, serverInfo, {
        features,
        ...(opts.health !== undefined ? { health: opts.health } : {}),
        ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
      }),
    handle: (message) => handleRpc(message, tools, serverInfo, features),
  }
}
