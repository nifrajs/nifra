#!/usr/bin/env bun
/**
 * Type-check every project in the workspace.
 *
 * The root tsconfig checks the DOM-free corpus - core, node, and ~35 packages - in one pass, resolving
 * every `@nifrajs/*` import to source through `paths`. The DOM/JSX packages (react/preact/svelte/vue/
 * solid adapters, islets, island-trigger) are excluded from that program because they need a different
 * `lib`/`jsx`, so each carries its own `tsconfig.json` and has to be checked on its own.
 *
 * That list used to live inline in a ten-command `package.json` script. A new DOM package that added its
 * own tsconfig but was never appended to the chain would simply never be type-checked, and nothing would
 * say so. The list lives here now, and {@link uncoveredTypecheckConfigs} - asserted by typecheck.test.ts
 * and re-checked before every run below - fails the moment a package tsconfig is missing from it.
 *
 * The web examples are excluded from the root program for the same reason, and each is its own program:
 * an app's generated `.nifra/types` declares its routes and registers its backend, which two apps in one
 * program would collide on. Their tsconfigs are discovered rather than listed, and
 * {@link uncheckedExampleSources} fails on any tracked source under `examples/` that no project's program
 * includes. Svelte and Vue examples run through svelte-check and vue-tsc, since `tsc` cannot read their
 * components. Each example's route types are written first, so a fresh clone needs no `nifra` command;
 * like a consumer, an example resolves `@nifrajs/*` to the built declarations, so run the build first.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { availableParallelism } from "node:os"
import { dirname, join, resolve } from "node:path"
import { writeRouteTypes } from "@nifrajs/web/route-types"
import ts from "typescript"

const ROOT = resolve(import.meta.dir, "..")

/** Examples with their own toolchain and typecheck, outside this gate. */
const STANDALONE_EXAMPLES: readonly string[] = ["examples/launch-video"]

/** `examples/<name>/tsconfig.json` - one program per web example. */
export function exampleTypecheckConfigs(): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, "examples"), { withFileTypes: true })) {
    const dir = `examples/${entry.name}`
    if (!entry.isDirectory() || STANDALONE_EXAMPLES.includes(dir)) continue
    if (existsSync(join(ROOT, dir, "tsconfig.json"))) found.push(`${dir}/tsconfig.json`)
  }
  return found.sort()
}

/**
 * Every project `tsc --noEmit` runs against: the root corpus, then each DOM/JSX package's own checker,
 * then standalone apps outside the root corpus (`apps/*`, which the root `include` does not cover), then
 * each web example. Package tsconfigs are kept in sync with disk by {@link uncoveredTypecheckConfigs};
 * app entries are asserted to exist by typecheck.test.ts.
 */
export const TYPECHECK_PROJECTS: readonly string[] = [
  "tsconfig.json",
  "packages/webmcp/tsconfig.json",
  "packages/web/tsconfig.json",
  "packages/web-solid/tsconfig.json",
  "packages/web-react/tsconfig.json",
  "packages/web-vue/tsconfig.json",
  "packages/web-preact/tsconfig.json",
  "packages/web-svelte/tsconfig.json",
  "packages/web-vanilla/tsconfig.json",
  "packages/islets/tsconfig.json",
  "packages/island-trigger/tsconfig.json",
  "apps/workbench/tsconfig.json",
  "scripts/tsconfig.json",
  ...exampleTypecheckConfigs(),
]

/**
 * Plain `packages/<name>/tsconfig.json` files - a DOM/JSX package's own checker. The `.build.json` emit
 * configs are deliberately not here: they emit `dist/` and are not a type-check gate.
 */
export function packageTypecheckConfigs(): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const rel = `packages/${entry.name}/tsconfig.json`
    const abs = join(ROOT, rel)
    if (existsSync(abs) && statSync(abs).isFile()) found.push(rel)
  }
  return found.sort()
}

/** Package tsconfigs that exist on disk but are absent from {@link TYPECHECK_PROJECTS} - the gate's blind spots. */
export function uncoveredTypecheckConfigs(): readonly string[] {
  const covered = new Set(TYPECHECK_PROJECTS)
  return packageTypecheckConfigs().filter((config) => !covered.has(config))
}

const posix = (path: string): string => path.replaceAll("\\", "/")

const COMPONENT_EXTENSIONS: readonly ts.FileExtensionInfo[] = [".svelte", ".vue"].map(
  (extension) => ({
    extension,
    isMixedContent: true,
    scriptKind: ts.ScriptKind.Deferred,
  }),
)

/** The files a project's `include`/`exclude` select, components included, as absolute posix paths. */
function programFiles(project: string): readonly string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, project),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    undefined,
    undefined,
    COMPONENT_EXTENSIONS,
  )
  return (parsed?.fileNames ?? []).map(posix)
}

