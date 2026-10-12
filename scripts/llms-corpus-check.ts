import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

export interface DeclaredPackage {
  readonly name: string
  readonly dir: string
  readonly types?: string
}

/**
 * Packages whose built declaration is missing or older than their source. The type corpus reads
 * `dist` declarations, so generating from a stale build would replace `types.json` with whatever an
 * old build exposed. Source-publishing packages keep `types` under `src` and are exempt.
 */
export function staleDeclarations(pkgs: readonly DeclaredPackage[]): string[] {
  const stale: string[] = []
  for (const pkg of pkgs) {
    const types = pkg.types
    if (types === undefined || !types.startsWith("./dist/")) continue
    const declaration = join(pkg.dir, types)
    if (!existsSync(declaration)) {
      stale.push(`${pkg.name}: missing ${types}`)
      continue
    }
    const declarationMs = statSync(declaration).mtimeMs
    let newestSourceMs = 0
    for (const file of new Glob("src/**/*.{ts,tsx,mts,cts}").scanSync(pkg.dir)) {
      try {
        newestSourceMs = Math.max(newestSourceMs, statSync(join(pkg.dir, file)).mtimeMs)
      } catch {
        // An edit can remove a file while the corpus is being gathered; the next run sees the settled tree.
      }
    }
    if (newestSourceMs > declarationMs) stale.push(`${pkg.name}: ${types} is older than src/`)
  }
  return stale
}

/** Whether the committed file at `path` differs from what the generator would write; absent counts. */
export function outputIsStale(path: string, contents: string): boolean {
  return (existsSync(path) ? readFileSync(path, "utf8") : undefined) !== contents
}
