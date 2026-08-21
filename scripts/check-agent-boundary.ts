import { existsSync } from "node:fs"
import { resolve } from "node:path"

const PROTECTED = ["core", "client", "web", "schema"] as const
const FORBIDDEN = [
  "@nifrajs/agent",
  "@nifrajs/agent-app",
  "@nifrajs/agent-protocol",
  "@nifrajs/pi",
  "@nifrajs/coding-agent",
  "@nifrajs/tui",
  "@nifrajs/workbench",
  "apps/workbench",
] as const
const IMPORT_RE = /\b(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/g

/**
 * The Agent App SDK is the presentation-safe public seam: it may depend on the protocol contract
 * and nothing else. A backend, provider, storage, model, or UI-framework edge here would let payload
 * content or a private engine cross into browser-facing code, so any such specifier fails the gate.
 */
const AGENT_APP_ALLOWED_INTERNAL = new Set(["@nifrajs/agent-protocol"])
const AGENT_APP_FORBIDDEN_BARE = [
  "react",
  "react-dom",
  "preact",
  "vue",
  "svelte",
  "solid-js",
  "@tauri-apps",
] as const

function isAgentAppForbidden(specifier: string): boolean {
  if (specifier.startsWith("@nifrajs/"))
    return !AGENT_APP_ALLOWED_INTERNAL.has(specifier.split("/").slice(0, 2).join("/"))
  return AGENT_APP_FORBIDDEN_BARE.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  )
}

/**
 * The descriptor registry adds exactly two edges: `mcp -> agent` and `coding-agent -> agent`. The
 * reverse must never form. `@nifrajs/agent` and `@nifrajs/agent-protocol` sit below the host layer, so
 * a specifier reaching up into the MCP transport or the coding-agent host would invert the direction
 * and pull a host engine into the descriptor contracts. Any such import or dependency fails the gate.
 */
const REVERSE_GUARDED = ["agent", "agent-protocol"] as const
const REVERSE_FORBIDDEN = ["@nifrajs/mcp", "@nifrajs/coding-agent"] as const

function isReverseForbidden(specifier: string): boolean {
  return REVERSE_FORBIDDEN.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

async function findReverseEdgeFailures(root: string): Promise<readonly string[]> {
  const failures: string[] = []
  for (const packageName of REVERSE_GUARDED) {
    const packageRoot = `${root}/packages/${packageName}`
    if (!existsSync(packageRoot)) continue
    for await (const relative of new Bun.Glob("src/**/*").scan({ cwd: packageRoot, dot: false })) {
      if (!/\.(?:ts|tsx|js|jsx)$/.test(relative)) continue
      const path = `${packageRoot}/${relative}`
      const source = await Bun.file(path).text()
      for (const match of source.matchAll(IMPORT_RE)) {
        if (isReverseForbidden(match[1]!))
          failures.push(`${path}: ${packageName} must not import host package ${match[1]}`)
      }
    }
    const manifestPath = `${packageRoot}/package.json`
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ] as const) {
        const dependencies = manifest[field]
        if (
          dependencies === null ||
          typeof dependencies !== "object" ||
          Array.isArray(dependencies)
        )
          continue
        for (const dependency of Object.keys(dependencies))
          if (isReverseForbidden(dependency))
            failures.push(`${manifestPath}: ${packageName} declares host dependency ${dependency}`)
      }
    }
  }
  return failures
}

async function findAgentAppFailures(root: string): Promise<readonly string[]> {
  const failures: string[] = []
  const packageRoot = `${root}/packages/agent-app`
  if (!existsSync(packageRoot)) return failures
  for await (const relative of new Bun.Glob("src/**/*").scan({ cwd: packageRoot, dot: false })) {
    if (!/\.(?:ts|tsx|js|jsx)$/.test(relative)) continue
    const path = `${packageRoot}/${relative}`
    const source = await Bun.file(path).text()
    for (const match of source.matchAll(IMPORT_RE)) {
      if (isAgentAppForbidden(match[1]!))
        failures.push(`${path}: agent-app may only import @nifrajs/agent-protocol, saw ${match[1]}`)
    }
  }
  const manifestPath = `${packageRoot}/package.json`
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      const dependencies = manifest[field]
      if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies))
        continue
      for (const dependency of Object.keys(dependencies))
        if (isAgentAppForbidden(dependency))
          failures.push(`${manifestPath}: agent-app declares forbidden dependency ${dependency}`)
    }
  }
  return failures
}

export async function findAgentBoundaryFailures(
  root = resolve(import.meta.dir, ".."),
): Promise<readonly string[]> {
  const failures: string[] = []
  for (const packageName of PROTECTED) {
    const packageRoot = `${root}/packages/${packageName}`
    if (!existsSync(packageRoot)) continue
    for await (const relative of new Bun.Glob("src/**/*").scan({ cwd: packageRoot, dot: false })) {
      if (!/\.(?:ts|tsx|js|jsx)$/.test(relative)) continue
      const path = `${packageRoot}/${relative}`
      const source = await Bun.file(path).text()
      for (const match of source.matchAll(IMPORT_RE)) {
        if (isForbidden(match[1]!)) failures.push(`${path}: forbidden agent import ${match[1]}`)
      }
    }
    const manifestPath = `${packageRoot}/package.json`
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ] as const) {
        const dependencies = manifest[field]
        if (
          dependencies === null ||
          typeof dependencies !== "object" ||
          Array.isArray(dependencies)
        )
          continue
        for (const dependency of Object.keys(dependencies))
          if (isForbidden(dependency))
            failures.push(`${manifestPath}: forbidden agent dependency ${dependency}`)
      }
    }
  }
  failures.push(...(await findAgentAppFailures(root)))
  failures.push(...(await findReverseEdgeFailures(root)))
  return failures
}

function isForbidden(specifier: string): boolean {
  return FORBIDDEN.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

if (import.meta.main) {
  const failures = await findAgentBoundaryFailures()
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`)
    process.exit(1)
  }
  console.log(
    `✓ agent boundary: ${PROTECTED.length} framework packages are free of agent/Pi/UI imports`,
  )
}
