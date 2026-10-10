/** The dependency fields of a scaffolded app's manifest that name Nifra's own packages. */
export interface TemplateManifest {
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

const isInternal = (dep: string): boolean =>
  dep.startsWith("@nifrajs/") || dep === "nifra" || dep === "create-nifra"

/**
 * Every internal pin in `manifest` a fresh external install could not resolve against the monorepo's
 * current versions: an unknown package, a `workspace:` range, or a range the current version misses
 * (a caret over a prerelease is the classic one).
 */
export function unsatisfiablePins(
  manifest: TemplateManifest,
  versionByName: ReadonlyMap<string, string>,
): string[] {
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
  const bad: string[] = []
  for (const [dep, range] of Object.entries(deps)) {
    if (!isInternal(dep)) continue
    const current = versionByName.get(dep)
    if (current === undefined) {
      bad.push(`${dep}="${range}" → no such monorepo package`)
      continue
    }
    // The publish rewrite is for real packages, not these static files; an app cannot resolve it.
    if (range.startsWith("workspace:")) {
      bad.push(
        `${dep}="${range}" → workspace: protocol in a template (unresolvable for an external app)`,
      )
      continue
    }
    if (!Bun.semver.satisfies(current, range)) {
      bad.push(
        `${dep}="${range}" does NOT satisfy the current ${current} (caret excludes the prerelease?)`,
      )
    }
  }
  return bad
}
