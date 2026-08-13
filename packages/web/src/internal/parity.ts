/**
 * Shared identity and development/production parity facts.
 *
 * The CLI doctor and the web pipelines must answer the same question: will identity-sensitive
 * modules and emitted app surfaces resolve to one coherent graph? This internal seam owns path and
 * manifest normalization so those callers cannot quietly grow separate rules.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { lstat, realpath, stat } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { discoverRoutes } from "../fs.ts"

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const
const IDENTITY_SENSITIVE_PACKAGES = new Set([
  "@nifrajs/core",
  "react",
  "react-dom",
  "preact",
  "svelte",
  "solid-js",
  "vue",
])
const MAX_WORKSPACE_IMPORTERS = 2_048
const MAX_LINKED_PACKAGES = 64
const MAX_LINK_PROBES = 4_096

export interface IdentityParityCopy {
  readonly version: string
  readonly path: string
  readonly importers: readonly string[]
}

export interface IdentityParityFinding {
  readonly package: string
  readonly copies: readonly IdentityParityCopy[]
  readonly explanation: string
  readonly remediation: string
}

export interface IdentityParityResult {
  readonly workspaceRoot: string
  readonly findings: readonly IdentityParityFinding[]
}

export interface IdentityParityOptions {
  /** Scan the governing workspace when the caller is a package subdirectory. */
  readonly useWorkspaceRoot?: boolean
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
}

