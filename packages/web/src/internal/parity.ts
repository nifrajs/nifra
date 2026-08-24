/**
 * Shared identity and development/production parity facts.
 *
 * The CLI doctor and the web pipelines must answer the same question: will identity-sensitive
 * modules and emitted app surfaces resolve to one coherent graph? This internal seam owns path and
 * manifest normalization so those callers cannot quietly grow separate rules.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { lstat, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  matchesSingleCopyDeclaration,
  readSingleCopyDeclaration,
  readSingleCopyRegistration,
  SINGLE_COPY_REGISTER_SPECIFIER,
  type SingleCopyRegistration,
} from "@nifrajs/core/single-copy"
import { discoverRoutes } from "../fs.ts"
import { isIdentitySensitivePackage } from "./identity-policy.ts"

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const
const MAX_WORKSPACE_IMPORTERS = 2_048
const MAX_LINKED_PACKAGES = 64
const MAX_LINK_PROBES = 4_096

export interface IdentityParityCopy {
  readonly version: string
  readonly path: string
  /**
   * The resolved realpath of the copy. `path` is display-relative to the invoked directory, which
   * reads well in a report but cannot be pasted into a resolver or an editor from anywhere else.
   * Absent on a finding built by hand (a test fixture, an older cached result).
   */
  readonly absolutePath?: string
  readonly importers: readonly string[]
}

export type IdentityParityCause = "version-skew" | "duplicate-path"

export interface IdentityParityFinding {
  readonly package: string
  readonly copies: readonly IdentityParityCopy[]
  /** Unique package versions observed across the physical copies. */
  readonly versions: readonly string[]
  /** `version-skew` when copies advertise different versions; otherwise the same-version path split. */
  readonly cause: IdentityParityCause
  readonly explanation: string
  readonly remediation: string
  /**
   * Why the copies exist, in install-topology terms: how many physical paths sit under how many
   * install roots, and whether any of those roots is outside the scanned project.
   *
   * A path list alone leaves the reader to reverse-engineer the shape. The two shapes need opposite
   * fixes: a NESTED install under the scanned root shadows the hoisted copy and one reinstall
   * collapses it, while a SIBLING install root (a linked checkout, a standalone app beside this one)
   * owns its own `node_modules` and no reinstall here can touch it.
   *
   * Absent on a finding built by hand (a test fixture, an older cached result).
   */
  readonly topology?: string
  /**
   * Why a copy the invoked directory does not import is still fatal here.
   *
   * The gate is workspace-wide on purpose. Scoping it to the invoked app would be more precise and
   * would also reintroduce the blindness this guard was built for: a copy that arrives through a
   * workspace-linked dependency is not visible from the app directory, and that case shipped a
   * broken dev server while the check reported "none". A workspace-wide answer over-reports in
   * exchange for never under-reporting - and over-reporting is the failure a developer can see and
   * act on, where under-reporting is the one nobody knows happened.
   *
   * Present only when the answer would otherwise look wrong: a subdirectory was scanned as its
   * workspace, and at least one copy sits outside that subdirectory.
   */
  readonly scope?: string
  /**
   * The copies exist but the app declared this package single-copy, so the resolver collapses them
   * before anything loads. Reported, never fatal - see `SingleCopyCoverage`.
   */
  readonly deduplicated: boolean
}

/**
 * What the app declared about deduplication, and how much of it is actually armed.
 *
 * A duplicate physical path is only a defect if something still LOADS both copies. An app consuming a
 * linked sibling repository cannot collapse the paths without giving up the property it chose `link:`
 * for - each repository owning its own `node_modules` - so nifra lets it declare the packages instead
 * (`"nifra": { "singleCopy": [...] }` in package.json) and verifies the declaration here rather than
 * failing on the raw path count.
 *
 * Bundled phases need nothing further: `buildClient`/`buildServer`/dev inject the resolver themselves.
 * Unbundled phases do, because Bun's runtime never offers a bare specifier to a resolver hook, so the
 * plugin has to be preloaded to intercept the load. `registration` is that proof, read statically out
 * of `bunfig.toml`.
 */
export interface SingleCopyCoverage {
  /** Declared package names and patterns, exactly as written. Empty when nothing was declared. */
  readonly declared: readonly string[]
  readonly registration: SingleCopyRegistration
}

export interface IdentityParityResult {
  /**
   * The governing workspace root: where importer enumeration starts, and how far a copy lookup may
   * walk up from an importer.
   *
   * EVERY caller resolves this the same way. The doctor and the build/dev preflight used to differ
   * here - one anchored at the workspace, the other at the app directory - so the same project could
   * be told it had duplicates by one command and a clean bill by the other. Two answers from one
   * toolchain is worse than either answer, so the basis is now fixed and reported rather than chosen.
   */
  readonly workspaceRoot: string
  /** The directory the caller asked about. Differs from `workspaceRoot` when a package subdirectory
   * is governed by a workspace above it; carried so a report can state the basis it scanned on. */
  readonly requestedRoot: string
  /**
   * Enumeration stopped at `MAX_WORKSPACE_IMPORTERS`, so this scan is PARTIAL.
   *
   * An empty `findings` then means "nothing found in the part that was scanned", never "clean" - a
   * caller that prints a clean bill on a truncated scan is the exact silence this flag exists to
   * prevent.
   */
  readonly truncated: boolean
  /** Findings that no declaration covers - the ones a build must refuse to start on. */
  readonly findings: readonly IdentityParityFinding[]
  /** Duplicates the declaration covers. Worth printing, never worth failing. */
  readonly deduplicated: readonly IdentityParityFinding[]
  readonly singleCopy: SingleCopyCoverage
}

