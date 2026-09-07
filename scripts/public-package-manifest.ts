import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

export type PublishValidation = "library" | "publint-only"

export interface PublicPackageSpec {
  readonly dir: string
  readonly publishValidation: PublishValidation
}

/**
 * The explicit public package allowlist and its release validation profile.
 *
 * Keep this list here rather than in the publish script: docs, type indexes, changeset coverage,
 * public/private checks, and release validation must agree on the same package inventory. A package
 * manifest that is public but missing from this list is still discovered by `publishedPackages()` so
 * the release gate can report the omission instead of silently ignoring it.
 */
const LIBRARY_PACKAGE_DIRS = [
  "core",
  "client",
  "cache",
  "testing",
  "mcp",
  "schema",
  "middleware",
  "auth",
  "better-auth",
  "i18n",
  "image",
  "uploads",
  "storage",
  "node",
  "deno",
  "aws-lambda",
  "edge",
  "proxy",
  "runner",
  "env",
  "cron",
  "jobs",
  "otel",
  "agent-telemetry",
  "agent",
  "agent-protocol",
  "agent-app",
  "pi",
  "coding-agent",
  "devtools",
  "mock",
  "prompt",
  "mcp-db",
  "events",
  "web",
  "webmcp",
  "web-solid",
  "web-react",
  "web-vue",
  "web-preact",
  "web-vanilla",
  "islets",
  "island-trigger",
  "graphql",
  "a2a",
  "ag-ui",
] as const

const PUBLINT_ONLY_PACKAGE_DIRS = [
  "workers",
  "content",
  "create-nifra",
  "cli",
  "web-svelte",
  "nifra",
  "ts-plugin",
  "skills",
] as const

export const PUBLIC_PACKAGE_SPECS: readonly PublicPackageSpec[] = Object.freeze(
  [
    ...LIBRARY_PACKAGE_DIRS.map((dir) => ({ dir, publishValidation: "library" as const })),
    ...PUBLINT_ONLY_PACKAGE_DIRS.map((dir) => ({
      dir,
      publishValidation: "publint-only" as const,
    })),
  ].sort((a, b) => a.dir.localeCompare(b.dir)),
)

const SPEC_BY_DIR = new Map(PUBLIC_PACKAGE_SPECS.map((spec) => [spec.dir, spec]))

export type PackageManifest = Readonly<Record<string, unknown>>

/** Read one workspace package manifest without making callers repeat JSON/file handling. */
export function readPackageManifest(root: string, dir: string): PackageManifest | undefined {
  try {
    return JSON.parse(
      readFileSync(join(root, "packages", dir, "package.json"), "utf8"),
    ) as PackageManifest
  } catch {
    return undefined
  }
}

/** The public package inventory consumed by docs, checks, and release validation. */
export interface PublishedPackage {
  readonly dir: string
  readonly name: string
  readonly version?: string
  readonly publishValidation: PublishValidation
}

/** Read the published package inventory from package manifests, in stable directory order. */
export function publishedPackages(root: string = ROOT): readonly PublishedPackage[] {
  const out: PublishedPackage[] = []
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = readPackageManifest(root, entry.name)
    if (manifest === undefined) continue
    if (manifest.private === true || typeof manifest.name !== "string") continue
    out.push({
      dir: entry.name,
      name: manifest.name,
      ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
      // Unknown public packages remain visible to the release gate as a library profile; the
      // explicit allowlist check then fails closed until a maintainer classifies the package here.
      publishValidation: SPEC_BY_DIR.get(entry.name)?.publishValidation ?? "library",
    })
  }
  return Object.freeze(out.sort((a, b) => a.dir.localeCompare(b.dir)))
}

export function publishedPackageCount(root: string = ROOT): number {
  return publishedPackages(root).length
}
