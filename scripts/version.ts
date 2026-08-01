/**
 * Wraps `changeset version` and re-syncs the version refs `changeset version` itself leaves untouched:
 *   - the two hardcoded CLI version constants - cli.ts reads no package.json at runtime, mcp-http.ts runs
 *     on the edge with no fs, so both hardcode the version; and
 *   - the create-nifra templates' `@nifrajs/*` / `nifra` dep pins + the `--auth` injected
 *     `@nifrajs/better-auth` range. These are plain template/source files (not workspace deps), so
 *     changeset skips them, and a missed bump ships templates that install the PREVIOUS release - the
 *     1.0.0 cut shipped stale beta pins exactly this way.
 *
 * `check:publish` re-asserts every one of these matches, so a forgotten bump fails the publish gate
 * instead of shipping silently. (agent-files' MCP_CLI_VERSION is DERIVED from create-nifra's own version,
 * so it needs no rewrite here.) This keeps the "Version Packages" PR correct automatically.
 */
import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

execSync("changeset version", { stdio: "inherit" })

// Refresh the lockfile to record the just-bumped workspace versions. Without it the lockfile still pins
// the previous release, so `bun pm pack` resolves an internal `workspace:*` dep to the stale version -
// which fails the publish-consumer matrix, whose loopback registry only serves the newly-bumped tarballs.
execSync("bun install", { stdio: "inherit" })

const { version } = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
  version: string
}

// Hardcoded version literals in published source that read no package.json at runtime: the CLI
// constants (cli.ts / mcp-http.ts) and @nifrajs/core's exported `VERSION` (core runs on the edge - no
// fs - so it can't derive its own version). Under `fixed` versioning every package shares this version.
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

const CREATE_NIFRA = "packages/create-nifra"
const CREATE_NIFRA_SRC = `${CREATE_NIFRA}/src`

// The site scaffold's `package.json` is GENERATED from one constant, so its pin is a single rewrite
// rather than a sweep - and `scaffold-composition.test.ts` fails when that constant drifts from the
// version being published, which is the check this whole step never had.
{
  const file = `${CREATE_NIFRA_SRC}/scaffold/frameworks.ts`
  const src = readFileSync(file, "utf8")
  writeFileSync(file, src.replace(/(NIFRA_DEP_RANGE = ")[~^]?[^"]+(")/, `$1^${version}$2`))
  console.log(`✓ ${file} → ^${version}`)
}

// create-nifra template pins: rewrite every internal `@nifrajs/*` / `nifra` dep to `^<version>`, leaving
// third-party pins (react, vite, …) alone. Global flag: each template lists several internal deps.
// The four `template-site-<framework>` directories no longer carry a `package.json` of their own once
// the generator owns it; this still covers the templates that are plain copies.
const NIFRA_DEP = /("(?:@nifrajs\/[a-z0-9-]+|nifra)":\s*")[~^]?[^"]+(")/g
for (const dir of readdirSync(CREATE_NIFRA).filter((d) => d.startsWith("template"))) {
  const file = `${CREATE_NIFRA}/${dir}/package.json`
  if (!existsSync(file)) continue // a composed template: its manifest comes from the model above
  const src = readFileSync(file, "utf8")
  writeFileSync(file, src.replace(NIFRA_DEP, `$1^${version}$2`))
  console.log(`✓ ${file} → ^${version}`)
}

// The `--auth better-auth` injected `@nifrajs/better-auth` range in auth.ts's AUTH_PRESETS (its sibling
// `better-auth` peer pin is a third-party version - left untouched).
{
  const file = `${CREATE_NIFRA}/src/auth.ts`
  const src = readFileSync(file, "utf8")
  writeFileSync(file, src.replace(/("@nifrajs\/better-auth":\s*")[~^]?[^"]+(")/, `$1^${version}$2`))
  console.log(`✓ ${file} → ^${version}`)
}

// api-reference.md, the per-package LLM.md cards AND the llms corpora embed exported signatures
// verbatim - including core's `VERSION` literal just rewritten above, which types.json stores as the
// literal type `export declare const VERSION: "2.2.0"` - so the version bump makes all three stale and
// `check:api` / `check:cards` / `check:llms` fail on the release commit unless we regenerate here. The
// "chore: version packages" commit is made by CI and never runs the pre-commit hook, so we regenerate
// explicitly.
//
// `gen:llms` was missing from this list, and the effect was not a cosmetic diff: every "Version
// Packages" PR failed CI on a stale types.json, and since Release only publishes after CI concludes
// successfully, nothing could ship. A generator that reads a rewritten literal has to be regenerated
// here - adding one to `gen:*` means adding it to this line too.
//
// Build FIRST. The generators read each `src/index.ts` via the TS compiler API and resolve package
// subpaths through their built declarations. The CI `check` job builds before `check:api`, so we must
// match it - buildless regeneration can silently omit re-exported sections and drift from CI (for
// `gen:llms` specifically it guts types.json, whose tell is "0 types from 1 built packages").
execSync("bun run build && bun run gen:api && bun run gen:cards && bun run gen:llms", {
  stdio: "inherit",
})
console.log(
  "✓ built + regenerated api-reference.md, LLM.md cards and llms corpora for the new version",
)

// The committed site-scaffold snapshot embeds the internal `@nifrajs/*` dep pins just rewritten to
// `^<version>` above, so it goes stale on every bump exactly like the generated docs - and its test
// (`scaffold-snapshot.test.ts`) then fails the "Version Packages" commit. Regenerate it through the
// test's own UPDATE path so the release commit stays green without a manual step.
execSync(
  "UPDATE_SCAFFOLD_SNAPSHOT=1 bun test packages/create-nifra/test/scaffold-snapshot.test.ts",
  {
    stdio: "inherit",
  },
)
console.log("✓ regenerated the site scaffold snapshot for the new version")