export interface BuildManifestLike {
  readonly entry: string
  readonly assets: readonly string[]
  readonly routes: Readonly<Record<string, readonly string[]>>
  readonly publicFiles?: readonly string[]
  readonly css?: readonly string[]
}

export interface ParityManifest {
  readonly moduleGraph: {
    readonly routes: readonly string[]
    readonly routeChunks: Readonly<Record<string, number>>
    readonly emittedAssets: readonly string[]
  }
  readonly publicFiles: readonly string[]
  readonly css: readonly string[]
}

export interface DevelopmentParityInput {
  readonly routes: Readonly<Record<string, number>>
  readonly publicFiles: readonly string[]
  readonly css: readonly string[]
  /** The scanned first-party source root, carried only so a css parity failure can name where the
   * scanner looked. Optional: callers that hand-build an input for a unit test may omit it. */
  readonly sourceRoot?: string
}

const SOURCE_EXTENSIONS = /\.(?:c|m)?(?:j|t)sx?$|\.(?:mdx|svelte|vue)$/
/** A stylesheet path that the source scanner can prove is a real explicit import. */
const CSS_SPECIFIER = /\.(?:css|scss|sass|less|styl)(?:\?[^"'`]*)?$/i

type CssToken =
  | { readonly kind: "identifier"; readonly value: string; readonly lineStart: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "punctuator"; readonly value: string }

/**
 * Tokenize only the small part of TypeScript/JS needed for the CSS contract.
 *
 * A regex over source text is not sound here: documentation routes contain code examples such as
 * `import "./app.css"` in template literals, and comments can contain the same text. Those are not
 * imports and must not make a style-free production build fail. This intentionally conservative lexer
 * drops comments and complete template literals (including `${...}` expressions); missing a stylesheet
 * is the passing direction of this parity check, while claiming one that is not imported is not.
 */
const cssTokens = (source: string): readonly CssToken[] => {
  const tokens: CssToken[] = []
  let lineStart = true
  for (let index = 0; index < source.length; ) {
    const char = source[index]
    if (char === undefined) break
    if (/\s/.test(char)) {
      if (char === "\n" || char === "\r") lineStart = true
      index++
      continue
    }
    if (char === "/" && source[index + 1] === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n") index++
      continue
    }
    if (char === "/" && source[index + 1] === "*") {
      const commentStart = index
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++
      index = Math.min(source.length, index + 2)
      if (/[\r\n]/.test(source.slice(commentStart, index))) lineStart = true
      continue
    }
    if (char === "`") {
      const templateStart = index
      index++
      while (index < source.length) {
        const templateChar = source[index]
        if (templateChar === "\\") {
          index += 2
          continue
        }
        index++
        if (templateChar === "`") break
      }
      lineStart = /[\r\n]/.test(source.slice(templateStart, index))
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      const start = ++index
      while (index < source.length) {
        const stringChar = source[index]
        if (stringChar === "\\") {
          index += 2
          continue
        }
        index++
        if (stringChar === quote) break
      }
      tokens.push({ kind: "string", value: source.slice(start, Math.max(start, index - 1)) })
      lineStart = false
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index++
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index] ?? "")) index++
      tokens.push({ kind: "identifier", value: source.slice(start, index), lineStart })
      lineStart = false
      continue
    }
    tokens.push({ kind: "punctuator", value: char })
    lineStart = false
    index++
  }
  return tokens
}

const isStylesheetToken = (token: CssToken | undefined): boolean =>
  token?.kind === "string" && CSS_SPECIFIER.test(token.value)

/** Detect static imports, re-exports, literal dynamic imports, and literal require calls. */
const hasStylesheetImport = (source: string): boolean => {
  const tokens = cssTokens(source)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token?.kind !== "identifier") continue
    const next = tokens[index + 1]
    if (token.value === "import") {
      if (token.lineStart && isStylesheetToken(next)) return true
      if (next?.value === "(" && isStylesheetToken(tokens[index + 2])) return true
    }
    if (token.value === "require" && next?.value === "(" && isStylesheetToken(tokens[index + 2]))
      return true
    if (token.value === "from" && isStylesheetToken(next)) {
      for (let previous = index - 1; previous >= 0; previous--) {
        const candidate = tokens[previous]
        if (candidate?.kind === "identifier" && candidate.lineStart) {
          if (candidate.value === "import" || candidate.value === "export") return true
          break
        }
        if (candidate?.value === ";") break
      }
    }
  }
  return false
}
/** A single-file-component `<style>` block (Svelte/Vue). The bundler extracts these into the app
 * stylesheet even though no `import "...css"` statement exists, so the dev contract must count them
 * or a scoped-style component would look style-free next to a production manifest that carries css. */
const SFC_STYLE = /<style[\s>]/i
const isSingleFileComponent = (file: string): boolean =>
  file.endsWith(".svelte") || file.endsWith(".vue")

export type ManifestParitySection = "module-graph" | "public-files" | "css"

