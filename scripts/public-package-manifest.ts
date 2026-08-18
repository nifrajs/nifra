import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/** The public package inventory consumed by docs and public/private checks. */
export interface PublishedPackage {
  readonly dir: string
  readonly name: string
  readonly version?: string
}

/** Read the published package inventory from package manifests, in stable directory order. */
export function publishedPackages(root: string = ROOT): readonly PublishedPackage[] {
  const out: PublishedPackage[] = []
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(
        readFileSync(join(root, "packages", entry.name, "package.json"), "utf8"),
      )
    } catch {
      continue
    }
    if (manifest.private === true || typeof manifest.name !== "string") continue
    out.push({
      dir: entry.name,
      name: manifest.name,
      ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    })
  }
  return Object.freeze(out.sort((a, b) => a.dir.localeCompare(b.dir)))
}

export function publishedPackageCount(root: string = ROOT): number {
  return publishedPackages(root).length
}
