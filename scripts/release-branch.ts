export interface PackageManifest {
  name: string
  version: string
  private?: boolean
}

const RELEASE_BRANCH_PATTERN = /^release\/[a-z0-9][a-z0-9._-]{0,63}$/

export const isReleaseBranch = (branch: string): boolean =>
  RELEASE_BRANCH_PATTERN.test(branch) && !branch.includes("..") && !branch.endsWith(".")

export const pendingChangesetFiles = (entries: readonly string[]): string[] =>
  entries.filter((entry) => entry.endsWith(".md") && entry !== "README.md").sort()

export const changedPublicPackageVersions = (
  base: readonly PackageManifest[],
  release: readonly PackageManifest[],
): Array<{ name: string; baseVersion: string; releaseVersion: string }> => {
  const baseByName = new Map(base.map((manifest) => [manifest.name, manifest]))
  return release.flatMap((manifest) => {
    if (manifest.private === true) return []
    const previous = baseByName.get(manifest.name)
    if (previous === undefined || previous.version === manifest.version) return []
    return [
      { name: manifest.name, baseVersion: previous.version, releaseVersion: manifest.version },
    ]
  })
}
