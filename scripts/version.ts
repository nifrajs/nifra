/**
 * Wraps `changeset version` and re-syncs the version refs `changeset version` itself leaves untouched:
 *   - the two hardcoded CLI version constants — cli.ts reads no package.json at runtime, mcp-http.ts runs
 *     on the edge with no fs, so both hardcode the version; and
 *   - the create-nifra templates' `@nifrajs/*` / `nifra` dep pins + the `--auth` injected
 *     `@nifrajs/better-auth` range. These are plain template/source files (not workspace deps), so
 *     changeset skips them, and a missed bump ships templates that install the PREVIOUS release — the
 *     1.0.0 cut shipped stale beta pins exactly this way.
 *
 * `check:publish` re-asserts every one of these matches, so a forgotten bump fails the publish gate
 * instead of shipping silently. (agent-files' MCP_CLI_VERSION is DERIVED from create-nifra's own version,
 * so it needs no rewrite here.) This keeps the "Version Packages" PR correct automatically.
 */
import { execSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"

execSync("changeset version", { stdio: "inherit" })

const { version } = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
  version: string
}

// Hardcoded version literals in published source that read no package.json at runtime: the CLI
// constants (cli.ts / mcp-http.ts) and @nifrajs/core's exported `VERSION` (core runs on the edge — no
// fs — so it can't derive its own version). Under `fixed` versioning every package shares this version.
const constants: Array<{ file: string; re: RegExp }> = [
  { file: "packages/cli/src/cli.ts", re: /(CLI_VERSION\s*=\s*)"[^"]+"/ },
  { file: "packages/cli/src/mcp-http.ts", re: /(const VERSION\s*=\s*)"[^"]+"/ },
  { file: "packages/core/src/index.ts", re: /(export const VERSION\s*=\s*)"[^"]+"/ },
]

for (const { file, re } of constants) {
  const src = readFileSync(file, "utf8")
  writeFileSync(file, src.replace(re, `$1"${version}"`))
  console.log(`✓ ${file} → ${version}`)
}

// create-nifra template pins: rewrite every internal `@nifrajs/*` / `nifra` dep to `^<version>`, leaving
// third-party pins (react, vite, …) alone. Global flag: each template lists several internal deps.
const NIFRA_DEP = /("(?:@nifrajs\/[a-z0-9-]+|nifra)":\s*")[~^]?[^"]+(")/g
const CREATE_NIFRA = "packages/create-nifra"
for (const dir of readdirSync(CREATE_NIFRA).filter((d) => d.startsWith("template"))) {
  const file = `${CREATE_NIFRA}/${dir}/package.json`
  const src = readFileSync(file, "utf8")
  writeFileSync(file, src.replace(NIFRA_DEP, `$1^${version}$2`))
  console.log(`✓ ${file} → ^${version}`)
}

// The `--auth better-auth` injected `@nifrajs/better-auth` range in auth.ts's AUTH_PRESETS (its sibling
// `better-auth` peer pin is a third-party version — left untouched).
{
  const file = `${CREATE_NIFRA}/src/auth.ts`
  const src = readFileSync(file, "utf8")
  writeFileSync(file, src.replace(/("@nifrajs\/better-auth":\s*")[~^]?[^"]+(")/, `$1^${version}$2`))
  console.log(`✓ ${file} → ^${version}`)
}

// api-reference.md + the per-package LLM.md cards embed exported signatures verbatim — including core's
// `VERSION` literal just rewritten above — so the version bump makes them stale and `check:api` /
// `check:cards` fail on the release commit unless we regenerate here. Both generators read each
// `src/index.ts` via the TS compiler API (SOURCE, no build), so this is safe to run in the changesets
// `version` step (which happens before the build). The pre-commit hook does the same for hand edits, but
// the "chore: version packages" commit is made by CI and never runs it.
execSync("bun run gen:api && bun run gen:cards", { stdio: "inherit" })
console.log("✓ regenerated api-reference.md + LLM.md cards for the new version")
