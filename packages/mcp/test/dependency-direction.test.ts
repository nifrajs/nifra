import { describe, expect, test } from "bun:test"

/**
 * The descriptor registry may add exactly one MCP edge - `mcp -> agent` - and never its reverse. This
 * test reads the manifests and the agent source tree directly, so it fails if `@nifrajs/mcp` stops
 * declaring the agent edge as optional, or if `@nifrajs/agent` ever reaches back into the MCP transport.
 */

const repoRoot = `${import.meta.dir}/../../..`

async function readManifest(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(`${repoRoot}/packages/${name}/package.json`).text())
}

function dependencyNames(manifest: Record<string, unknown>, field: string): readonly string[] {
  const value = manifest[field]
  if (value === null || typeof value !== "object" || Array.isArray(value)) return []
  return Object.keys(value)
}

async function importsInto(packageName: string, specifier: string): Promise<boolean> {
  const root = `${repoRoot}/packages/${packageName}`
  const importRe = /\b(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/g
  for await (const relative of new Bun.Glob("src/**/*.ts").scan({ cwd: root })) {
    const source = await Bun.file(`${root}/${relative}`).text()
    for (const match of source.matchAll(importRe)) {
      const found = match[1] ?? ""
      if (found === specifier || found.startsWith(`${specifier}/`)) return true
    }
  }
  return false
}

describe("mcp -> agent dependency direction", () => {
  test("mcp declares the agent edge as an optional peer", async () => {
    const manifest = await readManifest("mcp")
    expect(dependencyNames(manifest, "peerDependencies")).toContain("@nifrajs/agent")
    const meta = manifest.peerDependenciesMeta as Record<string, { optional?: boolean }>
    expect(meta["@nifrajs/agent"]?.optional).toBe(true)
  })

  test("agent never depends on the MCP package", async () => {
    const manifest = await readManifest("agent")
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      expect(dependencyNames(manifest, field)).not.toContain("@nifrajs/mcp")
    }
  })

  test("agent and agent-protocol source never imports the MCP package", async () => {
    expect(await importsInto("agent", "@nifrajs/mcp")).toBe(false)
    expect(await importsInto("agent-protocol", "@nifrajs/mcp")).toBe(false)
  })
})
