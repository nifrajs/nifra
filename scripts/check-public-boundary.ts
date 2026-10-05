/**
 * Public/private boundary gate.
 *
 * The marker scan is intentionally supplied by the environment. The generic policy below is
 * repository-visible and therefore cannot rely on a private product name to detect operated depth.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { findAgentBoundaryFailures } from "./check-agent-boundary.ts"
import { publishedPackages } from "./public-package-manifest.ts"

const ROOT = resolve(import.meta.dir, "..")
const SKIP = /(?:^|\/)(?:dist|node_modules|coverage)\//
// The marker scan reads what a tarball can carry: built `dist/` output, framework templates, and
// extensionless scaffold files (`gitignore`) included.
const MARKER_SKIP = /(?:^|\/)(?:node_modules|coverage)\//
const MARKER_SCANNED =
  /(?:\.(?:[cm]?[jt]sx?|md|mdx|json|svelte|vue|astro|toml|ya?ml|txt|html|css|map)|(?:^|\/)[^./]+)$/
const REFERENCE_KINDS = new Set(["memory", "local-file", "noop", "fake", "replay", "ci"])
const AGENT_ROOTS = [
  "packages/agent",
  "packages/agent-app",
  "packages/agent-review",
  "packages/agent-protocol",
  "packages/agent-telemetry",
  "packages/coding-agent",
  "packages/testing",
] as const
const IMPLEMENTATION_RE =
  /\bexport\s+(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*(?:Store|Scheduler|Adapter|Reporter|Registry|Vault|Gateway))\b/g
const FUNCTION_RE =
  /\bexport\s+(?:async\s+)?function\s+([a-zA-Z][A-Za-z0-9_]*(?:Store|Scheduler|Adapter|Reporter|Registry|Vault|Gateway))\s*\(/g
const CONST_RE =
  /\bexport\s+const\s+([A-Z][A-Za-z0-9_]*(?:Store|Scheduler|Adapter|Reporter|Registry|Vault|Gateway))\s*=/g
const OPERATED_RE =
  /\b(?:tenant|rls|credential\s+vault|pricing|spend\s+enforcement|retained\s+corpus|managed\s+deployment|remote\s+fleet|hosted\s+discovery)\b/i
const FORBIDDEN_DEPENDENCY_RE =
  /(?:^|[-@])(openai|anthropic|google-generative|gemini|provider-sdk|credential|secret-vault|stripe|tenant|fleet)(?:$|[-@])/i

/** Bun returns platform-native separators from glob scans; inventory keys are always POSIX paths. */
function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/")
}

interface AllowlistEntry {
  readonly path: string
  readonly name: string
  readonly kind: string
  readonly port: string
}

interface AllowlistFile {
  readonly version: number
  readonly entries: readonly AllowlistEntry[]
}

function sourceFiles(directory: string, root = ROOT): string[] {
  if (!existsSync(resolve(root, directory))) return []
  const files: string[] = []
  for (const rawFile of new Bun.Glob("src/**/*").scanSync({
    cwd: resolve(root, directory),
    dot: true,
  })) {
    const file = normalizeRelativePath(rawFile)
    if (SKIP.test(file) || !/\.tsx?$/.test(file)) continue
    files.push(`${directory}/${file}`)
  }
  return files
}

function cleanSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

export function findPublicReferenceFailures(root = ROOT): readonly string[] {
  const failures: string[] = []
  let inventory: AllowlistFile
  try {
    inventory = JSON.parse(
      readFileSync(resolve(root, "scripts/public-agent-reference-allowlist.json"), "utf8"),
    ) as AllowlistFile
  } catch {
    return ["public reference allowlist is missing or invalid"]
  }
  if (inventory.version !== 1 || !Array.isArray(inventory.entries))
    failures.push("public reference allowlist version or entries are invalid")
  const entries = inventory.entries ?? []
  const byKey = new Map(entries.map((entry) => [`${entry.path}:${entry.name}`, entry]))
  for (const entry of entries) {
    if (!REFERENCE_KINDS.has(entry.kind))
      failures.push(`${entry.path}:${entry.name}: invalid reference kind`)
    if (typeof entry.port !== "string" || entry.port.length === 0)
      failures.push(`${entry.path}:${entry.name}: missing public port`)
  }
  for (const directory of AGENT_ROOTS) {
    for (const path of sourceFiles(directory, root)) {
      const source = readFileSync(resolve(root, path), "utf8")
      const clean = cleanSource(source)
      const names = new Set<string>()
      for (const match of clean.matchAll(IMPLEMENTATION_RE)) names.add(match[1]!)
      for (const match of clean.matchAll(FUNCTION_RE)) names.add(match[1]!)
      for (const match of clean.matchAll(CONST_RE)) names.add(match[1]!)
      for (const name of names) {
        const key = `${path}:${name}`
        if (!byKey.has(key))
          failures.push(`${key}: exported reference implementation is undeclared`)
        if (OPERATED_RE.test(clean))
          failures.push(`${path}: operated-depth implementation indicator`)
      }
    }
  }
  const manifests = [
    "agent",
    "agent-app",
    "agent-review",
    "agent-protocol",
    "agent-telemetry",
    "coding-agent",
    "testing",
  ]
  for (const packageName of manifests) {
    const path = resolve(root, `packages/${packageName}/package.json`)
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      const values = manifest[field]
      if (values === null || typeof values !== "object" || Array.isArray(values)) continue
      for (const dependency of Object.keys(values)) {
        if (FORBIDDEN_DEPENDENCY_RE.test(dependency))
          failures.push(
            `packages/${packageName}/package.json: prohibited provider or operated dependency ${dependency}`,
          )
      }
    }
  }
  return Object.freeze(failures)
}

