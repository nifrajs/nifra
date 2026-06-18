/**
 * Publish-readiness gate: build every package, then validate each tarball with
 * `publint` (package.json/exports correctness) and `@arethetypeswrong/cli` (type
 * resolution across node/bundler). ESM-only by design, so attw runs the `esm-only`
 * profile (the `cjs-resolves-to-esm` warning is expected and ignored).
 *
 *   bun run scripts/check-publish.ts
 */
import { $ } from "bun"

// Library packages get publint + attw (type resolution). `create-nifra` is a CLI (bin,
// no library exports), so it gets publint only.
const LIBRARIES = [
  "core",
  "client",
  "schema",
  "middleware",
  "auth",
  "better-auth",
  "i18n",
  "image",
  "uploads",
  "node",
  "runner",
  "env",
  "cron",
  "otel",
  "web",
  "web-solid",
  "web-react",
  "web-vue",
  "web-preact",
  "web-vanilla",
  "islets",
] as const

let failures = 0

// Stray-scope gate: after the @nifra/* → @nifrajs/* rename, a single un-renamed import (`@nifra/core`)
// resolves to nothing for a consumer and silently breaks their `bun install` (real user report,
// 2026-06). The substring `@nifra/` never occurs inside `@nifrajs/` — the `js` sits before the slash —
// so this matches ONLY the dead scope. Scan all published source + manifests; fail loudly on any straggler.
const stray =
  await $`grep -rnE "@nifra/" packages --include='*.ts' --include='*.tsx' --include='*.json' --exclude-dir=node_modules --exclude-dir=dist`.nothrow()
if (stray.exitCode === 0) {
  console.error("\n✗ stray `@nifra/` scope found (rename to `@nifrajs/`):")
  console.error(stray.stdout.toString())
  failures += 1
} else {
  console.log("✓ no stray `@nifra/` scope")
}

await $`bun run build`
for (const pkg of LIBRARIES) {
  console.log(`\n=== @nifrajs/${pkg} ===`)
  // publint --level warning: suggestions are advisory, warnings/errors fail.
  const publint = await $`bunx publint --level warning packages/${pkg}`.nothrow()
  const attw =
    await $`bunx --bun @arethetypeswrong/cli --pack packages/${pkg} --profile esm-only`.nothrow()
  if (publint.exitCode !== 0 || attw.exitCode !== 0) {
    failures += 1
    console.error(`✗ @nifrajs/${pkg}: publint=${publint.exitCode} attw=${attw.exitCode}`)
  }
}

// `@nifrajs/deno` (Deno-native, ships TS — no dist), `create-nifra` (bin-only CLI), and
// `@nifrajs/web-svelte` get publint only: attw models Node/bundler type resolution, which doesn't apply
// to a Deno-consumed TS package, a CLI with no library exports, or a Svelte package whose `.svelte`
// components resolve through the consumer's Svelte toolchain (no `.d.ts` for `*.svelte`).
const PUBLINT_ONLY = [
  { name: "@nifrajs/deno", dir: "packages/deno" },
  { name: "@nifrajs/workers", dir: "packages/workers" },
  { name: "@nifrajs/content", dir: "packages/content" },
  { name: "create-nifra", dir: "packages/create-nifra" },
  { name: "@nifrajs/cli", dir: "packages/cli" },
  { name: "@nifrajs/web-svelte", dir: "packages/web-svelte" },
  // The unscoped `nifra` meta is a thin re-export of @nifrajs/core; publint validates its
  // package.json/exports (the real risk for a shim).
  { name: "nifra", dir: "packages/nifra" },
] as const
for (const { name, dir } of PUBLINT_ONLY) {
  console.log(`\n=== ${name} (publint only) ===`)
  const publint = await $`bunx publint --level warning ${dir}`.nothrow()
  if (publint.exitCode !== 0) {
    failures += 1
    console.error(`✗ ${name}: publint=${publint.exitCode}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} package(s) failed publish validation`)
  process.exit(1)
}
console.log("\n✓ all packages pass publint + attw")
