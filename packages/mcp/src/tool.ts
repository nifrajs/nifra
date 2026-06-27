/**
 * `defineMcpTool` — author a tool for a nifra MCP server, optionally backed by an MCP Apps widget.
 *
 * The handler returns either a `string` (a plain text result, base MCP) or an object with `structuredContent`
 * (the data a linked {@link ./widget.ts | widget} renders) and/or `text` (the model-facing summary). When a
 * `widget` is passed, the tool advertises it via `_meta.ui.resourceUri` on both `tools/list` and each
 * `tools/call` result, so the host knows to render the widget — see {@link ../protocol.ts}.
 */

import type { McpContentBlock, McpTool, McpToolContext, McpToolResult } from "./protocol.ts"
import type { McpWidget } from "./widget.ts"

/** The ergonomic result an MCP-tool handler may return (coerced to the protocol's {@link McpToolResult}). */
export type McpToolHandlerResult =
  | string
  | {
      /** Model-facing text (becomes a single text content block when `content` is omitted). */
      readonly text?: string
      /** Explicit content blocks (overrides `text`). */
      readonly content?: readonly McpContentBlock[]
      /** Structured data for the linked widget — NOT added to the model's context. */
      readonly structuredContent?: Record<string, unknown>
      readonly _meta?: Record<string, unknown>
      readonly isError?: boolean
    }

export interface DefineMcpToolOptions {
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments. Defaults to an empty object schema. */
  readonly inputSchema?: Record<string, unknown>
  /** Link a widget so the tool's result renders as interactive UI in MCP Apps hosts. */
  readonly widget?: McpWidget
  readonly handler: (
    args: Record<string, unknown>,
    context: McpToolContext,
  ) => McpToolHandlerResult | Promise<McpToolHandlerResult>
}

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

function coerce(result: McpToolHandlerResult): string | McpToolResult {
  if (typeof result === "string") return result
  const content =
    result.content ??
    (result.text !== undefined ? [{ type: "text", text: result.text }] : undefined)
  return {
    ...(content !== undefined ? { content } : {}),
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result._meta !== undefined ? { _meta: result._meta } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  }
}

export function defineMcpTool(opts: DefineMcpToolOptions): McpTool {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema ?? EMPTY_OBJECT_SCHEMA,
    ...(opts.widget !== undefined ? { _meta: opts.widget.meta } : {}),
    handler: async (args, context) => coerce(await opts.handler(args, context)),
  }
}