export interface ManifestParityDifference {
  readonly section: ManifestParitySection
  readonly development: unknown
  readonly production: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const value: unknown = JSON.parse(await Bun.file(path).text())
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const dependencyNames = (pkg: Record<string, unknown>): readonly string[] => {
  const names = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const value = pkg[field]
    if (!isRecord(value)) continue
    for (const name of Object.keys(value)) names.add(name)
  }
  return [...names]
}

const workspacePatterns = (pkg: Record<string, unknown>): readonly string[] => {
  const raw = pkg.workspaces
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.packages)
      ? raw.packages
      : []
  return entries
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .sort()
}

const pathExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

/** The real path, or the input when it cannot be resolved. Roots are compared against each other and
 * printed side by side, so they have to be normalized the same way (`/var` vs `/private/var`). */
const realpathOrSelf = (path: string): string => {
  try {
    // The native Windows resolver is the one that knows how to expand 8.3 aliases such as
    // `RUNNER~1`. The portable resolver can preserve the spelling it was given, which makes two
    // handles to the same checkout look like different install roots.
    return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path)
  } catch {
    return path
  }
}

/** Canonical comparison form for containment. Windows paths are case-insensitive and CI can expose
 * the same directory once through a short name (`RUNNER~1`) and once through its long name. */
const comparisonPath = (path: string): string => {
  const resolved = realpathOrSelf(resolve(path))
  const native = resolved.replaceAll("/", sep)
  return process.platform === "win32" ? native.toLowerCase() : native
}

/**
 * Windows may expose the same directory through a long path and an 8.3 short path even after
 * `realpathSync` has normalized both inputs. When the lexical comparison above says "outside", walk
 * the target's existing ancestors and compare the filesystem identity of each one. `statSync` with
 * bigint fields avoids truncating Windows file IDs, and a missing identity fails closed.
 */
