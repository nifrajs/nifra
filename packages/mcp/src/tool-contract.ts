/** MCP adapter for the public Nifra typed tool contract. */

import { toCatalogEntry } from "@nifrajs/core/tool-catalog"
import { executeTool, type ToolCallOptions, type ToolContract } from "@nifrajs/core/tool-contract"
import type { McpContentBlock, McpTool } from "./protocol.ts"

export interface McpToolContractOptions extends Omit<ToolCallOptions, "signal" | "ledger"> {
  readonly capabilities?: readonly string[]
}

/** Adapt a contract to MCP without creating a second validation or enforcement path. */
export function toMcpTool<Input, Output>(
  tool: ToolContract<Input, Output>,
  options: McpToolContractOptions = {},
): McpTool {
  const entry = toCatalogEntry(tool)
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    annotations: {
      ...(entry.annotations.title === undefined ? {} : { title: entry.annotations.title }),
      ...(entry.annotations.readOnlyHint === undefined
        ? {}
        : { readOnlyHint: entry.annotations.readOnlyHint }),
      ...(entry.annotations.destructiveHint === undefined
        ? {}
        : { destructiveHint: entry.annotations.destructiveHint }),
      ...(entry.annotations.idempotentHint === undefined
        ? { idempotentHint: entry.idempotent }
        : { idempotentHint: entry.annotations.idempotentHint }),
      ...(entry.annotations.openWorldHint === undefined
        ? {}
        : { openWorldHint: entry.annotations.openWorldHint }),
    },
    handler: async (args, context) =>
      mcpResult(await executeTool(tool, args, { ...options, signal: context.signal })),
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
