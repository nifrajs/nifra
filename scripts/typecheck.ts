#!/usr/bin/env bun
/**
 * Type-check every project in the workspace.
 *
 * The root tsconfig checks the DOM-free corpus - core, node, and ~35 packages - in one pass, resolving
 * every `@nifrajs/*` import to source through `paths`. The DOM/JSX packages (react/preact/svelte/vue/
 * solid adapters, islets, island-trigger) are excluded from that program because they need a different
 * `lib`/`jsx`, so each carries its own `tsconfig.json` and has to be checked on its own.
 *
 * That list used to live inline in a ten-command `package.json` script. A new DOM package that added its
 * own tsconfig but was never appended to the chain would simply never be type-checked, and nothing would
 * say so. The list lives here now, and {@link uncoveredTypecheckConfigs} - asserted by typecheck.test.ts
 * and re-checked before every run below - fails the moment a package tsconfig is missing from it.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/**
 * Every project `tsc --noEmit` runs against, in order: the root corpus first, then each DOM/JSX package's
 * own checker. Kept in sync with the on-disk package tsconfigs by {@link uncoveredTypecheckConfigs}.
 */
export const TYPECHECK_PROJECTS: readonly string[] = [
  "tsconfig.json",
  "packages/web/tsconfig.json",
  "packages/web-solid/tsconfig.json",
  "packages/web-react/tsconfig.json",
  "packages/web-vue/tsconfig.json",
  "packages/web-preact/tsconfig.json",
  "packages/web-svelte/tsconfig.json",
  "packages/web-vanilla/tsconfig.json",
  "packages/islets/tsconfig.json",
  "packages/island-trigger/tsconfig.json",
]

/**
 * Plain `packages/<name>/tsconfig.json` files - a DOM/JSX package's own checker. The `.build.json` emit
 * configs are deliberately not here: they emit `dist/` and are not a type-check gate.
 */
export function packageTypecheckConfigs(): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const rel = `packages/${entry.name}/tsconfig.json`
    const abs = join(ROOT, rel)
    if (existsSync(abs) && statSync(abs).isFile()) found.push(rel)
  }
  return found.sort()
}

/** Package tsconfigs that exist on disk but are absent from {@link TYPECHECK_PROJECTS} - the gate's blind spots. */
export function uncoveredTypecheckConfigs(): readonly string[] {
  const covered = new Set(TYPECHECK_PROJECTS)
  return packageTypecheckConfigs().filter((config) => !covered.has(config))
}

if (import.meta.main) {
  const uncovered = uncoveredTypecheckConfigs()
  if (uncovered.length > 0) {
    console.error(
      `✗ package tsconfig(s) not in the typecheck gate: ${uncovered.join(", ")}\n` +
        "  add each to TYPECHECK_PROJECTS in scripts/typecheck.ts (or delete the tsconfig if the package is covered by the root program).",
    )
    process.exit(1)
  }
  const tsc = Bun.which("tsc") ?? join(ROOT, "node_modules/.bin/tsc")
  for (const project of TYPECHECK_PROJECTS) {
    const result = Bun.spawnSync([tsc, "--noEmit", "-p", project], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    })
    if (!result.success) process.exit(result.exitCode ?? 1)
  }
  console.log(`✓ typecheck passed (${TYPECHECK_PROJECTS.length} projects)`)
}
