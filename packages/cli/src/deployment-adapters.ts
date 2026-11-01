import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const BASE_TARGETS = new Set(["bun", "node", "deno", "cloudflare", "vercel", "static"])
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i

const isBaseTarget = (value: unknown): value is DeploymentAdapterMetadata["baseTarget"] =>
  typeof value === "string" && BASE_TARGETS.has(value)

export interface DeploymentAdapterMetadata {
  readonly apiVersion: 1
  readonly id: string
  readonly baseTarget: "bun" | "node" | "deno" | "cloudflare" | "vercel" | "static"
  readonly packageName: string
}

/** Parse package JSON as a record and treat unreadable or malformed manifests as absent. */
function readRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: JSON.parse is assigned to unknown and the object/null/array checks above establish the record shape.
        (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Read only package metadata, never importing app config or adapter code. `nifra port` uses this to
 * map a custom target id to the built-in runtime its adapter wraps.
 */
export function readDeploymentAdapterMetadata(
  appRoot: string,
  id: string,
): DeploymentAdapterMetadata | undefined {
  const rootPackage = readRecord(resolve(appRoot, "package.json"))
  if (rootPackage === undefined) return undefined
  const dependencyNames = new Set<string>()
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = rootPackage[field]
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))
      continue
    for (const name of Object.keys(dependencies))
      if (PACKAGE_NAME.test(name)) dependencyNames.add(name)
  }

  const packageRoots: string[] = []
  let directory = resolve(appRoot)
  for (;;) {
    packageRoots.push(directory)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const matches: DeploymentAdapterMetadata[] = []
  for (const packageName of dependencyNames) {
    for (const packageRoot of packageRoots) {
      const manifestPath = resolve(packageRoot, "node_modules", packageName, "package.json")
      if (!existsSync(manifestPath)) continue
      const manifest = readRecord(manifestPath)
      const nifra = manifest?.nifra
      const declaration =
        typeof nifra === "object" && nifra !== null && !Array.isArray(nifra)
          ? Reflect.get(nifra, "deploymentAdapter")
          : undefined
      if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration))
        break
      const apiVersion: unknown = Reflect.get(declaration, "apiVersion")
      const adapterId: unknown = Reflect.get(declaration, "id")
      const baseTarget: unknown = Reflect.get(declaration, "baseTarget")
      if (
        apiVersion === 1 &&
        adapterId === id &&
        typeof adapterId === "string" &&
        /^[a-z][a-z0-9-]{1,62}$/.test(adapterId) &&
        isBaseTarget(baseTarget)
      ) {
        matches.push({
          apiVersion,
          id: adapterId,
          baseTarget,
          packageName,
        })
      }
      break
    }
  }
  if (matches.length > 1) {
    const targets = new Set(matches.map((match) => match.baseTarget))
    if (targets.size > 1)
      throw new Error(
        `[nifra] multiple installed adapters declare target "${id}" with different base targets`,
      )
  }
  return matches[0]
}