const SOURCE_EXTENSIONS = /\.(?:c|m)?(?:j|t)sx?$|\.(?:mdx|svelte|vue)$/
const CSS_IMPORT =
  /(?:import\s+(?:[^"']+\s+from\s+)?|from\s+)["'][^"']+\.(?:css|scss|sass|less|styl)(?:\?[^"']*)?["']/i

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

const pathInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

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
      const targetRelative = relative(packageRoot, target)
      if (
        targetRelative === "" ||
        (!targetRelative.startsWith(`..${sep}`) && targetRelative !== "..")
      )
        return true
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

const workspaceImporters = async (
  root: string,
  rootPackage: Record<string, unknown>,
): Promise<readonly { root: string; package: Record<string, unknown> }[]> => {
  const manifests = new Set<string>([join(root, "package.json")])
  for (const pattern of workspacePatterns(rootPackage)) {
    const packagePattern = `${pattern.replace(/\/$/, "")}/package.json`
    for await (const match of new Bun.Glob(packagePattern).scan({ cwd: root, dot: false })) {
      if (match.split(/[\\/]/).includes("node_modules")) continue
      manifests.add(join(root, match))
      if (manifests.size > MAX_WORKSPACE_IMPORTERS) return []
    }
  }
  const importers: { root: string; package: Record<string, unknown> }[] = []
  for (const manifest of [...manifests].sort()) {
    const pkg = await readJson(manifest)
    if (pkg !== undefined) importers.push({ root: dirname(manifest), package: pkg })
  }
  return importers
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

const linkedRepoBoundary = async (packageRoot: string): Promise<string> => {
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
): Promise<readonly string[]> => {
  const realScanRoot = await realpath(scanRoot).catch(() => scanRoot)
  const found = new Map<string, true>()
  let probes = 0
  for (const [index, importerRoot] of importerRoots.entries()) {
    const pkg = manifests[index]
    if (pkg === undefined) continue
    for (const name of dependencyNames(pkg)) {
      if (probes++ >= MAX_LINK_PROBES || found.size >= MAX_LINKED_PACKAGES) return [...found.keys()]
      const candidate = join(importerRoot, "node_modules", ...name.split("/"))
      const link = await lstat(candidate).catch(() => undefined)
      if (link === undefined || !link.isSymbolicLink()) continue
      const resolved = await realpath(candidate).catch(() => undefined)
      if (resolved === undefined || pathInside(realScanRoot, resolved)) continue
      found.set(resolved, true)
    }
  }
  return [...found.keys()]
}

export const displayPath = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel === "" ? "." : rel
}

const identityTargets = (pkg: Record<string, unknown>): readonly string[] =>
  dependencyNames(pkg)
    .filter((name) => name.startsWith("@nifrajs/") || IDENTITY_SENSITIVE_PACKAGES.has(name))
    .sort()

const IDENTITY_REMEDIATION =
  "Align dependency ranges and reinstall from the workspace root so every importer resolves one physical copy."

/** Find duplicate identity-sensitive package realpaths without reading application payloads. */
export async function collectIdentityParity(
  cwd: string,
  rootPackage?: Record<string, unknown>,
  options: IdentityParityOptions = {},
): Promise<IdentityParityResult> {
  const requestedRoot = resolve(cwd)
  const localPackage = await readJson(join(requestedRoot, "package.json"))
  const workspace =
    options.useWorkspaceRoot && localPackage !== undefined
      ? await resolveParityWorkspaceRoot(requestedRoot)
      : { root: requestedRoot, package: localPackage ?? rootPackage ?? {} }
  const scanRoot = workspace.root
  const scanPackage = workspace.package
  const importers = await workspaceImporters(scanRoot, scanPackage)
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
      if (copy !== undefined) record(name, copy, displayPath(cwd, importer.root))
    }
  }
  for (const name of targets) {
    const copy = await resolvedInstalledCopy(scanRoot, scanRoot, name)
    if (copy !== undefined) record(name, copy, displayPath(cwd, scanRoot))
  }

  const linkedRoots = await linkedPackageRoots(
    [...importers.map((importer) => importer.root), scanRoot],
    [...importers.map((importer) => importer.package), scanPackage],
    scanRoot,
  )
  for (const linkedRoot of linkedRoots) {
    const linkedPackage = await readJson(join(linkedRoot, "package.json"))
    const boundary = await linkedRepoBoundary(linkedRoot)
    const linkedTargets = new Set([
      ...targets,
      ...(linkedPackage === undefined ? [] : identityTargets(linkedPackage)),
    ])
    for (const name of linkedTargets) {
      if (linkedPackage?.name === name) continue
      const copy = await resolvedInstalledCopy(linkedRoot, boundary, name)
      if (copy !== undefined) record(name, copy, displayPath(cwd, linkedRoot))
    }
  }

  const findings: IdentityParityFinding[] = []
  for (const [name, copies] of [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (copies.size < 2) continue
    findings.push({
      package: name,
      copies: [...copies.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, copy]) => ({
          version: copy.version,
          path: displayPath(cwd, path),
          importers: [...copy.importers].sort(),
        })),
      explanation: `${name} is loaded from more than one physical path, so module state and symbols are not shared`,
      remediation: IDENTITY_REMEDIATION,
    })
  }
  return { workspaceRoot: scanRoot, findings }
}

/** Fail before dev/build when the same identity-sensitive package has multiple realpaths. */
export async function assertIdentityParity(
  cwd: string,
  rootPackage?: Record<string, unknown>,
  options: IdentityParityOptions = {},
): Promise<IdentityParityResult> {
  const result = await collectIdentityParity(cwd, rootPackage, options)
  if (result.findings.length === 0) return result
  const details = result.findings
    .map(
      (finding) =>
        `${finding.package}: ${finding.explanation}. ${finding.remediation} Paths: ${finding.copies
          .map((copy) => copy.path)
          .join(", ")}`,
    )
    .join("; ")
  throw new Error(`[nifra] identity parity failed: ${details}`)
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
      emittedAssets: logicalStaticAssets(manifest).filter(
        (asset) => !asset.startsWith("css:") && !asset.startsWith("public:"),
      ),
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
      if (["node_modules", "dist", "build", ".git", ".nifra", "coverage"].includes(entry.name))
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
  const css = sourceFilesUnder(sourceRoot).some((file) =>
    CSS_IMPORT.test(readFileSync(file, "utf8")),
  )
    ? ["css:present"]
    : []
  return {
    routes,
    publicFiles: publicFilesUnder(publicDir),
    css,
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
  if (!equal(development.css, production.css))
    differences.push({ section: "css", development: development.css, production: production.css })
  return differences
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
      .map(
        (difference) =>
          `${difference.section}: development=${JSON.stringify(difference.development)} production=${JSON.stringify(difference.production)}`,
      )
      .join("; ")
    throw new Error(`[nifra] development and production manifest parity failed: ${detail}`)
  }
  return differences
}
