import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  expect(byName.get("nifra_check")?.annotations?.readOnlyHint).toBe(true)
  // A stale entry would describe a tool that no longer exists.
  for (const name of Object.keys(PROJECT_TOOL_META)) expect(byName.has(name)).toBe(true)
})

test("a tool marked read-only imports none of the project's code", async () => {
  const root = mkdtempSync(join(tmpdir(), "nifra-readonly-"))
  // Each module notes that it ran; a read-only tool must leave the note unwritten.
  const note = (from: string) =>
    `import { appendFileSync } from "node:fs"\nappendFileSync(new URL("${from}marker", import.meta.url), "ran\\n")\n`
  try {
    mkdirSync(join(root, "backend"))
    mkdirSync(join(root, "routes"))
    writeFileSync(join(root, "package.json"), '{ "name": "probe", "type": "module" }')
    writeFileSync(join(root, "nifra.config.ts"), `${note("./")}export default {}\n`)
    writeFileSync(join(root, "backend", "app.ts"), `${note("../")}export const backend = {}\n`)
    writeFileSync(
      join(root, "routes", "index.backend.ts"),
      `${note("../")}export const loader = () => ({})\n`,
    )
    const readers = projectTools(root).filter((tool) => tool.annotations?.readOnlyHint === true)
    expect(readers.length).toBeGreaterThan(0)
    for (const tool of readers) {
      const context = {
        signal: new AbortController().signal,
        requestId: 1,
        reportProgress: () => {},
      }
      await tool.handler({}, context).catch(() => undefined)
      expect({ tool: tool.name, imported: existsSync(join(root, "marker")) }).toEqual({
        tool: tool.name,
        imported: false,
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
