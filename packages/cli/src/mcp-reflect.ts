/**
 * Backend reflection adapters for the project MCP surface.
 *
 * These functions only translate reflected Nifra declarations into MCP descriptors. They do not know
 * about stdio, HTTP, root trust, or project loading, so the reflection seam is independently testable.
 */

import { type ReflectedRoute, reflectRoutes } from "@nifrajs/core/reflection"
import type {
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpTool,
  McpToolResult,
} from "./mcp-protocol.ts"

type ToolBackend = {
  readonly routes?: () => readonly unknown[]
  readonly fetch: (req: Request) => Promise<Response>
}

/** Extract tools registered via .tool() routes on the Nifra backend. Exported for the test that proves a
 * `server().tool()` route surfaces in `tools/list` and executes through `tools/call`. */
export function extractBackendTools(backend: unknown): McpTool[] {
  const b = backend as ToolBackend | null
  if (!b || typeof b.routes !== "function") return []
  const routes = reflectRoutes(b)

  return routes
    .filter(
      (
        r,
      ): r is ReflectedRoute & {
        schema: NonNullable<ReflectedRoute["schema"]>
        tool: NonNullable<ReflectedRoute["tool"]>
      } => r.schema !== undefined && r.tool !== undefined,
    )
    .map((r) => {
      const toolInfo = r.tool
      const s = r.schema
      return {
        name: toolInfo.name,
        description: toolInfo.description,
        inputSchema: (s.body?.jsonSchema ?? {
          type: "object",
          properties: {},
        }) as McpTool["inputSchema"],
        ...(toolInfo.annotations !== undefined ? { annotations: toolInfo.annotations } : {}),
        handler: async (args): Promise<string | McpToolResult> => {
          const res = await b.fetch(
            new Request(`http://localhost/_nifra/tool/${toolInfo.name}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(args),
            }),
          )
          if (!res.ok) {
            const text = await res.text()
            throw new Error(`Tool execution failed (${res.status}): ${text}`)
          }
          const body: unknown = await res.json()
          if (typeof body === "string") return body
          if (body && typeof body === "object") {
            if ("content" in body || "structuredContent" in body) {
              return body as McpToolResult
            }
            return {
              content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
              structuredContent: body as Record<string, unknown>,
            }
          }
          return String(body)
        },
      }
    })
}

/** A resource declared on the backend via `server().resource()`, seen through `mcpResources()`. */
type ResourceDescriptor = {
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
  readonly read: () => unknown | Promise<unknown>
}
type ResourceBackend = { readonly mcpResources?: () => readonly ResourceDescriptor[] }

/** Extract MCP resources registered via `.resource()` on the Nifra backend. Exported for the surfacing test. */
export function extractBackendResources(backend: unknown): McpResource[] {
  const b = backend as ResourceBackend | null
  if (!b || typeof b.mcpResources !== "function") return []
  let list: readonly ResourceDescriptor[]
  try {
    list = b.mcpResources()
  } catch {
    return []
  }
  return list.map((r) => ({
    uri: r.uri,
    name: r.name,
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
    read: async () => {
      const out = await r.read()
      if (typeof out === "string") return { text: out }
      const o = out as { text: string; mimeType?: string }
      return o.mimeType !== undefined ? { text: o.text, mimeType: o.mimeType } : { text: o.text }
    },
  }))
}

/** A prompt declared on the backend via `server().prompt()`, seen through `mcpPrompts()`. */
type PromptDescriptor = {
  readonly name: string
  readonly description: string
  readonly arguments?: readonly { name: string; description?: string; required?: boolean }[]
  readonly handler: (args: Record<string, string>) => unknown | Promise<unknown>
}
type PromptBackend = { readonly mcpPrompts?: () => readonly PromptDescriptor[] }

/** Extract MCP prompts registered via `.prompt()` on the Nifra backend. Exported for the surfacing test. */
export function extractBackendPrompts(backend: unknown): McpPrompt[] {
  const b = backend as PromptBackend | null
  if (!b || typeof b.mcpPrompts !== "function") return []
  let list: readonly PromptDescriptor[]
  try {
    list = b.mcpPrompts()
  } catch {
    return []
  }
  return list.map((p) => ({
    name: p.name,
    description: p.description,
    ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
    handler: async (args: Record<string, unknown>) =>
      (await p.handler(args as Record<string, string>)) as readonly McpPromptMessage[],
  }))
}

/** Prefix every tool name and resource URI for a named app in a monorepo. */
