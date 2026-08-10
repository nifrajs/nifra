import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Diagnostic } from "./diagnostics.ts"

export interface FixRecipe {
  readonly id: string
  readonly description: string
  apply(root: string, diagnostic: Diagnostic): Promise<readonly string[]>
  readonly verify: string
}

const recipes = new Map<string, FixRecipe>()

export function registerFixRecipe(recipe: FixRecipe): void {
  if (recipes.has(recipe.id)) throw new Error(`duplicate fix recipe: ${recipe.id}`)
  recipes.set(recipe.id, Object.freeze(recipe))
}

export function getFixRecipe(id: string): FixRecipe | undefined {
  return recipes.get(id)
}

export function listFixRecipes(): readonly FixRecipe[] {
  return Object.freeze([...recipes.values()])
}

registerFixRecipe({
  id: "security.timing-safe-equal",
  description: "Replace a direct secret comparison with a length check and timing-safe comparison.",
  verify: "nifra check --lints-only",
  async apply(root, diagnostic) {
    if (diagnostic.file === undefined || diagnostic.line === undefined) return []
    const path = resolve(root, diagnostic.file)
    const lines = (await readFile(path, "utf8")).split("\n")
    const index = diagnostic.line - 1
    const original = lines[index]
    if (original === undefined || original.includes("@nifra-gate-reviewed")) return []
    const comparison = /\b([A-Za-z_$][\w$]*)\s*(===|!==|==|!=)\s*([A-Za-z_$][\w$]*)/.exec(original)
    if (comparison === null) return []
    const left = comparison[1] as string
    const operator = comparison[2] as string
    const right = comparison[3] as string
    const expression = `nifraTimingSafeEqual(${left}, ${right})`
    const replacement = operator === "!==" || operator === "!=" ? `!${expression}` : expression
    lines[index] = original.replace(comparison[0], replacement)
    if (!lines.some((line) => line.includes("function nifraTimingSafeEqual"))) {
      lines.unshift(
        'import { timingSafeEqual } from "node:crypto"',
        "",
        "function nifraTimingSafeEqual(left: string, right: string): boolean {",
        "  const leftBytes = Buffer.from(left)",
        "  const rightBytes = Buffer.from(right)",
        "  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)",
        "}",
        "",
      )
    }
    await writeFile(path, lines.join("\n"), "utf8")
    return [diagnostic.file]
  },
})

registerFixRecipe({
  id: "manifest.sync",
  description: "Regenerate generated server manifests from the current route tree.",
  verify: "nifra check --lints-only",
  async apply(root) {
    const { syncServerManifests } = await import("./sync-manifest.ts")
    const results = await syncServerManifests(root)
    return results.filter((result) => result.changed).map((result) => result.file)
  },
})

registerFixRecipe({
  id: "contracts.snapshot",
  description: "Refresh the opt-in contract lock after reviewing an intentional route change.",
  verify: "nifra contracts check",
  async apply(root) {
    const { snapshotContracts } = await import("./contracts.ts")
    await snapshotContracts(root)
    return ["contracts.lock.json"]
  },
})

registerFixRecipe({
  id: "workspace-dist.rebuild",
  description: "Rebuild the workspace-linked package whose artifact is older than its source.",
  verify: "nifra doctor --json",
  async apply(root, diagnostic) {
    const packageName = diagnostic.evidence?.[0]
    if (packageName === undefined || !/^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(packageName))
      return []
    // The segment regex above admits "." and "..", which would resolve outside node_modules.
    if (packageName.split("/").some((segment) => segment === "." || segment === "..")) return []
    const packageDir = resolve(root, "node_modules", packageName)
    const packageJson = resolve(packageDir, "package.json")
    if (!existsSync(packageJson)) return []
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: packageDir,
      stdout: "ignore",
      stderr: "pipe",
    })
    const error = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error(error.trim() || `build failed for ${packageName}`)
    return [diagnostic.evidence?.[1] ?? packageName]
  },
})

export async function applyDiagnosticRecipe(
  root: string,
  diagnostic: Diagnostic,
): Promise<readonly string[]> {
  const recipeId = diagnostic.fix?.recipe
  if (recipeId === undefined) return []
  const recipe = getFixRecipe(recipeId)
  if (recipe === undefined) return []
  return recipe.apply(root, diagnostic)
}
