/**
 * Notes for the GitHub release of one version: each published package's CHANGELOG section for it,
 * without the dependency bumps that the fixed version group writes into every package's section. A
 * package left with no change of its own is not listed.
 *
 *   bun scripts/release-notes.ts            # notes for the version the packages are at
 *   bun scripts/release-notes.ts --version  # that version alone
 *   bun scripts/release-notes.ts 4.0.0      # notes for an earlier version, from the same CHANGELOGs
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeUnitOrder } from "./code-unit-order.ts"
import { publishedPackages } from "./public-package-manifest.ts"

const ROOT = join(import.meta.dir, "..")

// GitHub refuses a release body over 125,000 characters; a string's length never undercounts them.
export const NOTES_LIMIT = 120_000

/** The body under `## <version>` in a CHANGELOG, up to the next version heading. */
export const versionSection = (changelog: string, version: string): string | undefined => {
  const lines = changelog.replaceAll("\r\n", "\n").split("\n")
  const start = lines.indexOf(`## ${version}`)
  if (start === -1) return undefined
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n")
}

// `- Updated dependencies [...]`, and a `- name@1.2.3` bullet, alone or listed under an entry.
const DEPENDENCY_LINE =
  /^(?:- Updated dependencies\b.*|\s*- (?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+\S*)$/

/** A section without its dependency bumps, or undefined when no entry of the package's own is left. */
export const ownChanges = (section: string): string | undefined => {
  const lines = section.split("\n").filter((line) => !DEPENDENCY_LINE.test(line))
  // A change-type heading whose entries were all dependency bumps goes with them.
  const kept = lines.filter((line, index) => {
    if (!line.startsWith("### ")) return true
    const next = lines.findIndex(
      (later, at) => at > index && (later.startsWith("### ") || later.startsWith("- ")),
    )
    return next !== -1 && lines[next]?.startsWith("- ") === true
  })
  const text = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return /^- /m.test(text) ? text : undefined
}

/** Each entry cut to its first paragraph. */
export const firstParagraphs = (changes: string): string => {
  let cut = false
  return changes
    .split("\n")
    .filter((line) => {
      if (line.startsWith("- ") || line.startsWith("### ")) cut = false
      else if (line === "" && !cut) {
        // The blank line before the next entry or heading stays; the rest of this entry goes.
        cut = true
        return true
      }
      return !cut
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export interface PackageChangelog {
  readonly name: string
  readonly changelog: string
  /** Where the full CHANGELOG reads, linked when the notes have to be shortened. */
  readonly url: string
}

export const releaseNotes = (version: string, packages: readonly PackageChangelog[]): string => {
  const changed = [...packages]
    .sort((a, b) => codeUnitOrder(a.name, b.name))
    .flatMap((pkg) => {
      const own = ownChanges(versionSection(pkg.changelog, version) ?? "")
      return own === undefined ? [] : [{ ...pkg, own }]
    })
  const lead = `All public packages are released together at ${version}. These are the ones with changes of their own.`
  const full = [lead, ...changed.map((pkg) => `## ${pkg.name}\n\n${pkg.own}`)].join("\n\n")
  if (full.length <= NOTES_LIMIT) return `${full}\n`

  const brief = [
    `${lead} Each entry is cut to its first paragraph; a package's heading links to its full CHANGELOG.`,
  ]
  const unlisted: string[] = []
  for (const pkg of changed) {
    const section = `## [${pkg.name}](${pkg.url})\n\n${firstParagraphs(pkg.own)}`
    // Room is kept for the closing list of the packages that do not fit.
    if (unlisted.length === 0 && [...brief, section].join("\n\n").length <= NOTES_LIMIT - 10_000)
      brief.push(section)
    else unlisted.push(`[${pkg.name}](${pkg.url})`)
  }
  if (unlisted.length > 0) brief.push(`Also changed, in their CHANGELOGs: ${unlisted.join(", ")}.`)
  return `${brief.join("\n\n")}\n`
}

/** The version of the fixed group, which every published package shares. */
export const groupVersion = (root: string = ROOT): string => {
  const versions = new Set(publishedPackages(root).map((pkg) => pkg.version))
  const [version] = versions
  if (versions.size !== 1 || version === undefined)
    throw new Error(`published packages disagree on their version: ${[...versions].join(", ")}`)
  return version
}

if (import.meta.main) {
  const [arg] = process.argv.slice(2)
  if (arg === "--version") console.log(groupVersion())
  else {
    const version = arg ?? groupVersion()
    // GitHub's anchor for the `## 4.0.0` heading is `#400`.
    const anchor = version.replace(/[^\w-]/g, "")
    process.stdout.write(
      releaseNotes(
        version,
        publishedPackages(ROOT).map((pkg) => ({
          name: pkg.name,
          changelog: readFileSync(join(ROOT, "packages", pkg.dir, "CHANGELOG.md"), "utf8"),
          url: `https://github.com/nifrajs/nifra/blob/v${version}/packages/${pkg.dir}/CHANGELOG.md#${anchor}`,
        })),
      ),
    )
  }
}
