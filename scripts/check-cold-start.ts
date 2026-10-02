/**
 * Cold-start gate - the path a brand-new external user takes: `bun create nifra` → `bun install` →
 * `bun run build` + `bun run check`. Two "good" releases shipped broken HERE while package-level gates were green:
 *
 *   - alpha.1/alpha.2 leaked `workspace:*` into published deps (now caught by check-publish's
 *     packed-manifest gate); and
 *   - alpha.4's create-nifra templates pinned `@nifrajs/*` at `^0.1.0` - a caret range that EXCLUDES
 *     the only-published prerelease `0.1.0-alpha.4` - so every scaffolded app failed `bun install`
 *     ("No version matching ^0.1.0 … but package exists"). publint/attw/typecheck never look at the
 *     templates, so nothing caught it.
 *
 * This gate closes that class with two layers:
 *
 *   1. STATIC (always, fast, offline) - every template's internal dep range (`@nifrajs/*`, `nifra`,
 *      `create-nifra`) must be SATISFIED by the monorepo's current version of that package, with
 *      prerelease awareness. `Bun.semver.satisfies("0.1.0-alpha.4", "^0.1.0")` is false → the exact
 *      bug. `^0.1.0-alpha.4` is true → the fix. This is the must-have.
 *
 *   2. FUNCTIONAL (needs `bun run build` first) - pack every publishable package from the CURRENT
 *      source, scaffold a React site and ISR app, force their whole `@nifrajs` tree to the packed
 *      tarballs via `overrides`, then install, build, and run each app's check script. A successful
 *      build alone can hide missing ambient types or invalid capability assurance rules.
 *
 *   bun run scripts/check-cold-start.ts
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { $ } from "bun"
import { scaffold } from "../packages/create-nifra/src/cli.ts"
import { FRAMEWORK_IDS, FRAMEWORK_SPECS } from "../packages/create-nifra/src/scaffold/frameworks.ts"
import { renderPackageJson } from "../packages/create-nifra/src/scaffold/site-files.ts"
import { DEPLOY_TARGETS } from "../packages/create-nifra/src/scaffold/targets.ts"

const ROOT = resolve(import.meta.dir, "..")
const PKGS_DIR = join(ROOT, "packages")
const CREATE_NIFRA = join(PKGS_DIR, "create-nifra")

interface Manifest {
  name?: string
  version?: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const readJson = (p: string): Manifest => JSON.parse(readFileSync(p, "utf8")) as Manifest

// ── The monorepo's current versions, keyed by published package name. ──
const versionByName = new Map<string, string>()
const publishable: Array<{ name: string; dir: string }> = []
for (const entry of readdirSync(PKGS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(PKGS_DIR, entry.name)
  let m: Manifest
  try {
    m = readJson(join(dir, "package.json"))
  } catch {
    continue
  }
  if (m.name && m.version) {
    versionByName.set(m.name, m.version)
    if (m.private !== true) publishable.push({ name: m.name, dir })
  }
}

const isInternal = (dep: string): boolean =>
  dep.startsWith("@nifrajs/") || dep === "nifra" || dep === "create-nifra"

let failures = 0

// ── Layer 1: STATIC pin satisfiability ───────────────────────────────────────────────────────────
console.log("=== cold-start: template pin satisfiability ===")
// A site scaffold's manifest is GENERATED, so reading directories would silently stop covering the
// five templates most people scaffold - the pins would go unchecked while this still reported success.
// Both sources feed the same loop: the copied templates' files, and the model's output.
const manifests: Array<{ label: string; manifest: Manifest }> = []
for (const entry of readdirSync(CREATE_NIFRA, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("template")) continue
  const file = join(CREATE_NIFRA, entry.name, "package.json")
  if (existsSync(file)) manifests.push({ label: entry.name, manifest: readJson(file) })
}
// Each deploy target adds its own runtime packages, so every framework x target pair is checked.
for (const id of FRAMEWORK_IDS) {
  const spec = FRAMEWORK_SPECS[id]
  if (spec === undefined) continue
  for (const target of DEPLOY_TARGETS) {
    manifests.push({
      label: `site scaffold (--framework ${id} --target ${target})`,
      manifest: JSON.parse(
        renderPackageJson(spec, { target, docker: false, name: "app" }),
      ) as Manifest,
    })
  }
}

for (const { label: tpl, manifest: m } of manifests) {
  const deps = { ...(m.dependencies ?? {}), ...(m.devDependencies ?? {}) }
  const bad: string[] = []
  for (const [dep, range] of Object.entries(deps)) {
    if (!isInternal(dep)) continue
    const current = versionByName.get(dep)
    if (current === undefined) {
      bad.push(`${dep}="${range}" → no such monorepo package`)
      continue
    }
    // `workspace:` shouldn't appear in a shipped template; the publish rewrite is for real packages, not
    // these static files. Flag it - a scaffolded app can't resolve a `workspace:` dep.
    if (range.startsWith("workspace:")) {
      bad.push(
        `${dep}="${range}" → workspace: protocol in a template (unresolvable for an external app)`,
      )
      continue
    }
    if (!Bun.semver.satisfies(current, range)) {
      bad.push(
        `${dep}="${range}" does NOT satisfy the current ${current} (caret excludes the prerelease?)`,
      )
    }
  }
  if (bad.length > 0) {
    failures += 1
    console.error(`✗ ${tpl}: ${bad.length} unsatisfiable pin(s):`)
    for (const b of bad) console.error(`    ${b}`)
  } else {
    console.log(`✓ ${tpl}: internal pins satisfy current versions`)
  }
}

// ── Layer 2: FUNCTIONAL scaffold → install → build → check (PACKED current source) ────────────────
console.log("\n=== cold-start: functional scaffold → install → build → check (site + ISR) ===")
const work = mkdtempSync(join(tmpdir(), "nifra-cold-start-"))
try {
  const tarballs = join(work, "tarballs")
  await $`mkdir -p ${tarballs}`.quiet()

  // Pack every publishable package from the current (built) source. `bun pm pack` rewrites `workspace:`
  // → the concrete version, exactly as publish would - so we're testing the would-be-published artifacts.
  const tarballByName = new Map<string, string>()
  let packFailed = false
  for (const { name, dir } of publishable) {
    const packed = await $`bun pm pack --destination ${tarballs}`.cwd(dir).nothrow().quiet()
    if (packed.exitCode !== 0) {
      console.error(
        `✗ pack ${name} failed - did you run \`bun run build\` first? (exit ${packed.exitCode})`,
      )
      packFailed = true
      break
    }
  }
  // Map each package name → its tarball (filename is `<name-with-+>-<version>.tgz` for scoped pkgs).
  if (!packFailed) {
    const files = (await $`ls ${tarballs}`.text()).trim().split("\n").filter(Boolean)
    for (const { name } of publishable) {
      const slug = name.replace("@", "").replace("/", "-")
      // The char right after `<slug>-` must be a digit (the version) - else `nifrajs-web-` would also
      // match `nifrajs-web-react-….tgz` and `@nifrajs/web` would get the wrong tarball.
      const file = files.find(
        (f) =>
          f.startsWith(`${slug}-`) && /\d/.test(f.charAt(slug.length + 1)) && f.endsWith(".tgz"),
      )
      if (file) tarballByName.set(name, join(tarballs, file))
    }
  }

  if (packFailed) {
    failures += 1
  } else {
    for (const template of ["site", "isr"] as const) {
      const app = join(work, template)
      await scaffold({ target: app, template })

      // Pin the entire Nifra tree to the artifacts being verified, including transitive dependencies.
      const appPkg = readJson(join(app, "package.json")) as Manifest & {
        overrides?: Record<string, string>
      }
      appPkg.overrides = appPkg.overrides ?? {}
      for (const [name, tgz] of tarballByName) appPkg.overrides[name] = `file:${tgz}`
      writeFileSync(join(app, "package.json"), `${JSON.stringify(appPkg, null, 2)}\n`)

      const install = await $`bun install`.cwd(app).nothrow()
      if (install.exitCode !== 0) {
        failures += 1
        console.error(`✗ ${template} scaffold: bun install failed (exit ${install.exitCode})`)
        continue
      }
      const build = await $`bun run build`.cwd(app).nothrow()
      const check = await $`bun run check`.cwd(app).nothrow()
      if (build.exitCode !== 0) {
        failures += 1
        console.error(`✗ ${template} scaffold: bun run build failed (exit ${build.exitCode})`)
      }
      if (check.exitCode !== 0) {
        failures += 1
        console.error(`✗ ${template} scaffold: bun run check failed (exit ${check.exitCode})`)
      }
      if (build.exitCode === 0 && check.exitCode === 0) {
        console.log(
          `✓ ${template} scaffold installs + builds + checks against packed current source`,
        )
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} cold-start check(s) failed`)
  process.exit(1)
}
console.log("\n✓ cold-start gate: templates install + build + check for a fresh external user")
