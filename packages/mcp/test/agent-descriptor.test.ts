import { describe, expect, test } from "bun:test"
import { descriptorFromTool } from "@nifrajs/agent/registry"
import { defineTool } from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import { mcpToolDescriptor, mcpToolDescriptors } from "../src/agent-descriptor.ts"

function sampleTool(name = "search") {
  return defineTool({
    name,
    description: "search the index",
    input: t.object({ query: t.string() }),
    output: t.object({ hits: t.number() }),
    capability: "network.request",
    execute: async () => ({ hits: 0 }),
  })
}

describe("mcpToolDescriptor", () => {
  test("projects an MCP tool contract as the mcp-tool kind", async () => {
    const descriptor = await mcpToolDescriptor(sampleTool())
    expect(descriptor.kind).toBe("mcp-tool")
    expect(descriptor.name).toBe("search")
    expect(descriptor.requiredCapabilities).toEqual(["network.request"])
    expect(JSON.stringify(descriptor)).not.toContain("search the index")
  })

  test("matches the core tool descriptor on name, digest, and capabilities", async () => {
    const tool = sampleTool()
    const core = await descriptorFromTool(tool)
    const mcp = await mcpToolDescriptor(tool)
    expect(mcp.name).toBe(core.name)
    expect(mcp.schemaDigest).toBe(core.schemaDigest)
    expect(mcp.requiredCapabilities).toEqual(core.requiredCapabilities)
    expect(mcp.kind).not.toBe(core.kind)
  })

  test("projects a set preserving order", async () => {
    const descriptors = await mcpToolDescriptors([sampleTool("a"), sampleTool("b")])
    expect(descriptors.map((d) => d.name)).toEqual(["a", "b"])
    expect(descriptors.every((d) => d.kind === "mcp-tool")).toBe(true)
  })
})
