import { describe, expect, test } from "bun:test"
import { defineTool } from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import { toMcpTool } from "../src/tool-contract.ts"

describe("MCP typed tool adapter", () => {
  test("derives the schema and annotations and uses the core pipeline", async () => {
    let executions = 0
    const tool = defineTool({
      name: "orders.mcp",
      description: "Read an order through MCP.",
      input: t.object({ id: t.string({ minLength: 1 }) }),
      output: t.object({ ok: t.boolean() }),
      capability: "orders.read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      execute: () => {
        executions += 1
        return { ok: true }
      },
    })
    const mcp = toMcpTool(tool, { capabilities: ["orders.read"] })
    expect(mcp.inputSchema).toMatchObject({ type: "object" })
    expect(mcp.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: false })
    const result = await mcp.handler(
      { id: "1" },
      { signal: new AbortController().signal, requestId: "test", reportProgress: () => {} },
    )
    expect(typeof result !== "string" && result.isError === true).toBe(false)
    expect(JSON.stringify(result)).toContain('\\"ok\\":true')
    expect(executions).toBe(1)
  })

  test("returns an in-band failure for missing capability", async () => {
    const tool = defineTool({
      name: "orders.mcp-denied",
      description: "Denied MCP operation.",
      input: t.object({ id: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "orders.write",
      execute: () => ({ ok: true }),
    })
    const result = await toMcpTool(tool).handler(
      { id: "1" },
      { signal: new AbortController().signal, requestId: "test", reportProgress: () => {} },
    )
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain("capability_denied")
  })
})
