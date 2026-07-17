/**
 * `@nifrajs/mcp` — build MCP servers (and MCP Apps) for a nifra app.
 *
 * - {@link ./protocol.ts} — the transport-agnostic JSON-RPC dispatch ({@link handleRpc}) + types, plus
 *   the MCP Apps (SEP-1865) extension (`structuredContent`, `_meta.ui.resourceUri`, the UI capability).
 * - {@link ./http.ts} — {@link respondMcpHttp}, a Web `fetch` handler you mount at `POST /mcp`.
 *
 * Higher-level authoring helpers — {@link defineMcpWidget}, {@link defineMcpTool}, {@link createMcpServer}
 * — build MCP Apps servers whose tool results render real UI.
 */

export { bridgeScript, type McpAppBridge } from "./bridge.ts"
export { type McpHttpOptions, respondMcpHttp } from "./http.ts"
export * from "./protocol.ts"
export { type CreateMcpServerOptions, createMcpServer, type McpServer } from "./server.ts"
export type {
  InferOutput,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
} from "./standard.ts"
export {
  type DefineMcpToolOptions,
  defineMcpTool,
  type McpToolHandlerResult,
  type McpUiIntent,
} from "./tool.ts"
export {
  type DefineMcpWidgetOptions,
  defineMcpWidget,
  type McpWidget,
  uiResourceMeta,
  widgetDocument,
} from "./widget.ts"
