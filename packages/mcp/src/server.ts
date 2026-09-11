/**
 * `createMcpServer` - assemble a mountable MCP server for a nifra app, with MCP Apps (`ui://`) widgets.
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
 *
 * SECURITY: this has NO built-in authentication - once mounted, every tool is callable by anyone who can
 * reach the route. Browser access is same-origin by default; set `allowAnyOrigin: true` only for a
 * secret-free public server. If any tool mutates state or returns private data, gate the route yourself
 * (check an `Authorization` header / session in the nifra handler before calling `mcp.fetch`).
 */

import { type McpHttpOptions, respondMcpHttp } from "./http.ts"
import {
  handleRpc,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpPrompt,
  type McpProtocolState,
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
  /** MCP Apps widgets - their resources are registered and the UI capability is advertised. */
  readonly widgets?: readonly McpWidget[]
  /** Extra (non-widget) resources to expose. */
  readonly resources?: readonly McpResource[]
  readonly prompts?: readonly McpPrompt[]
  /** GET health-page text. */
  readonly health?: string
  /** Max JSON-RPC body size in bytes (default 1 MB). */
  readonly maxBodyBytes?: number
  /** Max serialized JSON-RPC response or SSE frame size (default 1 MB). */
  readonly maxResponseBytes?: number
  /** Natural-language guidance for LLMs, surfaced in the modern `server/discover` result (2026-07-28). */
  readonly instructions?: string
  /** Explicitly allow browser clients from any origin. Omit for the secure same-origin default. */
  readonly allowAnyOrigin?: boolean
  /** Origin allowlist for the DNS-rebinding guard. Set it to permit exact cross-origin clients. */
  readonly allowedOrigins?: readonly string[]
  /** Shared state for one authenticated MCP session; prefer `resolveState` for multi-session hosts. */
  readonly state?: McpProtocolState
  /** Resolve a session-scoped request registry after per-message authorization. */
  readonly resolveState?: McpHttpOptions["resolveState"]
  /**
   * Per-message authorization, applied after the message parses and before any tool runs. Return
   * `false` to answer 403 with a JSON-RPC `unauthorized` error (`MCP_ERROR.UNAUTHORIZED`) and no result.
   *
   * This is the seam for "this caller may list tools but may not call the write ones" - the HTTP
   * layer above only sees one opaque POST, so a route guard cannot make that distinction.
   * `fetch(request, { authorizeMessage })` overrides it per request when the decision depends on
   * something the surrounding handler resolved (a session, a tenant).
   */
  readonly authorizeMessage?: (
    message: JsonRpcRequest,
    request: Request,
  ) => boolean | Promise<boolean>
}

export interface McpServer {
  readonly tools: McpTool[]
  readonly features: McpServerFeatures
  readonly serverInfo: { name: string; version: string }
  /** Web `fetch` handler - mount at `POST /mcp` (GET is a health page, OPTIONS the CORS preflight). */
  fetch(
    request: Request,
    overrides?: Pick<McpHttpOptions, "authorizeMessage" | "state" | "resolveState">,
  ): Promise<Response>
  /** Dispatch one JSON-RPC message directly (no HTTP) - for headless verification and unit tests. */
  handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null>
  /**
   * Release server-owned resources, when the implementation has any (for example a database worker).
   * Calling it more than once is safe. The base MCP server has nothing to release and omits this hook.
   */
  readonly close?: () => Promise<void>
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
    ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
  }
  return {
    tools,
    features,
    serverInfo,
    fetch: (request, overrides) =>
      respondMcpHttp(request, tools, serverInfo, {
        features,
        ...(opts.health !== undefined ? { health: opts.health } : {}),
        ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
        ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
        ...(opts.allowAnyOrigin === true ? { allowAnyOrigin: true } : {}),
        ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
        ...(opts.state === undefined ? {} : { state: opts.state }),
        ...(opts.resolveState === undefined ? {} : { resolveState: opts.resolveState }),
        ...(opts.authorizeMessage !== undefined ? { authorizeMessage: opts.authorizeMessage } : {}),
        ...(overrides?.authorizeMessage !== undefined
          ? { authorizeMessage: overrides.authorizeMessage }
          : {}),
        ...(overrides?.state === undefined ? {} : { state: overrides.state }),
        ...(overrides?.resolveState === undefined ? {} : { resolveState: overrides.resolveState }),
      }),
    handle: (message) =>
      handleRpc(message, tools, serverInfo, features, {
        ...(opts.state === undefined ? {} : { state: opts.state }),
      }),
  }
}
