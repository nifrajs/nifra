import {
  compareSemverSpec,
  groupPinVersions,
  installedGroupPackages,
  type LinkedGroupInstall,
} from "./upgrade.ts"

/** One version of the fixed release group, and where the workspace carries it. */
export interface GroupVersion {
  readonly version: string
  readonly sources: readonly string[]
}

/**
 * More than one version of the fixed release group (`@nifrajs/*`, `nifra`, `create-nifra`) in one
 * workspace. Read only: package.json pins, installed packages (followed to their real location, so a
 * linked repo reports its own version) and the running CLI. Nothing is spawned.
 */
export interface VersionDrift {
  /** Oldest first. */
  readonly versions: readonly GroupVersion[]
  readonly highest: string
  /** `nifra upgrade` edits the workspace only; these are listed, never edited. */
  readonly linkedOutside: readonly LinkedGroupInstall[]
}

export function collectVersionDrift(cwd: string, cliVersion?: string): VersionDrift | undefined {
  const sources = new Map<string, string[]>()
  const add = (version: string, source: string): void => {
    const list = sources.get(version) ?? []
    list.push(source)
    sources.set(version, list)
  }
  for (const [version, files] of groupPinVersions(cwd)) {
    for (const file of files) add(version, `pinned in ${file}`)
  }
  const linkedOutside: LinkedGroupInstall[] = []
  for (const { package: name, path, version, inside } of installedGroupPackages(cwd)) {
    add(version, `installed ${name}${inside ? "" : ` (linked from ${path})`}`)
    if (!inside) linkedOutside.push({ package: name, path, version })
  }
  if (cliVersion !== undefined) add(cliVersion, "the running nifra CLI")
  if (sources.size < 2) return undefined
  const versions = [...sources]
    .sort(([a], [b]) => compareSemverSpec(a, b))
    .map(([version, list]) => ({ version, sources: list }))
  return {
    versions,
    highest: versions[versions.length - 1]!.version,
    linkedOutside,
  }
}

/** The advisory both `nifra doctor` and `nifra check` print. */
export function versionDriftMessage(drift: VersionDrift): string {
  const listed = drift.versions
    .map(
      ({ version, sources }) =>
        `${version} (${sources.slice(0, 3).join("; ")}${sources.length > 3 ? `; and ${sources.length - 3} more` : ""})`,
    )
    .join(", ")
  const linked =
    drift.linkedOutside.length === 0
      ? ""
      : ` It does not edit ${drift.linkedOutside.map((entry) => `${entry.package} ${entry.version} at ${entry.path}`).join(", ")}, linked from outside the workspace root; upgrade that repository on its own.`
  return `mixed nifra versions in this workspace: ${listed}. Run \`nifra upgrade ${drift.highest}\` (it runs each release's migration steps, then re-pins).${linked}`
}