const pathInsideByFilesystemIdentity = (root: string, path: string): boolean => {
  if (process.platform !== "win32") return false
  const rootIdentity = (() => {
    try {
      const info = statSync(realpathOrSelf(resolve(root)), { bigint: true })
      return { dev: info.dev, ino: info.ino }
    } catch {
      return undefined
    }
  })()
  if (rootIdentity === undefined) return false

  let current = realpathOrSelf(resolve(path))
  for (;;) {
    try {
      const info = statSync(current, { bigint: true })
      if (info.dev === rootIdentity.dev && info.ino === rootIdentity.ino) return true
    } catch {
      // A non-existent leaf can still have an existing parent. Keep walking; if no ancestor can
      // prove containment, the answer remains false rather than trusting a spelling alone.
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export const pathInside = (root: string, path: string): boolean => {
  const distance = relative(comparisonPath(root), comparisonPath(path))
  const lexicallyInside =
    distance === "" ||
    (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance))
  return lexicallyInside || pathInsideByFilesystemIdentity(root, path)
}

const workspaceContains = async (
  root: string,
  patterns: readonly string[],
  target: string,
): Promise<boolean> => {
  if (root === target) return patterns.length > 0
  for (const pattern of patterns) {
    const packagePattern = `${pattern.replace(/\/$/, "")}/package.json`
    for await (const match of new Bun.Glob(packagePattern).scan({ cwd: root, dot: false })) {
      if (match.split(/[\\/]/).includes("node_modules")) continue
      const packageRoot = resolve(root, dirname(match))
      if (pathInside(packageRoot, target)) return true
    }
  }
  return false
}

/** Resolve the workspace root once, even when the caller starts in a workspace package. */
export async function resolveParityWorkspaceRoot(
  start: string,
): Promise<{ readonly root: string; readonly package: Record<string, unknown> }> {
  const original = realpathSync(resolve(start))
  let current = original
  for (;;) {
    const pkg = await readJson(join(current, "package.json"))
    if (pkg !== undefined && (await workspaceContains(current, workspacePatterns(pkg), original))) {
      return { root: current, package: pkg }
    }
    if (await pathExists(join(current, ".git"))) return { root: original, package: {} }
    const parent = dirname(current)
    if (parent === current) return { root: original, package: {} }
    current = parent
  }
}

/**
 * Every workspace manifest that can install its own copy of a dependency.
 *
 * A pathological workspace must not make the scan unbounded, but it must not make it LIE either: the
 * cap used to discard everything collected and return an empty list, which reads downstream as "no
 * duplicates" - a clean bill from a scan that never ran. The bounded prefix is kept and `truncated`
 * says the rest was not looked at.
 */
const workspaceImporters = async (
  root: string,
  rootPackage: Record<string, unknown>,
): Promise<{
  readonly importers: readonly { root: string; package: Record<string, unknown> }[]
  readonly truncated: boolean
}> => {
  const manifests = new Set<string>([join(root, "package.json")])
  let truncated = false
  for (const pattern of workspacePatterns(rootPackage)) {
    if (truncated) break
    const packagePattern = `${pattern.replace(/\/$/, "")}/package.json`
    for await (const match of new Bun.Glob(packagePattern).scan({ cwd: root, dot: false })) {
      if (match.split(/[\\/]/).includes("node_modules")) continue
      if (manifests.size >= MAX_WORKSPACE_IMPORTERS) {
        truncated = true
        break
      }
      manifests.add(join(root, match))
    }
  }
  const importers: { root: string; package: Record<string, unknown> }[] = []
  for (const manifest of [...manifests].sort()) {
    const pkg = await readJson(manifest)
    if (pkg !== undefined) importers.push({ root: dirname(manifest), package: pkg })
  }
  return { importers, truncated }
}

export const resolvedInstalledCopy = async (
  importer: string,
  boundary: string,
  name: string,
): Promise<{ readonly path: string; readonly version: string } | undefined> => {
  const parts = name.split("/")
  for (let dir = importer; ; dir = dirname(dir)) {
    const packageDir = join(dir, "node_modules", ...parts)
    const meta = await readJson(join(packageDir, "package.json"))
    if (meta !== undefined) {
      try {
        return {
          path: await realpath(packageDir),
          version:
            typeof meta.version === "string" && meta.version.length > 0 ? meta.version : "unknown",
        }
      } catch {
        return undefined
      }
    }
    if (dir === boundary) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
  }
}

/**
 * How far above a linked package its dependencies may legitimately live.
 *
 * A linked SOURCE CHECKOUT (`link:../../nifra/packages/core`) really does resolve its imports from its
 * own repo's `node_modules`, so the walk goes up to that repo's `.git` - a duplicate found there is one
 * this project genuinely dual-loads.
 *
 * A path that lands INSIDE a `node_modules` directory is a package-manager store copy, not a checkout:
 * a symlink into another project's store (bun's `.bun/<pkg>@<version>`, an `npm link` target, a shared
 * global store) resolves there. Everything above such a copy belongs to whoever owns that store, and
 * walking up would sweep an unrelated project's entire dependency tree into this project's duplicate
 * report - permanent findings in a repo the developer is not even working in, that no change here can
 * clear. Clamp to the copy itself: only its own nested `node_modules` counts, which is exactly the set
 * of modules it can actually load.
 */
const linkedRepoBoundary = async (packageRoot: string): Promise<string> => {
  if (packageRoot.split(sep).includes("node_modules")) return packageRoot
  let dir = packageRoot
  for (let depth = 0; depth < 8; depth++) {
    if (await pathExists(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return packageRoot
}

const linkedPackageRoots = async (
  importerRoots: readonly string[],
  manifests: readonly Record<string, unknown>[],
  scanRoot: string,
): Promise<{ readonly roots: readonly string[]; readonly truncated: boolean }> => {
  const realScanRoot = await realpath(scanRoot).catch(() => scanRoot)
  const found = new Map<string, true>()
  let probes = 0
  for (const [index, importerRoot] of importerRoots.entries()) {
    const pkg = manifests[index]
    if (pkg === undefined) continue
    for (const name of dependencyNames(pkg)) {
      // Same rule as the importer cap: a bounded scan reports that it stopped. Returning the prefix
      // silently would let a duplicate sitting past the cap read as a clean bill.
      if (probes++ >= MAX_LINK_PROBES || found.size >= MAX_LINKED_PACKAGES) {
        return { roots: [...found.keys()], truncated: true }
      }
      const candidate = join(importerRoot, "node_modules", ...name.split("/"))
      const link = await lstat(candidate).catch(() => undefined)
      if (link === undefined || !link.isSymbolicLink()) continue
      const resolved = await realpath(candidate).catch(() => undefined)
      if (resolved === undefined || pathInside(realScanRoot, resolved)) continue
      found.set(resolved, true)
    }
  }
  return { roots: [...found.keys()], truncated: false }
}

export const displayPath = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel === "" ? "." : rel.replaceAll("\\", "/")
}

/**
 * The install root a copy belongs to: the directory ABOVE its last `node_modules` segment.
 *
 * That directory is what a package manager operates on, so it is the unit a fix is expressed in. A
 * copy that sits in no `node_modules` at all is a source checkout, which is its own install root.
 */
const installRootOf = (path: string): string => {
  const parts = path.split(sep)
  const last = parts.lastIndexOf("node_modules")
  if (last <= 0) return path
  return parts.slice(0, last).join(sep)
}

/**
 * State the SHAPE of a duplicate, not just its paths.
 *
 * The failure a developer has to act on is a topology, and the two topologies take opposite fixes.
 * Copies under one install root (a nested `node_modules` shadowing the hoisted one) collapse with a
 * single reinstall from that root. Copies under separate roots - a linked checkout, a standalone app
 * beside this one with its own `node_modules` - do not: that second root belongs to another install,
 * and nothing this project runs can merge it. Naming which case this is turns a path list into a
 * decision.
 */
const describeTopology = (
  base: string,
  scanRoot: string,
  paths: readonly string[],
): string | undefined => {
  if (paths.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const path of paths) {
    const root = installRootOf(path)
    counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  const roots = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  const breakdown = roots
    .map(([root, count]) => `${count} under ${displayPath(base, root)}`)
    .join(", ")
  const outside = roots.filter(([root]) => !pathInside(scanRoot, root))
  const shape =
    outside.length > 0
      ? `${outside.length} install root${outside.length === 1 ? " is" : "s are"} outside the scanned root (${outside
          .map(([root]) => displayPath(base, root))
          .join(
            ", ",
          )}), so that copy is installed by another project and reinstalling here cannot remove it`
      : roots.length > 1
        ? "all install roots are inside the scanned root, so a nested install is shadowing the hoisted copy and one reinstall from the workspace root collapses it"
        : "one install root holds every copy, so the split is inside a single install (a nested or stored copy), not across projects"
  return `${paths.length} paths under ${roots.length} install root${roots.length === 1 ? "" : "s"}: ${breakdown}; ${shape}`
}

/**
 * State that the gate is workspace-wide, when that is what makes a finding look wrong.
 *
 * Running `nifra build` inside `apps/web` can fail on a copy held by `apps/admin` - a package this
 * app never imports. That is deliberate, not a miss: the scan is anchored on the workspace because
 * copies reached through a workspace-linked dependency are invisible from the app directory, and
 * anchoring on the app is exactly how this guard once reported "none" while dev was already broken.
 * The trade is over-reporting instead of under-reporting, and the note says so rather than leaving a
 * developer to conclude the tool is confused about which project it is checking.
 */
const describeScope = (
  requestedRoot: string,
  scanRoot: string,
  paths: readonly string[],
): string | undefined => {
  if (requestedRoot === scanRoot) return undefined
  const outside = paths.filter((path) => !pathInside(requestedRoot, path))
  if (outside.length === 0) return undefined
  const here = relative(scanRoot, requestedRoot) || "."
  return `${outside.length} of these copies ${outside.length === 1 ? "is" : "are"} outside ${here}, so this fails every build in the workspace, including apps that never import the package. The scan is anchored on the workspace on purpose: a copy reached through a workspace-linked dependency cannot be seen from ${here} alone, and scoping to it would miss the case this check exists for. Fix the copies where they live, or declare the package single-copy.`
}

const identityTargets = (pkg: Record<string, unknown>): readonly string[] =>
  dependencyNames(pkg).filter(isIdentitySensitivePackage).sort()

/** version-skew is a range problem: one reinstall from the root collapses it. */
const VERSION_SKEW_REMEDIATION =
  "Align dependency ranges and reinstall from the workspace root so every importer resolves one physical copy; nifra does not rewrite lockfiles for identity conflicts."
/** duplicate-path is a topology problem. When the copies come from a linked sibling repo a reinstall
 * does not collapse them - each tree keeps its own copy, which is the whole reason `link:` was chosen.
 * So the fix is either one physical path, or a declaration that nifra can verify and enforce. */
const duplicatePathRemediation = (name: string): string =>
  `Deduplicate so ${name} resolves to a single physical path, or declare it single-copy: add "nifra": { "singleCopy": ["${name}"] } to package.json and preload "${SINGLE_COPY_REGISTER_SPECIFIER}" from bunfig.toml. nifra then rewrites every duplicate to this app's copy - at one version only, so align ranges first if the copies ever differ.`
const identityRemediation = (cause: IdentityParityCause, name: string): string =>
  cause === "version-skew" ? VERSION_SKEW_REMEDIATION : duplicatePathRemediation(name)

/** What is left to do about a duplicate the declaration already covers. */
const deduplicatedRemediation = (registration: SingleCopyRegistration): string =>
  registration.run || registration.test
    ? "Declared single-copy and enforced: every duplicate is rewritten to this app's copy, so one module instance loads."
    : `Declared single-copy, so bundled output is deduplicated by the build. Unbundled runs are NOT: Bun's runtime never offers a bare specifier to a resolver, so add preload = ["${SINGLE_COPY_REGISTER_SPECIFIER}"] to bunfig.toml (and under [test]) or \`bun test\` still loads both copies.`

/**
 * Read the declaration and its runtime proof, preferring the directory the caller is in.
 *
 * A monorepo declares this per app, not once at the root: the app is what owns the `node_modules` the
 * duplicates must collapse into, and two apps in one workspace can legitimately differ. The workspace
 * root is the fallback so a single-package project needs no second file.
 */
const singleCopyCoverage = (cwd: string, scanRoot: string): SingleCopyCoverage => {
  const declared = readSingleCopyDeclaration(cwd) ?? readSingleCopyDeclaration(scanRoot) ?? []
  const local = readSingleCopyRegistration(cwd)
  const registration = local.run || local.test ? local : readSingleCopyRegistration(scanRoot)
  return { declared, registration }
}

/** Find duplicate identity-sensitive package realpaths without reading application payloads. */
export async function collectIdentityParity(
  cwd: string,
  rootPackage?: Record<string, unknown>,
): Promise<IdentityParityResult> {
  const requestedRoot = realpathOrSelf(resolve(cwd))
  const localPackage = await readJson(join(requestedRoot, "package.json"))
  // One basis for every caller. A package subdirectory is scanned as the workspace that governs it,
  // because that workspace is what installed the copies it loads - and because a doctor and a build
  // that anchor differently answer the same question differently, which is how a guard loses trust.
  const workspace =
    localPackage === undefined
      ? { root: requestedRoot, package: rootPackage ?? {} }
      : await resolveParityWorkspaceRoot(requestedRoot)
  const scanRoot = workspace.root
  const scanPackage = workspace.package
  const { importers, truncated } = await workspaceImporters(scanRoot, scanPackage)
  const byPackage = new Map<string, Map<string, { version: string; importers: Set<string> }>>()
  const record = (
    name: string,
    copy: { readonly path: string; readonly version: string },
    importer: string,
  ): void => {
    const copies = byPackage.get(name) ?? new Map()
    const entry = copies.get(copy.path) ?? { version: copy.version, importers: new Set<string>() }
    entry.importers.add(importer)
    copies.set(copy.path, entry)
    byPackage.set(name, copies)
  }

  const targets = new Set<string>()
  for (const importer of importers) {
    for (const name of identityTargets(importer.package)) {
      if (importer.package.name === name) continue
      targets.add(name)
      const copy = await resolvedInstalledCopy(importer.root, scanRoot, name)
      if (copy !== undefined) record(name, copy, displayPath(requestedRoot, importer.root))
    }
  }
  for (const name of targets) {
    const copy = await resolvedInstalledCopy(scanRoot, scanRoot, name)
    if (copy !== undefined) record(name, copy, displayPath(requestedRoot, scanRoot))
  }

  const linked = await linkedPackageRoots(
    [...importers.map((importer) => importer.root), scanRoot],
    [...importers.map((importer) => importer.package), scanPackage],
    scanRoot,
  )
  for (const linkedRoot of linked.roots) {
    const linkedPackage = await readJson(join(linkedRoot, "package.json"))
    const boundary = await linkedRepoBoundary(linkedRoot)
    const linkedTargets = new Set([
      ...targets,
      ...(linkedPackage === undefined ? [] : identityTargets(linkedPackage)),
    ])
    for (const name of linkedTargets) {
      if (linkedPackage?.name === name) continue
      const copy = await resolvedInstalledCopy(linkedRoot, boundary, name)
      if (copy !== undefined) record(name, copy, displayPath(requestedRoot, linkedRoot))
    }
  }

  const singleCopy = singleCopyCoverage(requestedRoot, scanRoot)
  const findings: IdentityParityFinding[] = []
  const deduplicated: IdentityParityFinding[] = []
  for (const [name, copies] of [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (copies.size < 2) continue
    const absolutePaths = [...copies.keys()].sort()
    const resolvedCopies = [...copies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, copy]) => ({
        version: copy.version,
        path: displayPath(requestedRoot, path),
        absolutePath: path,
        importers: [...copy.importers].sort(),
      }))
    const topology = describeTopology(requestedRoot, scanRoot, absolutePaths)
    const scope = describeScope(requestedRoot, scanRoot, absolutePaths)
    const versions = [...new Set(resolvedCopies.map((copy) => copy.version))].sort()
    const cause: IdentityParityCause = versions.length > 1 ? "version-skew" : "duplicate-path"
    // A declaration never covers a version skew. Redirecting across versions would hand a package a
    // version it did not ask for, which converts a loud install problem into a quiet behavioural one -
    // so the skew stays fatal and the ranges have to be fixed.
    const covered =
      cause === "duplicate-path" && matchesSingleCopyDeclaration(singleCopy.declared, name)
    const finding: IdentityParityFinding = {
      package: name,
      copies: resolvedCopies,
      versions,
      cause,
      explanation:
        cause === "version-skew"
          ? `${name} resolves to multiple versions and physical paths, so module state and symbols are not shared`
          : covered
            ? `${name} is installed at more than one physical path and is declared single-copy, so every duplicate is rewritten to this app's copy`
            : `${name} is loaded from more than one physical path, so module state and symbols are not shared`,
      remediation: covered
        ? deduplicatedRemediation(singleCopy.registration)
        : identityRemediation(cause, name),
      ...(topology === undefined ? {} : { topology }),
      ...(scope === undefined ? {} : { scope }),
      deduplicated: covered,
    }
    ;(covered ? deduplicated : findings).push(finding)
  }
  return {
    workspaceRoot: scanRoot,
    requestedRoot,
    truncated: truncated || linked.truncated,
    findings,
    deduplicated,
    singleCopy,
  }
}

/** One `- pkg [cause]: ...` block per finding, shared by the hard failure and the dev warning. */
export function formatIdentityParityFindings(findings: readonly IdentityParityFinding[]): string {
  return findings
    .map(
      (finding) =>
        `- ${finding.package} [${finding.cause}]: ${finding.explanation}. ${finding.remediation}\n` +
        `  versions: ${finding.versions.join(", ")}; paths: ${finding.copies
          .map((copy) => copy.path)
          .join(", ")}` +
        (finding.topology === undefined ? "" : `\n  topology: ${finding.topology}`) +
        (finding.scope === undefined ? "" : `\n  scope: ${finding.scope}`),
    )
    .join("\n")
}

/**
 * The basis a scan ran on, for any surface that reports its result.
 *
 * A verdict about installs is only as good as where it looked, and the reader cannot see that from a
 * list of relative paths. Stating it also makes a truncated scan impossible to read as a clean one.
 */
export function identityParityBasis(result: IdentityParityResult): string {
  const scope =
    result.workspaceRoot === result.requestedRoot
      ? `scanned ${result.workspaceRoot}`
      : `scanned ${result.workspaceRoot} (the workspace governing ${result.requestedRoot})`
  return result.truncated
    ? `${scope}; PARTIAL - enumeration stopped at a scan limit (${MAX_WORKSPACE_IMPORTERS} workspace packages, ${MAX_LINKED_PACKAGES} linked packages, or ${MAX_LINK_PROBES} link probes), so installs beyond it were not examined`
    : scope
}

/** `2 primary package findings` / `1 primary package finding`. */
export const identityParityHeadline = (count: number): string =>
  `${count} primary package finding${count === 1 ? "" : "s"}`

/**
 * Fail before dev/build when the same identity-sensitive package has multiple realpaths AND nothing
 * is collapsing them.
 *
 * A declared package is not a suppression: the build injects the single-copy resolver, so the duplicate
 * genuinely cannot reach the output. Failing on it anyway would leave the only supported answer being
 * to change the install topology, which is the thing an app using linked sibling repositories cannot
 * do. `result.deduplicated` still carries every covered duplicate for the caller to print.
 */
export async function assertIdentityParity(
  cwd: string,
  rootPackage?: Record<string, unknown>,
): Promise<IdentityParityResult> {
  const result = await collectIdentityParity(cwd, rootPackage)
  if (result.findings.length === 0) {
    // A bounded scan that found nothing has not shown there is nothing: the duplicate can be sitting
    // in the part it never reached. `truncated` is exactly that state, so the hard gate refuses to
    // read it as a pass - a guard that answers "clean" from an incomplete scan is how a guard stops
    // being worth having. Reporting surfaces (`nifra doctor`, the dev warning) still print the
    // partial result through `identityParityBasis`; only the gate that must not be wrong stops here.
    if (result.truncated) {
      throw new Error(
        `[nifra] identity parity inconclusive - scan limit reached (${identityParityBasis(result)}). Narrow the scan (run from the app or workspace that governs this install) or reduce the workspace/linked-package topology so the scan can complete.`,
      )
    }
    return result
  }
  throw new Error(
    `[nifra] identity parity failed (${identityParityHeadline(result.findings.length)}; ${identityParityBasis(result)}):\n${formatIdentityParityFindings(result.findings)}`,
  )
}

const assetName = (url: string): string => url.replace(/^.*\//, "")
const assetExtension = (url: string): string => {
  const file = assetName(url).toLowerCase()
  const dot = file.lastIndexOf(".")
  return dot === -1 ? "other" : file.slice(dot + 1)
}

/** Convert hashed production asset names into the stable module-graph contract. */
export function logicalStaticAssets(manifest: BuildManifestLike): readonly string[] {
  const routeOwners = new Map<string, string[]>()
  for (const [route, chunks] of Object.entries(manifest.routes)) {
    chunks.forEach((chunk, index) => {
      const owners = routeOwners.get(assetName(chunk)) ?? []
      owners.push(`route:${route}:${index}`)
      routeOwners.set(assetName(chunk), owners)
    })
  }
  const cssOwners = new Map<string, string>()
  for (const [index, css] of (manifest.css ?? []).entries())
    cssOwners.set(assetName(css), `stylesheet:${index}`)
  const logical = new Set<string>()
  for (const asset of manifest.assets) {
    const file = assetName(asset)
    if (asset === manifest.entry) {
      logical.add("js:entry")
      continue
    }
    const owners = routeOwners.get(file)
    if (owners !== undefined) {
      for (const owner of owners) logical.add(`js:${owner}`)
      continue
    }
    const css = cssOwners.get(file)
    if (css !== undefined) {
      logical.add(`css:${css}`)
      continue
    }
    if (assetExtension(asset) !== "js") logical.add(`asset:${assetExtension(asset)}`)
  }
  for (const file of manifest.publicFiles ?? []) logical.add(`public:${file}`)
  return [...logical].sort()
}

export function normalizeBuildManifest(manifest: BuildManifestLike): ParityManifest {
  return {
    moduleGraph: {
      routes: Object.keys(manifest.routes).sort(),
      routeChunks: Object.fromEntries(
        Object.entries(manifest.routes)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([route, chunks]) => [route, chunks.length]),
      ),
      // Allowlist, not denylist: the dev/prod module-graph contract is the JavaScript module graph
      // only. `js:entry` and `js:route:<id>:<n>` are the roles dev can reconstruct from source. Which
      // *non-JS* files a bundler emits (svg, woff2, an extracted stylesheet) is an output detail, not
      // a claim dev can make - dev serves those from source. The stylesheet claim that matters keeps
      // its own `css` section; `public/` keeps `publicFiles`. A denylist admitted every future
      // `asset:*` prefix by default, which is how an emitted `asset:svg` hard-failed every build.
      emittedAssets: logicalStaticAssets(manifest).filter((asset) => asset.startsWith("js:")),
    },
    publicFiles: [...(manifest.publicFiles ?? [])].sort(),
    css: (manifest.css ?? []).length > 0 ? ["css:present"] : [],
  }
}

export function createDevelopmentParityManifest(input: DevelopmentParityInput): ParityManifest {
  const routes = Object.fromEntries(
    Object.entries(input.routes).sort(([a], [b]) => a.localeCompare(b)),
  )
  const publicFiles = [...input.publicFiles].sort()
  return {
    moduleGraph: {
      routes: Object.keys(routes),
      routeChunks: routes,
      emittedAssets: [
        "js:entry",
        ...Object.entries(routes).flatMap(([route, count]) =>
          Array.from({ length: count }, (_, index) => `js:route:${route}:${index}`),
        ),
      ].sort(),
    },
    publicFiles,
    css: [...input.css].sort(),
  }
}

const sourceFilesUnder = (root: string): readonly string[] => {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (
        ["node_modules", "dist", "dist-node", "build", ".git", ".nifra", "coverage"].includes(
          entry.name,
        )
      )
        continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) files.push(path)
    }
  }
  if (existsSync(root)) walk(root)
  return files
}

const publicFilesUnder = (publicDir: string | false | undefined): readonly string[] => {
  if (publicDir === undefined || publicDir === false || !existsSync(publicDir)) return []
  const root = resolve(publicDir)
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(`/${relative(root, path).split(sep).join("/")}`)
    }
  }
  walk(root)
  return files.sort()
}

