/**
 * After `changeset publish` (which publishes to the `beta` dist-tag in prerelease mode),
 * point `latest` at the same versions so `npm install nifra` gets the current beta.
 * Run only in CI via `changeset:publish`; skip locally unless NPM_TOKEN is set.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { $ } from "bun"

interface Pkg {
  name?: string
  version?: string
  private?: boolean
}

/** Whether `latest` should move to the local version: never sideways or back to an older release. */
export function shouldPointLatest(local: string, currentLatest: string | undefined): boolean {
  return currentLatest === undefined || Bun.semver.order(local, currentLatest) > 0
}

async function main(): Promise<void> {
  if (!process.env.NPM_TOKEN) {
    console.log("point-latest: no NPM_TOKEN - skipping (local run)")
    return
  }
  const pkgsDir = join(resolve(import.meta.dir, ".."), "packages")
  const failed: string[] = []
  for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let pkg: Pkg
    try {
      pkg = JSON.parse(readFileSync(join(pkgsDir, entry.name, "package.json"), "utf8")) as Pkg
    } catch {
      continue
    }
    if (!pkg.name || !pkg.version || pkg.private) continue
    const spec = `${pkg.name}@${pkg.version}`
    const view = await $`npm view ${pkg.name} dist-tags.latest`.nothrow().quiet()
    if (view.exitCode !== 0) {
      console.error(`✗ could not read the latest tag: ${pkg.name}`)
      failed.push(spec)
      continue
    }
    const current = view.stdout.toString().trim() || undefined
    if (!shouldPointLatest(pkg.version, current)) {
      console.log(`- latest stays ${pkg.name}@${current}`)
      continue
    }
    const result = await $`npm dist-tag add ${spec} latest`.nothrow()
    if (result.exitCode === 0) console.log(`✓ latest → ${spec}`)
    else {
      console.error(`✗ failed: ${spec}`)
      failed.push(spec)
    }
  }
  if (failed.length > 0) {
    console.error(`point-latest: ${failed.length} package(s) not re-pointed: ${failed.join(", ")}`)
    process.exit(1)
  }
}

if (import.meta.main) await main()
