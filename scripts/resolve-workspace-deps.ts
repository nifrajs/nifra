/**
 * Resolve `workspace:` internal dependency ranges to concrete sibling versions, in place, across
 * every package.json — run immediately BEFORE `changeset publish`.
 *
 * `changeset publish` shells `npm publish`, and npm does NOT rewrite the `workspace:` protocol (only
 * bun/pnpm/yarn publish do). Without this step `workspace:*` ships verbatim to npm and every package
 * is uninstallable for external users (`npm error EUNSUPPORTEDPROTOCOL — workspace:*`) — the exact
 * alpha.1/alpha.2 + beta.0 break the manual bun-pack lockstep used to avoid. This automates the
 * rewrite: `workspace:*`/bare → the exact sibling version (lockstep packages stay perfectly in sync);
 * `workspace:^`/`workspace:~` keep their range operator.
 *
 * Scope is the three blocks a consumer actually resolves — `dependencies`, `peerDependencies`,
 * `optionalDependencies`. `devDependencies` are left alone: npm never installs a dependency's devDeps,
 * so a `workspace:` there is inert (e.g. the internal-only `@nifrajs/test-utils`).
 *
 * CI-only (wired into `changeset:publish`). It rewrites package.json on disk via a JSON round-trip;
 * the release runner uses a fresh checkout per run so the mutation is discarded, and the result is a
 * published manifest, not a committed/linted file. Pass `--check` to validate (exit 1 on any
 * `workspace:` that can't be resolved) without writing — used by the publish-readiness gate.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

const checkOnly = process.argv.includes("--check")
const BLOCKS = ["dependencies", "peerDependencies", "optionalDependencies"] as const

// Expand the root `workspaces` globs to every package.json (so the version map is complete — incl.
// internal/* like @nifrajs/test-utils — and an internal dep can never be mistaken for external).
const workspaces = (JSON.parse(readFileSync("package.json", "utf8")).workspaces ?? []) as string[]
const pkgFiles = new Set<string>(["package.json"])
for (const pattern of workspaces) {
  if (pattern.endsWith("/*")) {
    const dir = pattern.slice(0, -2)
    if (existsSync(dir))
      for (const sub of readdirSync(dir)) pkgFiles.add(`${dir}/${sub}/package.json`)
  } else {
    pkgFiles.add(`${pattern}/package.json`)
  }
}
const files = [...pkgFiles].filter((f) => existsSync(f))

// name → version for every workspace package (private included, so internal links resolve).
const versions = new Map<string, string>()
for (const f of files) {
  const p = JSON.parse(readFileSync(f, "utf8")) as { name?: string; version?: string }
  if (p.name !== undefined && p.version !== undefined) versions.set(p.name, p.version)
}

let changed = 0
const unresolved: string[] = []
for (const f of files) {
  const json = JSON.parse(readFileSync(f, "utf8")) as Record<string, Record<string, string>>
  let touched = false
  for (const block of BLOCKS) {
    const deps = json[block]
    if (deps === undefined) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (!spec.startsWith("workspace:")) continue
      const v = versions.get(name)
      if (v === undefined) {
        unresolved.push(`${f}: ${block}.${name}="${spec}" → not a workspace package`)
        continue
      }
      const op = spec.slice("workspace:".length).charAt(0) // "*" | "^" | "~" | "" | a digit
      deps[name] = op === "^" || op === "~" ? `${op}${v}` : v // *, bare, or pinned → exact (sync)
      touched = true
    }
  }
  if (touched) {
    changed++
    if (!checkOnly) writeFileSync(f, `${JSON.stringify(json, null, 2)}\n`)
  }
}

if (unresolved.length > 0) {
  console.error(
    `✗ unresolvable workspace: deps in a published block:\n  ${unresolved.join("\n  ")}`,
  )
  process.exit(1)
}
console.log(
  checkOnly
    ? `✓ every workspace: dep resolves to a known sibling (${changed} file(s) would change)`
    : `resolved workspace: deps → concrete versions in ${changed} package.json file(s)`,
)
