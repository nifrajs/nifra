import { expect, test } from "bun:test"
import {
  bindCommandArgv,
  commandCatalog,
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
    "assure",
    "levels",
    "capabilities",
    "manifest",
    "routes",
    "context",
    "doctor",
    "fix",
    "snapshot",
    "diff",
    "contracts",
    "sync-manifest",
    "sync-routes",
    "prove",
    "replay",
    "port",
  ])
  expect(names).not.toContain("verify")
})

test("CLI help/card projection and MCP descriptors read the same catalog", () => {
  const lines = renderCommandCatalogLines()
  const tools = catalogProjectTools("/fake", async () => {
    throw new Error("not called while describing tools")
  })
  for (const entry of commandCatalog) {
    const spec = findCommandSpec(entry.name)
    expect(spec).toBeDefined()
    expect(lines.some((line) => line.startsWith(`nifra ${entry.name}`))).toBe(true)
    const tool = tools.find((candidate) => candidate.name === commandMcpName(entry.name))
    expect(tool).toBeDefined()
    expect(tool?.description).toBe(entry.summary)
    expect(tool?.inputSchema).toEqual(entry.inputSchema)
    const adapted = toMcpTool(entry, {
      cwd: "/fake",
      loadAppCached: async () => {
        throw new Error("not called while describing tools")
      },
    })
    expect(adapted.name).toBe(tool!.name)
    expect(adapted.inputSchema).toEqual(entry.inputSchema)
  }
})

test("argv binding produces the same typed input shape MCP receives", () => {
  const spec = findCommandSpec("check")!
  expect(bindCommandArgv(spec, ["--lints-only", "--json"])).toMatchObject({
    lintsOnly: true,
    json: true,
  })
  const levels = findCommandSpec("levels")!
  expect(bindCommandArgv(levels, ["--min", "2", "--seed=7"])).toMatchObject({
    min: 2,
    seed: 7,
  })
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
