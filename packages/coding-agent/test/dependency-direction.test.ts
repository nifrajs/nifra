import { describe, expect, test } from "bun:test"

/**
 * The descriptor registry may add exactly one coding-agent edge - `coding-agent -> agent` - and never
 * its reverse. This reads the manifests and the agent source tree directly, so it fails if the
 * coding-agent host drops the agent edge, or if `@nifrajs/agent` ever reaches into the coding-agent host.
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

describe("coding-agent -> agent dependency direction", () => {
  test("coding-agent declares the agent edge", async () => {
    const manifest = await readManifest("coding-agent")
    expect(dependencyNames(manifest, "dependencies")).toContain("@nifrajs/agent")
  })

  test("agent never depends on the coding-agent package", async () => {
    const manifest = await readManifest("agent")
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      expect(dependencyNames(manifest, field)).not.toContain("@nifrajs/coding-agent")
    }
  })

  test("agent and agent-protocol source never imports the coding-agent package", async () => {
    expect(await importsInto("agent", "@nifrajs/coding-agent")).toBe(false)
    expect(await importsInto("agent-protocol", "@nifrajs/coding-agent")).toBe(false)
  })
})
