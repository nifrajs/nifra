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

/**
 * A render-intent hint for GENERATIVE hosts: how to present the result's
 * `structuredContent` when the host renders its OWN themed UI rather than an iframe widget. The host maps
 * the intent to a component in its design system (a shadcn/Tailwind table, form, metric card, …). Open
 * union — pick a known tag or a custom one.
 */
export type McpUiIntent =
  | "table"
  | "list"
  | "cards"
  | "form"
  | "metric"
  | "detail"
  | "chart"
  | (string & {})

export interface DefineMcpToolOptions {
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments. Defaults to an empty object schema. */
  readonly inputSchema?: Record<string, unknown>
  /** Link a widget so the tool's result renders as interactive UI in MCP Apps hosts (iframe). */
  readonly widget?: McpWidget
  /** Render-intent for generative hosts that build their own themed UI from `structuredContent`. Lands
   * in `_meta.ui.intent`. Independent of `widget` — a tool can offer both (widget for MCP Apps hosts,
   * intent for generative builders). */
  readonly intent?: McpUiIntent
  readonly handler: (
    args: Record<string, unknown>,
    context: McpToolContext,
  ) => McpToolHandlerResult | Promise<McpToolHandlerResult>
}

/** Build a tool's descriptor `_meta` from its widget link and/or render intent (both under `ui`). */
function toolMeta(widget?: McpWidget, intent?: string): Record<string, unknown> | undefined {
  if (widget === undefined && intent === undefined) return undefined
  const ui: Record<string, unknown> = {}
  if (widget !== undefined) ui.resourceUri = widget.uri
  if (intent !== undefined) ui.intent = intent
  const meta: Record<string, unknown> = { ui }
  // Deprecated-flat alias for hosts that still read it.
  if (widget !== undefined) meta["ui/resourceUri"] = widget.uri
  return meta
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
  const meta = toolMeta(opts.widget, opts.intent)
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema ?? EMPTY_OBJECT_SCHEMA,
    ...(meta !== undefined ? { _meta: meta } : {}),
    handler: async (args, context) => coerce(await opts.handler(args, context)),
  }
}
