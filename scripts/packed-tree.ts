/**
 * The `@nifrajs` tree exactly as the next release would publish it, for installing a scaffold against.
 *
 * Every publishable package is packed from this checkout's built source; `bun pm pack` rewrites
 * `workspace:` to the concrete version, as publish does. The fixed version group releases create-nifra
 * only alongside the packages built from the same commit, so a scaffold paired with these tarballs is
 * what a user receives - the last-published packages are not.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { $ } from "bun"

const PKGS_DIR = resolve(import.meta.dir, "../packages")

interface Manifest {
  name?: string
  version?: string
  private?: boolean
  overrides?: Record<string, string>
}
const readJson = (p: string): Manifest => JSON.parse(readFileSync(p, "utf8")) as Manifest

/** Pack every publishable package into `dest`. Needs `bun run build` first. Returns name → tarball. */
export async function packCurrentSource(dest: string): Promise<Map<string, string>> {
  mkdirSync(dest, { recursive: true })
  const names: string[] = []
  for (const entry of readdirSync(PKGS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(PKGS_DIR, entry.name)
    let m: Manifest
    try {
      m = readJson(join(dir, "package.json"))
    } catch {
      continue
    }
    if (!m.name || !m.version || m.private === true) continue
    const packed = await $`bun pm pack --destination ${dest}`.cwd(dir).nothrow().quiet()
    if (packed.exitCode !== 0) {
      throw new Error(
        `pack ${m.name} failed - did you run \`bun run build\` first? (exit ${packed.exitCode})`,
      )
    }
    names.push(m.name)
  }

  // Filename is `<name-with-+>-<version>.tgz` for scoped packages.
  const files = readdirSync(dest)
  const tarballByName = new Map<string, string>()
  for (const name of names) {
    const slug = name.replace("@", "").replace("/", "-")
    // The char right after `<slug>-` must be a digit (the version) - else `nifrajs-web-` would also
    // match `nifrajs-web-react-….tgz` and `@nifrajs/web` would get the wrong tarball.
    const file = files.find(
      (f) => f.startsWith(`${slug}-`) && /\d/.test(f.charAt(slug.length + 1)) && f.endsWith(".tgz"),
    )
    // An unmapped package would silently install from the registry instead - the skew this exists to rule out.
    if (file === undefined) throw new Error(`no tarball for ${name} in ${dest}`)
    tarballByName.set(name, join(dest, file))
  }
  return tarballByName
}

/** Force an app's whole `@nifrajs` tree, transitive dependencies included, to the packed tarballs. */
export function pinToPacked(app: string, tarballs: ReadonlyMap<string, string>): void {
  const file = join(app, "package.json")
  const pkg = readJson(file)
  pkg.overrides = pkg.overrides ?? {}
  for (const [name, tgz] of tarballs) pkg.overrides[name] = `file:${tgz}`
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}