/** Read the source-side dev contract, independent of any production output. */
export function collectDevelopmentParityInput(
  routesDir: string,
  publicDir: string | false | undefined,
): DevelopmentParityInput {
  const routeManifest = discoverRoutes(routesDir)
  const routes: Record<string, number> = Object.fromEntries(
    routeManifest.routes.map((route) => [route.id, route.layoutIds.length + 1]),
  )
  if (routeManifest.notFound !== undefined) routes._404 = 1
  const sourceRoot = dirname(resolve(routesDir))
  const css = sourceFilesUnder(sourceRoot).some((file) => {
    const content = readFileSync(file, "utf8")
    return hasStylesheetImport(content) || (isSingleFileComponent(file) && SFC_STYLE.test(content))
  })
    ? ["css:present"]
    : []
  return {
    routes,
    publicFiles: publicFilesUnder(publicDir),
    css,
    sourceRoot,
  }
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function compareManifestParity(
  development: ParityManifest,
  production: ParityManifest,
): readonly ManifestParityDifference[] {
  const differences: ManifestParityDifference[] = []
  if (!equal(development.moduleGraph, production.moduleGraph))
    differences.push({
      section: "module-graph",
      development: development.moduleGraph,
      production: production.moduleGraph,
    })
  if (!equal(development.publicFiles, production.publicFiles))
    differences.push({
      section: "public-files",
      development: development.publicFiles,
      production: production.publicFiles,
    })
  // css is the one section with an inference-based side. The dev scanner (CSS_IMPORT) is
  // sound-but-incomplete by construction, so `dev empty, prod css` is a scanner miss, not an app
  // defect - it passes. Fail only the load-bearing direction: dev found styles the build does not
  // ship, so the production page would render unstyled. module-graph and public-files stay on equality
  // because both sides are ground truth there.
  if (development.css.length > 0 && production.css.length === 0)
    differences.push({ section: "css", development: development.css, production: production.css })
  return differences
}

/** The forms the source scanner cannot prove, quoted in a css parity failure so the reader knows where to look. */
const CSS_SCANNER_BLIND_SPOTS =
  "a bare package subpath (exports), an @import inside a stylesheet, template interpolation, or plugin-injected css"

const symmetricDifference = (
  a: readonly string[],
  b: readonly string[],
): { readonly onlyDevelopment: readonly string[]; readonly onlyProduction: readonly string[] } => {
  const left = new Set(a)
  const right = new Set(b)
  return {
    onlyDevelopment: a.filter((value) => !right.has(value)),
    onlyProduction: b.filter((value) => !left.has(value)),
  }
}

/** Turn one parity difference into a message that names the offending files, not two opaque blobs. */
function explainParityDifference(
  difference: ManifestParityDifference,
  development: DevelopmentParityInput,
  production: BuildManifestLike,
): string {
  if (difference.section === "css") {
    const shipped = (production.css ?? []).join(", ")
    const where = development.sourceRoot === undefined ? "" : ` under ${development.sourceRoot}`
    return (
      `css: production ships [${shipped || "(none)"}] but the development scanner found a static ` +
      `stylesheet import${where} - it is blind to ${CSS_SCANNER_BLIND_SPOTS}`
    )
  }
  if (difference.section === "module-graph") {
    const dev = difference.development as ParityManifest["moduleGraph"]
    const prod = difference.production as ParityManifest["moduleGraph"]
    const routes = symmetricDifference(dev.routes, prod.routes)
    const assets = symmetricDifference(dev.emittedAssets, prod.emittedAssets)
    const parts: string[] = []
    if (routes.onlyDevelopment.length > 0 || routes.onlyProduction.length > 0)
      parts.push(
        `routes only in development=${JSON.stringify(routes.onlyDevelopment)} only in production=${JSON.stringify(routes.onlyProduction)}`,
      )
    if (assets.onlyDevelopment.length > 0 || assets.onlyProduction.length > 0)
      parts.push(
        `chunks only in development=${JSON.stringify(assets.onlyDevelopment)} only in production=${JSON.stringify(assets.onlyProduction)}`,
      )
    if (parts.length === 0)
      parts.push(
        `route chunk counts differ: development=${JSON.stringify(dev.routeChunks)} production=${JSON.stringify(prod.routeChunks)}`,
      )
    return `module-graph: ${parts.join("; ")}`
  }
  const files = symmetricDifference(
    difference.development as readonly string[],
    difference.production as readonly string[],
  )
  return `${difference.section}: only in development=${JSON.stringify(files.onlyDevelopment)} only in production=${JSON.stringify(files.onlyProduction)}`
}

/** Validate a production manifest against the source manifest a development server should serve. */
export function assertDevelopmentProductionParity(
  development: DevelopmentParityInput,
  production: BuildManifestLike,
): readonly ManifestParityDifference[] {
  const differences = compareManifestParity(
    createDevelopmentParityManifest(development),
    normalizeBuildManifest(production),
  )
  if (differences.length > 0) {
    const detail = differences
      .map((difference) => explainParityDifference(difference, development, production))
      .join("; ")
    throw new Error(`[nifra] development and production manifest parity failed: ${detail}`)
  }
  return differences
}
