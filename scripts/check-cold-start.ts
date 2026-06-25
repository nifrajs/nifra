/**
 * Cold-start gate — the path a brand-new external user takes: `bun create nifra` → `bun install` →
 * `bun run build`. Two "good" releases shipped broken HERE while the package-level gates were green:
 *
 *   - alpha.1/alpha.2 leaked `workspace:*` into published deps (now caught by check-publish's
 *     packed-manifest gate); and
 *   - alpha.4's create-nifra templates pinned `@nifrajs/*` at `^0.1.0` — a caret range that EXCLUDES
 *     the only-published prerelease `0.1.0-alpha.4` — so every scaffolded app failed `bun install`
 *     ("No version matching ^0.1.0 … but package exists"). publint/attw/typecheck never look at the
 *     templates, so nothing caught it.
 *
 * This gate closes that class with two layers:
 *
 *   1. STATIC (always, fast, offline) — every template's internal dep range (`@nifrajs/*`, `nifra`,
 *      `create-nifra`) must be SATISFIED by the monorepo's current version of that package, with
 *      prerelease awareness. `Bun.semver.satisfies("0.1.0-alpha.4", "^0.1.0")` is false → the exact
 *      bug. `^0.1.0-alpha.4` is true → the fix. This is the must-have.
 *
 *   2. FUNCTIONAL (needs `bun run build` first) — pack every publishable package from the CURRENT
 *      source, scaffold `template-site`, force its whole `@nifrajs` tree to the packed tarballs via
 *      `overrides`, then `bun install` + `bun run build`. Catches a template that imports a removed
 *      API or otherwise won't install/build against the artifacts we're about to ship.
 *
 *   bun run scripts/check-cold-start.ts
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { $ } from "bun"

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
const templateDirs = readdirSync(CREATE_NIFRA, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("template"))
  .map((e) => e.name)

for (const tpl of templateDirs) {
  const m = readJson(join(CREATE_NIFRA, tpl, "package.json"))
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
    // these static files. Flag it — a scaffolded app can't resolve a `workspace:` dep.
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

// ── Layer 2: FUNCTIONAL scaffold → install → build (against the PACKED current source) ─────────────
console.log("\n=== cold-start: functional scaffold → install → build (template-site) ===")
const work = mkdtempSync(join(tmpdir(), "nifra-cold-start-"))
try {
  const tarballs = join(work, "tarballs")
  await $`mkdir -p ${tarballs}`.quiet()

  // Pack every publishable package from the current (built) source. `bun pm pack` rewrites `workspace:`
  // → the concrete version, exactly as publish would — so we're testing the would-be-published artifacts.
  const tarballByName = new Map<string, string>()
  let packFailed = false
  for (const { name, dir } of publishable) {
    const packed = await $`bun pm pack --destination ${tarballs}`.cwd(dir).nothrow().quiet()
    if (packed.exitCode !== 0) {
      console.error(
        `✗ pack ${name} failed — did you run \`bun run build\` first? (exit ${packed.exitCode})`,
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
      // The char right after `<slug>-` must be a digit (the version) — else `nifrajs-web-` would also
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
    // Scaffold template-site (the create-nifra CLI just copies this dir) into the work area.
    const app = join(work, "app")
    cpSync(join(CREATE_NIFRA, "template-site"), app, { recursive: true })

    // Force the WHOLE @nifrajs tree to the packed tarballs via `overrides` — so the template builds
    // against the current source, not whatever is on npm. (Layer 1 already validated the pin ranges.)
    const appPkg = readJson(join(app, "package.json")) as Manifest & {
      overrides?: Record<string, string>
    }
    appPkg.overrides = appPkg.overrides ?? {}
    for (const [name, tgz] of tarballByName) appPkg.overrides[name] = `file:${tgz}`
    writeFileSync(join(app, "package.json"), `${JSON.stringify(appPkg, null, 2)}\n`)

    const install = await $`bun install`.cwd(app).nothrow()
    if (install.exitCode !== 0) {
      failures += 1
      console.error(`✗ scaffolded template-site: bun install failed (exit ${install.exitCode})`)
    } else {
      const build = await $`bun run build`.cwd(app).nothrow()
      if (build.exitCode !== 0) {
        failures += 1
        console.error(`✗ scaffolded template-site: bun run build failed (exit ${build.exitCode})`)
      } else {
        console.log(
          "✓ scaffolded template-site installs + builds against the packed current source",
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
console.log("\n✓ cold-start gate: templates install + build for a fresh external user")
