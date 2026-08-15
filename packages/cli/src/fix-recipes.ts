import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Diagnostic } from "./diagnostics.ts"
import { resolveInsideProject } from "./project-path.ts"
import { resolveWorkspaceLinkedPackage } from "./workspace-link.ts"

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
    const path = await resolveInsideProject(root, diagnostic.file)
    if (path === undefined) return []
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
    if (packageName === undefined) return []
    // Resolved from the NAME through the project's own node_modules chain, not from any path carried
    // by the diagnostic. A workspace link points outside the project by definition - that escape is
    // what makes the artifact able to go stale - so `resolveInsideProject` would reject every package
    // this diagnostic can ever name. `resolveWorkspaceLinkedPackage` states its own rules instead:
    // reachable through the project's install, not a registry tarball, and declaring its own build.
    const linked = await resolveWorkspaceLinkedPackage(root, packageName)
    // Refusing is a result the caller has to see. Returning "changed nothing" made `nifra fix
    // --code NF-C010` a silent no-op on the only findings that produce it.
    if (!linked.ok) throw new Error(`[nifra] cannot rebuild ${packageName}: ${linked.reason}`)
    const proc = Bun.spawn(["bun", "run", linked.buildScript], {
      cwd: linked.dir,
      stdout: "ignore",
      stderr: "pipe",
    })
    const error = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(
        `[nifra] \`bun run ${linked.buildScript}\` failed in ${linked.dir}: ${error.trim() || `exit code ${exitCode}`}`,
      )
    }
    return [diagnostic.evidence?.[1] ?? packageName]
  },
})

/**
 * How many typecheck passes the reserved-segment codemod will run. A nested collision
 * (`/api/delete/then`) only reveals its second site once the first is rewritten, so one pass is not
 * always enough - but each pass is a full `tsc`, so this converges or stops rather than looping.
 */
const RESERVED_SEGMENT_PASSES = 3

registerFixRecipe({
  id: "client.reserved-segment",
  description:
    "Rewrite typed-client call sites broken by a reserved-named route segment to the call spelling.",
  verify: "tsc --noEmit",
  async apply(root) {
    const { parseCollisionSites, resolveTscBin, rewriteFile } = await import(
      "./internal/reserved-segment-codemod.ts"
    )
    const tsconfig = join(root, "tsconfig.json")
    if (!(await Bun.file(tsconfig).exists()))
      throw new Error(
        "[nifra] no tsconfig.json here - the reserved-segment codemod reads the compiler's own list of broken call sites, so it needs a typecheckable project",
      )
    const tscBin = resolveTscBin(root)
    if (tscBin === undefined)
      throw new Error(
        "[nifra] no `typescript` install found from this directory upward - run `bun add -d typescript`, then rerun the fix",
      )

    const changed = new Set<string>()
    const skipped: string[] = []
    for (let pass = 0; pass < RESERVED_SEGMENT_PASSES; pass += 1) {
      const proc = Bun.spawn(["bun", tscBin, "--noEmit", "--pretty", "false", "-p", tsconfig], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      const sites = parseCollisionSites(`${stdout}${stderr}`)
      if (sites.length === 0) break

      const byFile = new Map<string, (typeof sites)[number][]>()
      for (const site of sites) {
        const existing = byFile.get(site.file)
        if (existing === undefined) byFile.set(site.file, [site])
        else existing.push(site)
      }

      let wrote = false
      skipped.length = 0
      for (const [file, fileSites] of byFile) {
        // Resolved through the project boundary: the compiler reports paths from its own rootDir, and
        // a rewrite must never escape the project it was invoked in.
        const path = await resolveInsideProject(root, file)
        if (path === undefined) continue
        const source = await readFile(path, "utf8")
        const result = rewriteFile(source, fileSites)
        for (const site of result.skipped) skipped.push(`${file}:${site.line}:${site.column}`)
        if (result.source === source) continue
        await writeFile(path, result.source, "utf8")
        changed.add(file)
        wrote = true
      }
      // Nothing rewritten this pass means the remaining sites are all shapes the codemod declines to
      // touch. Another `tsc` would report the same list, so stop instead of burning the budget.
      if (!wrote) break
    }

    if (skipped.length > 0) {
      const rewritten =
        changed.size === 0
          ? "no site was rewritten"
          : `rewrote ${changed.size} file${changed.size === 1 ? "" : "s"}`
      throw new Error(
        `[nifra] ${rewritten}; ${skipped.length} reserved-segment site${skipped.length === 1 ? "" : "s"} need${skipped.length === 1 ? "s" : ""} a manual edit (the collision is not reached by a plain \`.segment\` property access there): ${skipped.join(", ")}`,
      )
    }
    return [...changed]
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
