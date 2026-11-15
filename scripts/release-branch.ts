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

export const releaseCheckBaseRef = (
  mergeCheck: boolean,
  releaseBaseSha: string | undefined,
  githubBaseSha: string | undefined,
): string => {
  if (!mergeCheck) return githubBaseSha?.trim() || "HEAD~1"
  const baseSha = releaseBaseSha?.trim()
  if (baseSha === undefined || !/^[0-9a-f]{40}$/i.test(baseSha))
    throw new Error("release:check --merge requires RELEASE_BASE_SHA to be a full commit SHA")
  return baseSha
}

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

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  status: number
}>

/** Whether npm knows the package at all; any answer but 200 or 404 is an error, not a verdict. */
export const registryHasPackage = async (name: string, fetchImpl: FetchLike): Promise<boolean> => {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}`
  const headers = { accept: "application/vnd.npm.install-v1+json" }
  let status = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    status = (await fetchImpl(url, { headers })).status
    if (status === 200) return true
    if (status === 404) return false
  }
  throw new Error(`npm answered ${status} for ${name}`)
}

/** Released packages npm has never seen: trusted publishing cannot create them. */
export const packagesMissingFromRegistry = async (
  names: readonly string[],
  exists: (name: string) => Promise<boolean>,
): Promise<string[]> => {
  const known = await Promise.all(names.map(exists))
  return names.filter((_, index) => !known[index]).sort()
}
