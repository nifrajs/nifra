import { bunLockDir, staleLinkLocks } from "./lock-links.ts"
import {
  compareSemverSpec,
  groupDeclaredNames,
  groupDependenciesAt,
  groupPinVersions,
  installedGroupPackages,
  installRootOf,
  isFixedGroup,
  type LinkedGroupInstall,
  linkedRepositories,
  specVersion,
} from "./upgrade.ts"

/** One version of the fixed release group, and where the workspace carries it. */
export interface GroupVersion {
  readonly version: string
  readonly sources: readonly string[]
}

/**
 * More than one version of the fixed release group (`@nifrajs/*`, `nifra`, `create-nifra`) in one
 * workspace. Read only: package.json pins, installed packages (followed to their real location, so a
 * linked repo reports its own version), the copies a `link:`/`file:` repository installs for itself,
 * and the running CLI. Nothing is spawned.
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
  const installs = installedGroupPackages(cwd)
  // An install nothing declares, such as one an older install left behind, loads nowhere, and no
  // upgrade re-pins it: counting it would report drift that never clears.
  const declared = new Set(groupDeclaredNames(cwd))
  for (const { path } of installs) for (const name of groupDependenciesAt(path)) declared.add(name)
  for (const { package: name, path, version, inside } of installs) {
    if (!declared.has(name)) continue
    add(version, `installed ${name}${inside ? "" : ` (linked from ${path})`}`)
    if (!inside) linkedOutside.push({ package: name, path, version })
  }
  // A repository linked in from outside loads nifra from its own node_modules, which the scan above
  // never reads: two live-linked repos can each pin one version and still run two.
  for (const repo of linkedRepositories(cwd)) {
    for (const install of repo.installs) {
      add(
        install.version,
        `installed ${install.package} by ${repo.package} (linked from ${repo.path}), which loads its own copy`,
      )
      linkedOutside.push(install)
    }
  }
  if (cliVersion !== undefined) add(cliVersion, "the running nifra CLI")
  // A linked package's stale recorded pin is installed under that package, where the scan of
  // node_modules above never looks; only an exact pin names the version that copy has.
  const lockDir = bunLockDir(cwd)
  for (const entry of lockDir === undefined ? [] : staleLinkLocks(lockDir)) {
    for (const { name, recorded } of entry.changes) {
      if (recorded === undefined || !isFixedGroup(name) || specVersion(recorded) !== recorded)
        continue
      add(
        recorded,
        `recorded for ${entry.package} in bun.lock, which Bun never refreshes (NF-D003)`,
      )
    }
  }
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

/** Linked installs, one phrase per install and version: a linked repository brings its whole group. */
function linkedGroups(installs: readonly LinkedGroupInstall[]): string[] {
  const groups = new Map<string, LinkedGroupInstall[]>()
  for (const install of installs) {
    const key = `${installRootOf(install.path)}\0${install.version}`
    groups.set(key, [...(groups.get(key) ?? []), install])
  }
  return [...groups.values()].map((group) => {
    const [first] = group
    if (first === undefined) return ""
    if (group.length === 1) return `${first.package} ${first.version} at ${first.path}`
    const names = group.map((install) => install.package).sort()
    const listed =
      names.length > 3
        ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
        : names.join(", ")
    return `${group.length} packages at ${first.version} under ${installRootOf(first.path)} (${listed})`
  })
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
      : ` It does not edit ${linkedGroups(drift.linkedOutside).join(", ")}, linked from outside the workspace root; upgrade that repository on its own.`
  return `mixed nifra versions in this workspace: ${listed}. Run \`nifra upgrade ${drift.highest}\` (it runs each release's migration steps, then re-pins).${linked}`
}
