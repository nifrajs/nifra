import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import {
  changedPublicPackageVersions,
  isReleaseBranch,
  type PackageManifest,
  pendingChangesetFiles,
} from "./release-branch.ts"

const isMergeCheck = process.argv.includes("--merge")

const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], { encoding: "utf8" }).trim()

const resolveCommit = (ref: string): string => git(["rev-parse", "--verify", `${ref}^{commit}`])

const parseManifest = (source: string): PackageManifest | undefined => {
  try {
    const value: unknown = JSON.parse(source)
    if (typeof value !== "object" || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.name !== "string" || typeof record.version !== "string") return undefined
    return {
      name: record.name,
      version: record.version,
      private: record.private === true,
    }
  } catch {
    return undefined
  }
}

const readManifest = (ref: string, path: string): PackageManifest | undefined => {
  try {
    return parseManifest(git(["show", `${ref}:${path}`]))
  } catch {
    return undefined
  }
}

const readCurrentManifest = (path: string): PackageManifest | undefined => {
  try {
    return parseManifest(readFileSync(resolve(path), "utf8"))
  } catch {
    return undefined
  }
}

const headRef = process.env.RELEASE_HEAD_SHA?.trim() || process.env.GITHUB_SHA?.trim() || "HEAD"
const head = resolveCommit(headRef)
const base = isMergeCheck
  ? resolveCommit(`${head}^1`)
  : resolveCommit(process.env.GITHUB_BASE_SHA?.trim() || "HEAD~1")

if (!isMergeCheck) {
  const branch = process.env.GITHUB_HEAD_REF?.trim() || git(["branch", "--show-current"])
  if (!isReleaseBranch(branch))
    throw new Error("release:check must run on a branch named release/<name>")
}

const changedPaths = git(["diff", "--name-only", "-z", `${base}...${head}`])
  .split("\0")
  .filter((path) => path.length > 0)
const packagePaths = changedPaths.filter(
  (path) =>
    basename(path) === "package.json" &&
    !path.includes("..") &&
    /^(?:[A-Za-z0-9._-]+\/)+package\.json$/.test(path),
)

const baseManifests: PackageManifest[] = []
const releaseManifests: PackageManifest[] = []
for (const path of packagePaths) {
  const releaseManifest = readCurrentManifest(path)
  const baseManifest = readManifest(base, path)
  if (releaseManifest === undefined || baseManifest === undefined) continue
  baseManifests.push(baseManifest)
  releaseManifests.push(releaseManifest)
}

const changedVersions = changedPublicPackageVersions(baseManifests, releaseManifests)
if (changedVersions.length === 0)
  throw new Error(
    "release:check found no public package version change; run `bun run release:prepare` before opening the release PR",
  )

const changesets = pendingChangesetFiles(readdirSync(".changeset"))
if (changesets.length > 0)
  throw new Error(
    `release:check found unconsumed changesets (${changesets.join(", ")}); run \`bun run release:prepare\` first`,
  )

console.log(`Validated ${changedVersions.length} public package version change(s):`)
for (const change of changedVersions)
  console.log(`- ${change.name}: ${change.baseVersion} -> ${change.releaseVersion}`)
