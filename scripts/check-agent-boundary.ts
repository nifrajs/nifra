import { existsSync } from "node:fs"
import { resolve } from "node:path"

const PROTECTED = ["core", "client", "web", "schema"] as const
const FORBIDDEN = [
  "@nifrajs/agent",
  "@nifrajs/agent-protocol",
  "@nifrajs/pi",
  "@nifrajs/coding-agent",
  "@nifrajs/tui",
  "@nifrajs/workbench",
  "apps/workbench",
] as const
const IMPORT_RE = /\b(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/g

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