/** Tracked files matching `patterns` that no project's program includes, less those `skip` names. */
function uncheckedTrackedSources(
  patterns: readonly string[],
  skip: (file: string) => boolean,
): readonly string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", ...patterns], { cwd: ROOT })
  if (!listed.success) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
  const covered = new Set(TYPECHECK_PROJECTS.flatMap(programFiles))
  const root = posix(ROOT)
  return listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file !== "" && !skip(file))
    .filter((file) => !covered.has(`${root}/${file}`))
}

/**
 * Tracked sources under `examples/` that no project's program includes - an example excluded from the
 * root program without a tsconfig of its own, or one whose `include` misses a file.
 */
export function uncheckedExampleSources(): readonly string[] {
  return uncheckedTrackedSources(
    ["ts", "tsx", "svelte", "vue"].map((ext) => `examples/*.${ext}`),
    (file) => STANDALONE_EXAMPLES.some((dir) => file.startsWith(`${dir}/`)),
  )
}

/** Tracked tooling under `scripts/` that no project's program includes. The fixture app is not tooling. */
export function uncheckedScriptSources(): readonly string[] {
  return uncheckedTrackedSources(["scripts/*.ts"], (file) => file.startsWith("scripts/fixtures/"))
}

/** Bring each example app's generated route types up to date, so its `./+types` imports resolve. */
function writeExampleRouteTypes(): void {
  for (const config of exampleTypecheckConfigs()) {
    const appRoot = join(ROOT, dirname(config))
    if (existsSync(join(appRoot, "routes"))) writeRouteTypes({ appRoot })
  }
}

interface CheckResult {
  readonly ok: boolean
  readonly output: string
}

// Every package config inherits the base's one `.tsbuildinfo`, so parallel runs would race on it; each
// project gets its own instead.
const buildInfoFile = (project: string): string =>
  join(ROOT, "node_modules/.cache/typecheck", `${project.replaceAll("/", "__")}.tsbuildinfo`)

const EXAMPLE_BIN = join(ROOT, "examples/node_modules/.bin")

function bin(name: string, path: string): string {
  const found = Bun.which(name, { PATH: path })
  if (found === null) throw new Error(`${name} is not installed; run \`bun install\``)
  return found
}

/** The checker command for a project: svelte-check or vue-tsc for those examples, else `tsc`. */
function command(project: string): readonly string[] {
  const { config } = ts.readConfigFile(join(ROOT, project), ts.sys.readFile)
  const base: unknown = config?.extends
  if (base === "../tsconfig.svelte.json") {
    return [bin("svelte-check", EXAMPLE_BIN), "--tsconfig", project, "--threshold", "error"]
  }
  const pretty = process.stdout.isTTY ? ["--pretty"] : []
  const args = ["--noEmit", "-p", project, "--tsBuildInfoFile", buildInfoFile(project), ...pretty]
  if (base === "../tsconfig.vue.json") return [bin("vue-tsc", EXAMPLE_BIN), ...args]
  return [Bun.which("tsc") ?? join(ROOT, "node_modules/.bin/tsc"), ...args]
}

async function check(project: string): Promise<CheckResult> {
  const proc = Bun.spawn([...command(project)], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: exitCode === 0, output: stdout + stderr }
}

if (import.meta.main) {
  const uncovered = uncoveredTypecheckConfigs()
  if (uncovered.length > 0) {
    console.error(
      `✗ package tsconfig(s) not in the typecheck gate: ${uncovered.join(", ")}\n` +
        "  add each to TYPECHECK_PROJECTS in scripts/typecheck.ts (or delete the tsconfig if the package is covered by the root program).",
    )
    process.exit(1)
  }
  const unchecked = uncheckedExampleSources()
  if (unchecked.length > 0) {
    console.error(
      `✗ example source(s) no typecheck project includes: ${unchecked.join(", ")}\n` +
        "  give the example a tsconfig.json extending examples/tsconfig.<framework>.json (or list it in STANDALONE_EXAMPLES if it has its own toolchain).",
    )
    process.exit(1)
  }
  const uncheckedScripts = uncheckedScriptSources()
  if (uncheckedScripts.length > 0) {
    console.error(
      `✗ script(s) no typecheck project includes: ${uncheckedScripts.join(", ")}\n` +
        "  widen the `include` of scripts/tsconfig.json.",
    )
    process.exit(1)
  }
  writeExampleRouteTypes()
  const queue = [...TYPECHECK_PROJECTS]
  const results = new Map<string, CheckResult>()
  const workers = Array.from(
    { length: Math.min(availableParallelism(), queue.length) },
    async () => {
      for (let project = queue.shift(); project !== undefined; project = queue.shift()) {
        results.set(project, await check(project))
      }
    },
  )
  await Promise.all(workers)
  const failed = TYPECHECK_PROJECTS.filter((project) => results.get(project)?.ok !== true)
  for (const project of failed) {
    console.error(`✗ ${project}\n${results.get(project)?.output ?? ""}`)
  }
  if (failed.length > 0) process.exit(1)
  console.log(`✓ typecheck passed (${TYPECHECK_PROJECTS.length} projects)`)
}
