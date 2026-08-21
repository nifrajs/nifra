/**
 * Capability-descriptor adapter for MCP tools.
 *
 * An MCP tool is built from the same core {@link ToolContract} the runtime already validates and
 * enforces, so its descriptor is the identical content-free projection the core tool adapter
 * produces - same name, same schema digest, same required capabilities - distinguished only by the
 * `mcp-tool` kind. That parity is what lets a host reason about a capability once, whether it is
 * reached in-process or over the MCP transport.
 *
 * This module is the only place `@nifrajs/mcp` depends on `@nifrajs/agent`, and it is reached solely
 * through the optional `@nifrajs/mcp/agent-descriptor` subpath. The base MCP import path never loads
 * it, so the agent edge stays opt-in and the dependency direction (`mcp -> agent`, never the reverse)
 * is preserved.
 */

import {
  type CapabilityDescriptor,
  descriptorFromTool,
  type IsolationClass,
} from "@nifrajs/agent/registry"
import type { ToolContract } from "@nifrajs/core/tool-contract"

export interface McpDescriptorOptions {
  readonly version?: string
  readonly isolation?: IsolationClass
}

/**
 * Project one MCP-facing tool contract into a `mcp-tool` capability descriptor. The digest is taken
 * over the tool's own input schema, so it matches the core tool descriptor for the same contract.
 */
export function mcpToolDescriptor<Input, Output>(
  tool: ToolContract<Input, Output>,
  options: McpDescriptorOptions = {},
): Promise<CapabilityDescriptor> {
  return descriptorFromTool(tool, {
    kind: "mcp-tool",
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
  })
}

/** Project a set of MCP tool contracts, preserving order. Compose the result into a snapshot to dedupe. */
export function mcpToolDescriptors<Input, Output>(
  tools: readonly ToolContract<Input, Output>[],
  options: McpDescriptorOptions = {},
): Promise<readonly CapabilityDescriptor[]> {
  return Promise.all(tools.map((tool) => mcpToolDescriptor(tool, options)))
}

export type { CapabilityDescriptor, IsolationClass }
