import type { StandardSchemaV1 } from "../schema/standard.ts"
import type { Context, RouteSchema } from "./context.ts"
import type {
  McpPromptDescriptor,
  McpResourceDescriptor,
  PromptArgument,
  RouteDescriptor,
  ToolAnnotations,
} from "./server-types.ts"

export interface McpToolConfig {
  readonly description: string
  readonly input: StandardSchemaV1
  readonly output?: StandardSchemaV1
  readonly annotations?: ToolAnnotations
}

export interface McpToolPlan {
  readonly path: string
  readonly schema: RouteSchema
  readonly run: (context: Context) => unknown
  readonly descriptor: NonNullable<RouteDescriptor["tool"]>
}

export interface McpRuntime {
  tool(
    name: string,
    config: McpToolConfig,
    handler: (input: unknown, context: Context) => unknown,
  ): McpToolPlan
  resource(
    uri: string,
    config: { readonly name: string; readonly description?: string; readonly mimeType?: string },
    read: McpResourceDescriptor["read"],
  ): McpResourceDescriptor
  prompt(
    name: string,
    config: { readonly description: string; readonly arguments?: readonly PromptArgument[] },
    handler: McpPromptDescriptor["handler"],
  ): McpPromptDescriptor
}
