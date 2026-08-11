/** Descriptive projections of typed tool contracts for model and transport catalogs. */

import {
  type ToolAnnotations,
  type ToolApprovalPolicy,
  type ToolContract,
  type ToolSensitivity,
  toolInputJsonSchema,
} from "./tool-contract.ts"

/**
 * A read-only, transport-neutral view of a tool contract.
 *
 * This module is descriptive only. It never validates input, checks capabilities, requests approval,
 * reserves idempotency, consumes cost, or executes the tool. Those policies stay in `executeTool`.
 */
export interface ToolCatalogEntry {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly capability: string
  readonly sensitivity: ToolSensitivity
  readonly approval: ToolApprovalPolicy
  readonly idempotent: boolean
  readonly annotations: ToolAnnotations
}

/** Build the single descriptive projection shared by agent, MCP, and test adapters. */
export function toCatalogEntry<Input, Output>(tool: ToolContract<Input, Output>): ToolCatalogEntry {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: Object.freeze({ ...toolInputJsonSchema(tool) }),
    capability: tool.capability,
    sensitivity: tool.sensitivity,
    approval: tool.approval,
    idempotent: tool.idempotency !== undefined,
    annotations: tool.annotations,
  })
}
