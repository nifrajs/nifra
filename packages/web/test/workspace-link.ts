import { mkdirSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Give a temp fixture app the `node_modules/@nifrajs/*` links a real install creates.
 *
 * A fixture app scaffolded into a temp directory has no `node_modules` of its own, so a bare
 * `@nifrajs/…` specifier in generated code can only resolve by walking up into the repo. That happens
 * to work on a machine whose root `node_modules` still carries workspace symlinks from an older
 * install, and not on a clean checkout - where `bun install` links a package's dependencies under
 * `packages/<pkg>/node_modules` and nothing links, say, `@nifrajs/node` (not a dependency of
 * `@nifrajs/web`) anywhere a fixture under `packages/web/test/` can reach.
 *
 * The two bundlers then disagree. `Bun.build` resolves workspace packages natively, so the Bun build
 * tests pass either way; rolldown uses plain node resolution and fails with `Rolldown failed to resolve
 * import "@nifrajs/node"`. The Vite build is not at fault - a real app HAS these in its own
 * `node_modules`, which is exactly the layout this reproduces - so the fixture is what gets fixed.
 *
 * Linking the real package directory is enough on its own: everything those packages import resolves
 * from their own location, which a normal install has already populated.
 */
export function linkWorkspacePackages(appRoot: string, names: readonly string[]): void {
  const packagesDir = resolve(import.meta.dir, "..", "..")
  const scopeDir = join(appRoot, "node_modules", "@nifrajs")
  mkdirSync(scopeDir, { recursive: true })
  for (const name of names) symlinkSync(join(packagesDir, name), join(scopeDir, name), "dir")
}
