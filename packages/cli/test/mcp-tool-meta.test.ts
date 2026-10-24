import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { projectTools } from "../src/mcp-exec.ts"
import { PROJECT_TOOL_META } from "../src/mcp-tool-meta.ts"

const tools = projectTools(process.cwd())

test("every project tool says whether it reads, writes or runs code, and describes every input", () => {
  for (const tool of tools) {
    expect({ tool: tool.name, annotations: tool.annotations !== undefined }).toEqual({
      tool: tool.name,
      annotations: true,
    })
    for (const [field, property] of Object.entries(Object(tool.inputSchema.properties ?? {}))) {
      expect({
        tool: tool.name,
        field,
        description: typeof Reflect.get(Object(property), "description"),
      }).toEqual({
        tool: tool.name,
        field,
        description: "string",
      })
    }
  }
})

test("a tool that can write a file or run project code is never marked read-only", () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  for (const name of [
    "nifra_fix",
    "nifra_doctor",
    "nifra_scaffold",
    "nifra_review",
    "nifra_run",
    "nifra_test",
  ]) {
    expect({ name, readOnly: byName.get(name)?.annotations?.readOnlyHint }).toEqual({
      name,
      readOnly: false,
    })
  }
  expect(byName.get("nifra_routes")?.annotations?.readOnlyHint).toBe(true)
  // A stale entry would describe a tool that no longer exists.
  for (const name of Object.keys(PROJECT_TOOL_META)) expect(byName.has(name)).toBe(true)
})

test("the agents docs page lists every tool under the class its annotations declare", () => {
  const page = readFileSync(
    new URL("../../../site/routes/docs/agents.tsx", import.meta.url),
    "utf8",
  )
  const effect = (tool: (typeof tools)[number]): string =>
    tool.annotations?.readOnlyHint === true
      ? "reads"
      : tool.annotations?.openWorldHint === true
        ? "runs project code"
        : "writes files"
  for (const tool of tools) expect(page).toContain(`["${tool.name}", "${effect(tool)}",`)
})
