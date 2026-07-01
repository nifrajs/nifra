/**
 * Publish-readiness gate: build every package, then validate each tarball with
 * `publint` (package.json/exports correctness) and `@arethetypeswrong/cli` (type
 * resolution across node/bundler). ESM-only by design, so attw runs the `esm-only`
 * profile (the `cjs-resolves-to-esm` warning is expected and ignored).
 *
 *   bun run scripts/check-publish.ts
 */
import { $, Glob } from "bun"

// Library packages get publint + attw (type resolution). `create-nifra` is a CLI (bin,
// no library exports), so it gets publint only.
const LIBRARIES = [
  "core",
  "client",
  "cache",
  "testing",
  "mcp",
  "schema",
  "middleware",
  "auth",
  "better-auth",
  "i18n",
  "image",
  "uploads",
  "storage",
  "node",
  "runner",
  "env",
  "cron",
  "jobs",
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

// Publish-resolution gate: `changeset publish` shells `npm publish`, which does NOT rewrite the
// `workspace:` protocol — so `changeset:publish` runs resolve-workspace-deps first. This asserts every
// internal `workspace:` dep in a published block (dependencies/peer/optional) points to a known
// sibling, so that rewrite can't leave a `workspace:*` to ship to npm. (Packing here with `bun pm
// pack` rewrites workspace: for free and hid the alpha.1/2 + beta.0 EUNSUPPORTEDPROTOCOL break — npm
// publish does not, which is what actually ships.)
const resolveCheck = await $`bun run scripts/resolve-workspace-deps.ts --check`.nothrow()
if (resolveCheck.exitCode !== 0) {
  failures += 1
  console.error(
    "✗ unresolvable workspace: dep(s) in a published block — publish would leak workspace:",
  )
}
// ...and the publish script must actually RUN the resolver before `changeset publish` — removing it
// would silently reship the workspace: leak (npm publish does not rewrite it). Guard the wiring.
const publishScript = (
  JSON.parse(await Bun.file("package.json").text()) as { scripts: Record<string, string> }
).scripts["changeset:publish"]
if (publishScript === undefined || !publishScript.includes("resolve-workspace-deps")) {
  failures += 1
  console.error("✗ changeset:publish must run resolve-workspace-deps before `changeset publish`")
} else {
  console.log("✓ changeset:publish resolves workspace: deps before publishing")
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

// ── Packed-manifest gate: source package.json pins internal deps with `workspace:*` (correct for local
// dev); the publish tool MUST rewrite that to a concrete version before it hits npm. A raw publish that
// skipped the rewrite shipped `"@nifrajs/schema": "workspace:*"` in alpha.1/alpha.2 → 10 packages (incl.
// the unscoped `nifra` entry point) were uninstallable for every external consumer
// (`@nifrajs/schema@workspace:* failed to resolve`). publint is monorepo-aware and does NOT flag this. So
// we pack each package exactly as `bun publish` does and assert NO `workspace:` survives in any consumer
// dependency block — the single invariant that, had it run, would have caught the break at publish time.
console.log("\n=== packed-manifest workspace: gate ===")
const ALL_DIRS = [...LIBRARIES.map((p) => `packages/${p}`), ...PUBLINT_ONLY.map((p) => p.dir)]
for (const dir of ALL_DIRS) {
  const tmp = (await $`mktemp -d`.text()).trim()
  const packed = await $`bun pm pack --destination ${tmp}`.cwd(dir).nothrow().quiet()
  const tgz = (await $`ls ${tmp}`.text())
    .trim()
    .split("\n")
    .find((f) => f.endsWith(".tgz"))
  if (packed.exitCode !== 0 || tgz === undefined) {
    failures += 1
    console.error(`✗ ${dir}: bun pm pack failed (exit ${packed.exitCode})`)
    await $`rm -rf ${tmp}`.nothrow().quiet()
    continue
  }
  const manifest = JSON.parse(await $`tar -xzOf ${tmp}/${tgz} package/package.json`.text()) as {
    name: string
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  await $`rm -rf ${tmp}`.nothrow().quiet()
  const leaks: string[] = []
  for (const block of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [name, spec] of Object.entries(manifest[block] ?? {})) {
      if (spec.includes("workspace:")) leaks.push(`${block}.${name}="${spec}"`)
    }
  }
  if (leaks.length > 0) {
    failures += 1
    console.error(
      `✗ ${manifest.name}: workspace: leaked into published manifest → ${leaks.join(", ")}`,
    )
  } else {
    console.log(`✓ ${manifest.name}: packed manifest concrete (no workspace: leak)`)
  }
}

// Version-consistency gate: the CLI hardcodes its version in two source files — the tsc-built CLI
// reads no package.json at runtime, and mcp-http.ts must run on edge runtimes with no fs. Assert both
// match packages/cli/package.json so a release bump can't leave a stale `nifra --version` or a stale
// MCP server-info version (alpha.1 shipped while the package was past it — this gate stops the recurrence).
{
  const cliVersion = JSON.parse(await Bun.file("packages/cli/package.json").text())
    .version as string
  const constants: ReadonlyArray<{ file: string; re: RegExp }> = [
    { file: "packages/cli/src/cli.ts", re: /CLI_VERSION\s*=\s*"([^"]+)"/ },
    { file: "packages/cli/src/mcp-http.ts", re: /\bconst VERSION\s*=\s*"([^"]+)"/ },
  ]
  for (const { file, re } of constants) {
    const found = (await Bun.file(file).text()).match(re)
    if (found === null) {
      failures += 1
      console.error(`✗ ${file}: no version constant matching ${re}`)
    } else if (found[1] !== cliVersion) {
      failures += 1
      console.error(
        `✗ ${file}: version constant "${found[1]}" ≠ @nifrajs/cli ${cliVersion} — bump it`,
      )
    } else {
      console.log(`✓ ${file}: version constant matches @nifrajs/cli ${cliVersion}`)
    }
  }

  // @nifrajs/core exports a public literal `VERSION` (it runs on the edge — no fs — so it can't derive
  // its own version). changeset version skips it; version.ts re-syncs it. Checked against core's OWN
  // package version (not cli's), so it also fails loudly if the `fixed` link between them ever breaks.
  // It shipped at "0.0.0" through 1.0.0 before this gate existed.
  {
    const coreVersion = JSON.parse(await Bun.file("packages/core/package.json").text())
      .version as string
    const file = "packages/core/src/index.ts"
    const found = (await Bun.file(file).text()).match(/export const VERSION\s*=\s*"([^"]+)"/)
    if (found === null) {
      failures += 1
      console.error(`✗ ${file}: no exported VERSION constant`)
    } else if (found[1] !== coreVersion) {
      failures += 1
      console.error(`✗ ${file}: VERSION "${found[1]}" ≠ @nifrajs/core ${coreVersion} — bump it`)
    } else {
      console.log(`✓ ${file}: VERSION matches @nifrajs/core ${coreVersion}`)
    }
  }

  // Scaffold/template version refs that `changeset version` does NOT touch (plain template + source
  // files, not workspace deps) and that drifted silently to beta at the 1.0.0 cut. `scripts/version.ts`
  // now re-syncs them on bump; this re-asserts the result so a missed bump fails the gate, not npm.
  const expected = `^${cliVersion}`

  // (a) The scaffolded `.mcp.json` pins `@nifrajs/cli@<MCP_CLI_VERSION>`; a stale pin launches an old MCP
  // server in every new project. agent-files derives it from create-nifra's own version, and `fixed`
  // versioning locks create-nifra to @nifrajs/cli — so this also guards the `fixed` link itself.
  const { MCP_CLI_VERSION } = (await import("../packages/create-nifra/src/agent-files.ts")) as {
    MCP_CLI_VERSION: string
  }
  if (MCP_CLI_VERSION !== cliVersion) {
    failures += 1
    console.error(
      `✗ create-nifra MCP_CLI_VERSION "${MCP_CLI_VERSION}" ≠ @nifrajs/cli ${cliVersion} — bump it`,
    )
  } else {
    console.log(`✓ create-nifra MCP_CLI_VERSION matches @nifrajs/cli ${cliVersion}`)
  }

  // (b) Every create-nifra template pins the just-published internal packages with `^<version>`. A
  // release that forgets to bump them ships templates that install the PREVIOUS line. Assert every
  // `@nifrajs/*` / `nifra` dep (across dependencies + devDependencies) in every template is `^<version>`.
  const templatePkgs = (
    await Array.fromAsync(new Glob("packages/create-nifra/template*/package.json").scan("."))
  ).sort()
  for (const file of templatePkgs) {
    const pkg = JSON.parse(await Bun.file(file).text()) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const bad: string[] = []
    for (const block of ["dependencies", "devDependencies"] as const) {
      for (const [name, spec] of Object.entries(pkg[block] ?? {})) {
        if ((name.startsWith("@nifrajs/") || name === "nifra") && spec !== expected) {
          bad.push(`${block}.${name}="${spec}"`)
        }
      }
    }
    if (bad.length > 0) {
      failures += 1
      console.error(`✗ ${file}: internal dep(s) ≠ ${expected} → ${bad.join(", ")}`)
    } else {
      console.log(`✓ ${file}: internal deps pinned to ${expected}`)
    }
  }

  // (c) `--auth better-auth` injects an `@nifrajs/better-auth` dep into scaffolded apps; its range must
  // track the published @nifrajs/better-auth version (also `fixed`, == cliVersion). Its sibling
  // `better-auth` peer pin is a third-party version and is intentionally NOT checked here.
  const betterAuthVersion = JSON.parse(await Bun.file("packages/better-auth/package.json").text())
    .version as string
  const { AUTH_PRESETS } = (await import("../packages/create-nifra/src/auth.ts")) as {
    AUTH_PRESETS: Record<string, { deps: Record<string, string> }>
  }
  const authPin = AUTH_PRESETS["better-auth"]?.deps["@nifrajs/better-auth"]
  if (authPin !== `^${betterAuthVersion}`) {
    failures += 1
    console.error(
      `✗ auth.ts @nifrajs/better-auth pin "${authPin}" ≠ ^${betterAuthVersion} — bump it`,
    )
  } else {
    console.log(`✓ auth.ts @nifrajs/better-auth pin matches ^${betterAuthVersion}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} package(s) failed publish validation`)
  process.exit(1)
}
console.log("\n✓ all packages pass publint + attw + packed-manifest gate")
