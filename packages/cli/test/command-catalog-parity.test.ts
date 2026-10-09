import { expect, test } from "bun:test"
import {
  bindCommandArgv,
  commandCatalog,
  commandMcpInputSchema,
  commandMcpName,
  commandSpecs,
  envelopeCommandOutput,
  findCommandSpec,
  parseCommandOutput,
  renderCommandCatalogLines,
  toCommandCatalogEntry,
} from "../src/command-catalog.ts"
import { catalogProjectTools, toMcpTool } from "../src/mcp.ts"

test("the stable catalog is the public command allowlist", () => {
  const names = commandCatalog.map((entry) => entry.name)
  expect(names).toEqual([
    "check",
    "review",
    "assure",
    "levels",
    "capabilities",
    "manifest",
    "routes",
    "context",
    "openapi",
    "doctor",
    "fix",
    "migrate",
    "target",
    "types",
    "schemas",
    "snapshot",
    "diff",
    "contracts",
    "sync-manifest",
    "sync-routes",
    "prove",
    "replay",
    "smoke",
    "port",
    "i18n",
    "errors",
    "logs",
    "cdn-check",
    "db-schema",
    "db-query",
    "db-role",
    "db-audit",
  ])
  expect(names).not.toContain("verify")
})

test("CLI help/card projection and MCP descriptors read the same catalog", () => {
  const lines = renderCommandCatalogLines()
  const refuse = async (): Promise<never> => {
    throw new Error("not called while describing tools")
  }
  const tools = catalogProjectTools("/fake", Object.assign(refuse, { backend: refuse }))
  for (const entry of commandCatalog) {
    const spec = findCommandSpec(entry.name)
    expect(spec).toBeDefined()
    expect(lines.some((line) => line.startsWith(`nifra ${entry.name}`))).toBe(true)
    const tool = tools.find((candidate) => candidate.name === commandMcpName(entry.name))
    if (entry.transports.includes("mcp")) {
      expect(tool).toBeDefined()
      expect(tool?.description).toBe(entry.summary)
      expect(tool?.inputSchema).toEqual(commandMcpInputSchema(entry))
      const adapted = toMcpTool(entry, {
        cwd: "/fake",
        loadAppCached: Object.assign(refuse, { backend: refuse }),
      })
      expect(adapted.name).toBe(tool!.name)
      expect(adapted.inputSchema).toEqual(commandMcpInputSchema(entry))
    } else {
      expect(tool).toBeUndefined()
    }
  }
})

test("an MCP routes call cannot compare against a hook report outside the project", async () => {
  const refuse = async (): Promise<never> => {
    throw new Error("the app is not loaded for a refused path")
  }
  const entry = commandCatalog.find((candidate) => candidate.name === "routes")
  if (entry === undefined) throw new Error("no routes entry")
  const tool = toMcpTool(entry, {
    cwd: process.cwd(),
    loadAppCached: Object.assign(refuse, { backend: refuse }),
  })
  const signal = new AbortController().signal
  const context = { signal, requestId: null, reportProgress() {} }
  const reply = await tool.handler({ hooks: true, since: "../../etc/hosts" }, context)
  expect(JSON.parse(String(reply))).toEqual({
    ok: false,
    error: "since must be a relative path inside the selected project directory: ../../etc/hosts",
  })
})

test("argv binding produces the same typed input shape MCP receives", () => {
  const spec = findCommandSpec("check")!
  expect(bindCommandArgv(spec, ["--lints-only", "--json"])).toMatchObject({
    lintsOnly: true,
    json: true,
  })
  expect(bindCommandArgv(spec, ["--sarif"])).toMatchObject({ sarif: true })
  const levels = findCommandSpec("levels")!
  expect(bindCommandArgv(levels, ["--min", "2", "--seed=7"])).toMatchObject({
    min: 2,
    seed: 7,
  })
  const migrate = findCommandSpec("migrate")!
  expect(
    bindCommandArgv(migrate, ["--from", "tailwind", "--to", "stylex", "--write"]),
  ).toMatchObject({ from: "tailwind", to: "stylex", write: true })
})

test("check SARIF is a projection of the structured diagnostics output", () => {
  const spec = findCommandSpec("check")!
  const input = spec.input.parse({ sarif: true })
  const result = {
    ok: false,
    typecheck: "pass" as const,
    diagnostics: [],
    structuredDiagnostics: [{ code: "NF-X001", severity: "error" as const, message: "review me" }],
  }
  expect(spec.json?.(result, input)).toMatchObject({
    version: "2.1.0",
    runs: [{ results: [{ ruleId: "NF-X001", message: { text: "review me" } }] }],
  })
  expect(spec.render(result, input).join("\n")).toContain('"ruleId": "NF-X001"')
})

test("catalog projections are frozen and output readers tolerate the versioned envelope", () => {
  const spec = commandSpecs[0]
  const entry = toCommandCatalogEntry(spec)
  expect(Object.isFrozen(entry)).toBe(true)
  expect(Object.isFrozen(entry.inputSchema)).toBe(true)
  const value = { ok: true, typecheck: "pass" as const, diagnostics: [] }
  expect(parseCommandOutput(spec, envelopeCommandOutput(spec, value))).toEqual(value)
  expect(parseCommandOutput(spec, value)).toEqual(value)
})
