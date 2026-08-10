/** MCP adapter for the public Nifra typed tool contract. */

import {
  executeTool,
  type ToolCallOptions,
  type ToolContract,
  toolInputJsonSchema,
} from "@nifrajs/core/tool-contract"
import type { McpContentBlock, McpTool, McpToolAnnotations } from "./protocol.ts"

export interface McpToolContractOptions extends Omit<ToolCallOptions, "signal" | "ledger"> {
  readonly capabilities?: readonly string[]
}

/** Adapt a contract to MCP without creating a second validation or enforcement path. */
export function toMcpTool<Input, Output>(
  tool: ToolContract<Input, Output>,
  options: McpToolContractOptions = {},
): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputJsonSchema(tool),
    annotations: mcpAnnotations(tool),
    handler: async (args, context) =>
      mcpResult(await executeTool(tool, args, { ...options, signal: context.signal })),
  }
}

function mcpAnnotations<Input, Output>(tool: ToolContract<Input, Output>): McpToolAnnotations {
  return {
    ...(tool.annotations.title === undefined ? {} : { title: tool.annotations.title }),
    ...(tool.annotations.readOnlyHint === undefined
      ? {}
      : { readOnlyHint: tool.annotations.readOnlyHint }),
    ...(tool.annotations.destructiveHint === undefined
      ? {}
      : { destructiveHint: tool.annotations.destructiveHint }),
    ...(tool.annotations.idempotentHint === undefined
      ? { idempotentHint: tool.idempotency !== undefined }
      : { idempotentHint: tool.annotations.idempotentHint }),
    ...(tool.annotations.openWorldHint === undefined
      ? {}
      : { openWorldHint: tool.annotations.openWorldHint }),
  }
}

function mcpResult(
  result: Awaited<ReturnType<typeof executeTool>>,
): string | { readonly content: readonly McpContentBlock[]; readonly isError?: true } {
  const value = result.ok
    ? {
        ok: true,
        ...(result.output === undefined ? {} : { output: result.output }),
        dryRun: result.dryRun,
        evidence: result.evidence,
      }
    : { ok: false, error: result.error, dryRun: result.dryRun, evidence: result.evidence }
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(result.ok ? {} : { isError: true as const }),
  }
}

export type { ToolCallOptions, ToolContract }
