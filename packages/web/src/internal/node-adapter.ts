import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** A package as installed: its directory and the version its package.json declares. */
export interface InstalledPackage {
  readonly dir: string
  readonly version: string
}

/** The `version` a package.json declares, or `undefined` when it declares none. */
function manifestVersion(path: string | URL): string | undefined {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"))
  return typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
    ? manifest.version
    : undefined
}

/**
 * The copy of `name` a module in `fromDir` imports: the first `node_modules/<name>` walking up, as
 * both bundlers resolve a bare specifier. Walked rather than `Bun.resolveSync`, which keeps its first
 * answer for the life of the process.
 */
export function installedPackage(name: string, fromDir: string): InstalledPackage | undefined {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json")
    if (existsSync(manifest)) {
      const version = manifestVersion(manifest)
      return version === undefined ? undefined : { dir: dirname(manifest), version }
    }
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * Why a `--target node` build whose server entry is generated in `workDir` must stop before
 * bundling, or `undefined`. The entry is written for the `@nifrajs/node` of this package's release and
 * the bundle inlines whichever copy is installed: a 5.3 adapter built cleanly, then threw at startup
 * on the static mounts.
 */
export function nodeAdapterRefusal(
  workDir: string,
  // src/internal/ and dist/internal/ both sit two levels below the package root.
  webVersion = manifestVersion(new URL("../../package.json", import.meta.url)),
): string | undefined {
  const adapter = installedPackage("@nifrajs/node", workDir)
  if (adapter === undefined || webVersion === undefined) return undefined
  if (Bun.semver.order(adapter.version, webVersion) >= 0) return undefined
  return (
    `[nifra/web] --target node would bundle @nifrajs/node ${adapter.version} (${adapter.dir}), older ` +
    `than @nifrajs/web ${webVersion}. The server entry is generated for the adapter of the same ` +
    "release, and an older one can fail when the server starts. Upgrade the nifra packages " +
    `together: nifra upgrade ${webVersion}`
  )
}