async function exportsOf(path: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await Bun.file(path).text()) as { exports?: Record<string, unknown> }
  return manifest.exports ?? {}
}

/**
 * Every scanned file under `dirs` that holds one of `markers`. Dotfiles and dot-directories included:
 * a package can publish them (`.claude-plugin/plugin.json`), so they are where a marker could hide.
 */
export async function privateMarkerFailures(
  dirs: readonly string[],
  markers: readonly string[],
): Promise<string[]> {
  const failures: string[] = []
  for (const dir of dirs) {
    for (const rawFile of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })) {
      const file = normalizeRelativePath(rawFile)
      if (MARKER_SKIP.test(file) || !MARKER_SCANNED.test(file)) continue
      const text = (await Bun.file(`${dir}/${file}`).text()).toLowerCase()
      for (const marker of markers) {
        if (text.includes(marker.toLowerCase())) {
          failures.push(`${dir}/${file}: private marker present`)
          break
        }
      }
    }
  }
  return failures
}

export async function runPublicBoundary(
  options: { readonly release?: boolean } = {},
): Promise<readonly string[]> {
  const failures: string[] = [...findPublicReferenceFailures()]
  const publicPackageDirs = publishedPackages().map((pkg) => `packages/${pkg.dir}`)
  const markers = (process.env.PRIVATE_MARKERS ?? "")
    .split(",")
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0)
  // Release mode is asked for explicitly: a fork's pull request runs CI without repository secrets, so
  // CI alone cannot demand the markers. The release and main-branch jobs set RELEASE_MODE.
  const release = options.release === true || process.env.RELEASE_MODE === "1"
  if (release && markers.length === 0)
    failures.push("PRIVATE_MARKERS must be non-empty in release mode")
  failures.push(...(await privateMarkerFailures(publicPackageDirs, markers)))
  const coreExports = await exportsOf("packages/core/package.json")
  const imageExports = await exportsOf("packages/image/package.json")
  for (const [path, exportsMap, name] of [
    ["./channel", coreExports, "@nifrajs/core"],
    ["./data", coreExports, "@nifrajs/core"],
    ["./range", coreExports, "@nifrajs/core"],
    ["./og", imageExports, "@nifrajs/image"],
  ] as const) {
    if (!(path in exportsMap)) failures.push(`${name}: missing public export ${path}`)
  }
  for (const file of [
    "packages/core/src/channel.ts",
    "packages/core/src/data.ts",
    "packages/core/src/range.ts",
    "packages/image/src/og.ts",
  ]) {
    const source = await Bun.file(file).text()
    if (/\bfrom\s+["'](?:node|bun):/.test(source))
      failures.push(`${file}: edge seam imports a runtime-specific builtin`)
  }
  failures.push(...(await findAgentBoundaryFailures()))
  return Object.freeze(failures)
}

if (import.meta.main) {
  const failures = await runPublicBoundary({ release: process.env.RELEASE_MODE === "1" })
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`)
    process.exit(1)
  }
  const markers = (process.env.PRIVATE_MARKERS ?? "")
    .split(",")
    .filter((value) => value.trim().length > 0)
  console.log(
    `✓ public boundary: ${publishedPackages().length} packages, ${markers.length === 0 ? "marker scan skipped (PRIVATE_MARKERS unset)" : "no markers"}, seams exported`,
  )
}
