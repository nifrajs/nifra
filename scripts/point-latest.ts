/**
 * After `changeset publish` (which publishes to the `beta` dist-tag in prerelease mode),
 * point `latest` at the same versions so `npm install nifra` gets the current beta.
 * Run only in CI via `changeset:publish`; skip locally unless NPM_TOKEN is set.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { $ } from "bun"

if (!process.env["NPM_TOKEN"]) {
  console.log("point-latest: no NPM_TOKEN — skipping (local run)")
  process.exit(0)
}

const ROOT = resolve(import.meta.dir, "..")
const PKGS_DIR = join(ROOT, "packages")

interface Pkg {
  name?: string
  version?: string
  private?: boolean
}

for (const entry of readdirSync(PKGS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  let pkg: Pkg
  try {
    pkg = JSON.parse(readFileSync(join(PKGS_DIR, entry.name, "package.json"), "utf8")) as Pkg
  } catch {
    continue
  }
  if (!pkg.name || !pkg.version || pkg.private) continue
  const result = await $`npm dist-tag add ${pkg.name}@${pkg.version} latest`.nothrow()
  if (result.exitCode === 0) {
    console.log(`✓ latest → ${pkg.name}@${pkg.version}`)
  } else {
    console.error(`✗ failed: ${pkg.name}@${pkg.version}`)
  }
}
