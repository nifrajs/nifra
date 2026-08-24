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
 * reach the route (the CORS header is `*` and no credentials are used, so it is effectively public). That
 * is fine for read-only/public tools; if any tool mutates state or returns private data, gate the route
 * yourself (check an `Authorization` header / session in the nifra handler before calling `mcp.fetch`).
 */

import { type McpHttpOptions, respondMcpHttp } from "./http.ts"
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
  /** MCP Apps widgets - their resources are registered and the UI capability is advertised. */
  readonly widgets?: readonly McpWidget[]
  /** Extra (non-widget) resources to expose. */
  readonly resources?: readonly McpResource[]
  readonly prompts?: readonly McpPrompt[]
  /** GET health-page text. */
  readonly health?: string
  /** Max JSON-RPC body size in bytes (default 1 MB). */
  readonly maxBodyBytes?: number
  /** Natural-language guidance for LLMs, surfaced in the modern `server/discover` result (2026-07-28). */
  readonly instructions?: string
  /** Origin allowlist for the DNS-rebinding guard. Omit to allow any origin; set it to reject other
   * browser origins with 403 (e.g. a hardened, non-public mount). */
  readonly allowedOrigins?: readonly string[]
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
  fetch(request: Request, overrides?: Pick<McpHttpOptions, "authorizeMessage">): Promise<Response>
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
        ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
        ...(opts.authorizeMessage !== undefined ? { authorizeMessage: opts.authorizeMessage } : {}),
        ...(overrides?.authorizeMessage !== undefined
          ? { authorizeMessage: overrides.authorizeMessage }
          : {}),
      }),
    handle: (message) => handleRpc(message, tools, serverInfo, features),
  }
}
