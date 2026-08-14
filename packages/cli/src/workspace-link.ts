/**
 * Resolving a WORKSPACE-LINKED dependency back to the directory it really lives in.
 *
 * A workspace link is the one install whose realpath deliberately leaves the project: `link:` and
 * `workspaces` entries point at a source checkout, routinely in a sibling repository. That is exactly
 * what makes such a package able to go stale (its `dist/` is nobody's build step) and exactly what a
 * project-contained path check rejects - so the rebuild has to resolve the escape on purpose, under
 * its own rules, rather than reuse `resolveInsideProject`.
 *
 * The rules that keep it safe:
 *   - the path is never taken from a diagnostic; it is re-derived from the package NAME by walking the
 *     project's own `node_modules` chain, so only a symlink the package manager already created can be
 *     reached, and only a package the project actually declares;
 *   - a copy that resolves INSIDE `node_modules` is a registry tarball - immutable, never stale, and
 *     never rebuilt;
 *   - the package must declare the build script itself. nifra runs the project's own script, never a
 *     command of its own composition, and never through a shell.
 */

import { sep } from "node:path"
import { resolvedInstalledCopy } from "@nifrajs/web/internal/parity"

/** The one script name a rebuild will run. Guessing among `prepare`/`compile`/`build:*` would risk
 * running something that is not the build at all; a package that names it differently is reported as
 * un-automatable instead. */
const BUILD_SCRIPT = "build"

/** A package name npm would accept, with no path segment that could climb out of `node_modules`. */
const PACKAGE_NAME = /^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/

export function isPackageName(value: string): boolean {
  return PACKAGE_NAME.test(value) && !value.split("/").some((part) => part === "." || part === "..")
}

/** The package's own build script name, or `undefined` when it declares none. */
export function buildScriptName(meta: Record<string, unknown> | undefined): string | undefined {
  const scripts = meta?.scripts
  if (typeof scripts !== "object" || scripts === null) return undefined
  const script = (scripts as Record<string, unknown>)[BUILD_SCRIPT]
  return typeof script === "string" && script.trim().length > 0 ? BUILD_SCRIPT : undefined
}

export type WorkspaceLinkResolution =
  | { readonly ok: true; readonly dir: string; readonly buildScript: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve `name` to the workspace-linked checkout the project loads it from, refusing with a stated
 * reason rather than resolving to nothing. The upward walk is unbounded on purpose: it has to reach the
 * same hoisted copy the staleness scan found, which in a monorepo sits above the package being checked.
 * It only ever inspects `node_modules/<name>` directories, so it cannot wander into an arbitrary path.
 */
export async function resolveWorkspaceLinkedPackage(
  cwd: string,
  name: string,
): Promise<WorkspaceLinkResolution> {
  if (!isPackageName(name)) return { ok: false, reason: `not a package name: ${name}` }
  // Boundary "" and the `node_modules` refusal below mirror `collectStaleWorkspaceDists` exactly, so
  // the rebuild always lands on the same copy the staleness scan flagged.
  const copy = await resolvedInstalledCopy(cwd, "", name)
  if (copy === undefined) return { ok: false, reason: `${name} is not installed under ${cwd}` }
  if (copy.path.includes(`${sep}node_modules${sep}`)) {
    return {
      ok: false,
      reason: `${name} resolves to a registry install (${copy.path}), which cannot be stale or rebuilt`,
    }
  }
  const meta = (await Bun.file(`${copy.path}${sep}package.json`)
    .json()
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (meta === undefined) return { ok: false, reason: `${copy.path} has no readable package.json` }
  const buildScript = buildScriptName(meta)
  if (buildScript === undefined) {
    return {
      ok: false,
      reason: `${name} declares no "${BUILD_SCRIPT}" script in ${copy.path}/package.json, so its artifact cannot be rebuilt automatically - build it the way that package expects`,
    }
  }
  return { ok: true, dir: copy.path, buildScript }
}
