import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginBuilder } from "bun"
import {
  matchesSingleCopyDeclaration,
  planSingleCopy,
  readSingleCopyDeclaration,
  readSingleCopyRegistration,
  readSingleCopyStrict,
  registerSingleCopy,
  SINGLE_COPY_ACTIVE,
  SINGLE_COPY_STRICT_ENV,
  type SingleCopyPlugin,
  type SingleCopySkip,
  singleCopyPlugin,
} from "../src/single-copy.ts"

/**
 * The topology this exists for: an app, and a package it consumes by symlink out of a checkout its
 * own install does not own. Both trees carry `state`, so an importer that loads the sibling's copy
 * sees a different module instance - which is the failure, rendered here as a value rather than as a
 * null hook dispatcher.
 */
const linkedRepos = async (
  label: string,
  over: {
    readonly declaration?: unknown
    readonly siblingVersion?: string
    readonly bunfig?: string
  } = {},
) => {
  // Realpath up front: on macOS `/var` is a symlink to `/private/var`, and every path this plugin
  // reports is a realpath - so a fixture that keeps the symlinked spelling compares two spellings of
  // the same directory and fails for a reason that has nothing to do with the code.
  const ground = await realpath(await mkdtemp(join(tmpdir(), `nifra-single-copy-${label}-`)))
  const app = join(ground, "app")
  const sibling = join(ground, "sibling")
  const ours = join(app, "node_modules", "state")
  const theirs = join(sibling, "node_modules", "state")
  const ui = join(sibling, "packages", "ui")
  await mkdir(join(app, ".git"), { recursive: true })
  await mkdir(join(app, "node_modules", "@example"), { recursive: true })
  await mkdir(ours, { recursive: true })
  await mkdir(join(sibling, ".git"), { recursive: true })
  await mkdir(theirs, { recursive: true })
  await mkdir(ui, { recursive: true })
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "app",
      dependencies: { state: "1.0.0", "@example/ui": "link:../sibling/packages/ui" },
      ...(over.declaration === undefined ? {} : { nifra: { singleCopy: over.declaration } }),
    }),
  )
  if (over.bunfig !== undefined) await writeFile(join(app, "bunfig.toml"), over.bunfig)
  await writeFile(
    join(ui, "package.json"),
    JSON.stringify({ name: "@example/ui", main: "index.js", peerDependencies: { state: "*" } }),
  )
  await writeFile(join(ui, "index.js"), 'export { mark, seen } from "state"\n')
  for (const [dir, version] of [
    [ours, "1.0.0"],
    [theirs, over.siblingVersion ?? "1.0.0"],
  ] as const) {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "state", version, main: "index.js" }),
    )
    // Module-scoped state, the thing a second copy silently splits.
    await writeFile(
      join(dir, "index.js"),
      "const seenBy = new Set();\nexport const mark = (who) => seenBy.add(who);\nexport const seen = () => [...seenBy];\n",
    )
  }
  await symlink(ui, join(app, "node_modules", "@example", "ui"))
  return { ground, app, ours, theirs }
}

test("matchesSingleCopyDeclaration takes exact names and scope patterns", () => {
  const declared = ["react", "@nifrajs/*"]
  expect(matchesSingleCopyDeclaration(declared, "react")).toBe(true)
  expect(matchesSingleCopyDeclaration(declared, "react-dom")).toBe(false)
  expect(matchesSingleCopyDeclaration(declared, "@nifrajs/core")).toBe(true)
  expect(matchesSingleCopyDeclaration(declared, "@nifrajs/web")).toBe(true)
  // Keep the dead pre-rename scope out of the publish scanner's source scan while still testing the
  // exact-name matcher against it.
  expect(matchesSingleCopyDeclaration(declared, "@nifra" + "/core")).toBe(false)
})

test("readSingleCopyDeclaration reads a list, expands `true`, and ignores the rest", async () => {
  const { ground, app } = await linkedRepos("declaration", { declaration: ["state"] })
  try {
    expect(readSingleCopyDeclaration(app)).toEqual(["state"])
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
  const off = await linkedRepos("declaration-off", { declaration: false })
  try {
    expect(readSingleCopyDeclaration(off.app)).toBeUndefined()
  } finally {
    await rm(off.ground, { recursive: true, force: true })
  }
  const all = await linkedRepos("declaration-true", { declaration: true })
  try {
    expect(readSingleCopyDeclaration(all.app)).toContain("react")
    expect(readSingleCopyDeclaration(all.app)).toContain("@nifrajs/*")
    expect(readSingleCopyStrict(all.app)).toBe(false)
  } finally {
    await rm(all.ground, { recursive: true, force: true })
  }
})

test("the object form declares the same list plus strict mode", async () => {
  const strict = await linkedRepos("declaration-object", {
    declaration: { packages: ["state"], strict: true },
  })
  try {
    expect(readSingleCopyDeclaration(strict.app)).toEqual(["state"])
    expect(readSingleCopyStrict(strict.app)).toBe(true)
  } finally {
    await rm(strict.ground, { recursive: true, force: true })
  }
  const lax = await linkedRepos("declaration-object-lax", { declaration: { packages: true } })
  try {
    expect(readSingleCopyDeclaration(lax.app)).toContain("@nifrajs/*")
    expect(readSingleCopyStrict(lax.app)).toBe(false)
  } finally {
    await rm(lax.ground, { recursive: true, force: true })
  }
  const empty = await linkedRepos("declaration-object-empty", { declaration: { strict: true } })
  try {
    expect(readSingleCopyDeclaration(empty.app)).toBeUndefined()
  } finally {
    await rm(empty.ground, { recursive: true, force: true })
  }
})

test("readSingleCopyRegistration tells the run preload from the test preload", async () => {
  const { ground, app } = await linkedRepos("registration", {
    bunfig: '[test]\npreload = ["@nifrajs/core/single-copy/register", "./test/setup.ts"]\n',
  })
  try {
    const registration = readSingleCopyRegistration(app)
    expect(registration.test).toBe(true)
    // Not armed for `bun run`: a `[test]` preload covers `bun test` only, and reporting otherwise
    // would claim a guarantee the app does not have.
    expect(registration.run).toBe(false)
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("a preload entry that merely CONTAINS the register specifier is not a registration", async () => {
  // The old substring test read this as armed. It is not: the app preloads a different module whose
  // path happens to embed the specifier, so nothing registers and the guarantee would be claimed on
  // an app that does not have it. Entries are compared whole.
  const near = await linkedRepos("registration-substring", {
    bunfig: '[test]\npreload = ["./vendor/@nifrajs/core/single-copy/register-shim.ts"]\n',
  })
  try {
    expect(readSingleCopyRegistration(near.app).test).toBe(false)
  } finally {
    await rm(near.ground, { recursive: true, force: true })
  }
  // A trailing comment on the array line is still a real registration.
  const commented = await linkedRepos("registration-comment", {
    bunfig: '[test]\npreload = ["@nifrajs/core/single-copy/register"] # single-copy\n',
  })
  try {
    expect(readSingleCopyRegistration(commented.app).test).toBe(true)
  } finally {
    await rm(commented.ground, { recursive: true, force: true })
  }
})

test("planSingleCopy redirects a linked repo's copy at the app's, and refuses across versions", async () => {
  const same = await linkedRepos("plan", { declaration: ["state"] })
  try {
    const plan = planSingleCopy({ cwd: same.app })
    expect(plan.redirects).toHaveLength(1)
    expect(plan.redirects[0]?.package).toBe("state")
    expect(plan.redirects[0]?.from).toBe(same.theirs)
    expect(plan.redirects[0]?.to).toBe(same.ours)
    expect(plan.skipped).toHaveLength(0)
  } finally {
    await rm(same.ground, { recursive: true, force: true })
  }

  const skewed = await linkedRepos("plan-skew", {
    declaration: ["state"],
    siblingVersion: "2.0.0",
  })
  try {
    const plan = planSingleCopy({ cwd: skewed.app })
    expect(plan.redirects).toHaveLength(0)
    expect(plan.skipped.map((skip) => skip.reason)).toEqual(["version-skew"])
    expect(plan.skipped[0]).toMatchObject({
      package: "state",
      from: skewed.theirs,
      to: skewed.ours,
      fromVersion: "2.0.0",
      toVersion: "1.0.0",
    })
  } finally {
    await rm(skewed.ground, { recursive: true, force: true })
  }
})

test("an undeclared package is left alone", async () => {
  const { ground, app } = await linkedRepos("undeclared")
  try {
    expect(planSingleCopy({ cwd: app }).redirects).toHaveLength(0)
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("the plugin collapses two copies into one module instance at RUNTIME", async () => {
  const { ground, app } = await linkedRepos("runtime", { declaration: ["state"] })
  try {
    // Proved in a child process: `Bun.plugin` is global and permanent, so registering it in this
    // process would leak into every other test file. The child is also the honest test - the runtime
    // arm exists precisely for the case where nothing bundles the graph first.
    await writeFile(
      join(app, "preload.ts"),
      `import { registerSingleCopy } from ${JSON.stringify(join(import.meta.dir, "..", "src", "single-copy.ts"))};\nregisterSingleCopy({ cwd: ${JSON.stringify(app)} });\n`,
    )
    await writeFile(
      join(app, "probe.ts"),
      // The app's own copy and the linked package's - two physical files, one shared Set if the
      // redirect worked.
      'import { mark, seen } from "state"\n' +
        'import { seen as theirSeen, mark as theirMark } from "@example/ui"\n' +
        'mark("app")\ntheirMark("ui")\nconsole.log(JSON.stringify({ ours: seen(), theirs: theirSeen() }))\n',
    )
    const run = (...args: readonly string[]) => {
      const probe = Bun.spawnSync({
        cmd: ["bun", ...args, "./probe.ts"],
        cwd: app,
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = probe.stdout.toString().trim()
      expect(probe.stderr.toString()).toBe("")
      expect(output).not.toBe("")
      return JSON.parse(output) as { readonly ours: string[]; readonly theirs: string[] }
    }
    // The control. Without the plugin the two copies keep separate state, which is the whole defect -
    // and without asserting it, the assertion below would pass just as well on a fixture where Bun
    // happened to resolve one copy anyway, proving nothing.
    expect(run()).toEqual({ ours: ["app"], theirs: ["ui"] })
    expect(run("--preload", "./preload.ts")).toEqual({
      ours: ["app", "ui"],
      theirs: ["app", "ui"],
    })
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("a deep subpath import of a scope-declared package pins to the app's copy in a BUNDLE", async () => {
  // Nested install, no symlink: the consumer package carries its own physical copy in its own
  // node_modules, so the redirect planner (which only sees linked-out repos) finds nothing and the
  // `onResolve` pin is the only defense. The root specifier and the `/sub` subpath must both pin,
  // or a deep import quietly bundles the second copy and module state splits.
  const ground = await realpath(await mkdtemp(join(tmpdir(), "nifra-single-copy-subpath-")))
  try {
    const app = ground
    const ours = join(app, "node_modules", "@example", "state")
    const consumer = join(app, "node_modules", "consumer")
    const theirs = join(consumer, "node_modules", "@example", "state")
    await mkdir(join(app, ".git"), { recursive: true })
    for (const dir of [ours, theirs, join(app, "src")]) await mkdir(dir, { recursive: true })
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "app", nifra: { singleCopy: ["@example/*"] } }),
    )
    for (const dir of [ours, theirs]) {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "@example/state",
          version: "1.0.0",
          exports: { ".": "./index.js", "./sub": "./sub.js" },
        }),
      )
      await writeFile(
        join(dir, "index.js"),
        "export const seenBy = new Set();\nexport const mark = (who) => seenBy.add(who);\n",
      )
      await writeFile(
        join(dir, "sub.js"),
        'import { seenBy } from "./index.js";\nexport const seen = () => [...seenBy];\n',
      )
    }
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", main: "index.js", type: "module" }),
    )
    await writeFile(
      join(consumer, "index.js"),
      'import { seen } from "@example/state/sub";\nexport const consumerSeen = seen;\n',
    )
    await writeFile(
      join(app, "src", "main.ts"),
      'import { mark } from "@example/state"\n' +
        'import { consumerSeen } from "consumer"\n' +
        'mark("app")\nconsole.log(JSON.stringify(consumerSeen()))\n',
    )
    const result = await Bun.build({
      entrypoints: [join(app, "src", "main.ts")],
      outdir: join(app, "out"),
      target: "bun",
      plugins: [singleCopyPlugin({ cwd: app })],
    })
    expect(result.success).toBe(true)
    const probe = Bun.spawnSync({
      cmd: ["bun", join(app, "out", "main.js")],
      cwd: app,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(probe.stderr.toString()).toBe("")
    // One Set across the root import and the consumer's deep import - the mark is visible.
    expect(JSON.parse(probe.stdout.toString())).toEqual(["app"])
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("a bundled app's root import of METHODS survives single-copy enforcement, executed", async () => {
  // The consumer topology: the app resolves @nifrajs/core through its own node_modules, a linked
  // sibling repo carries a second physical copy at the same version, and the app bundles with
  // `bun build` while `nifra.singleCopy` is on. The assertion is on the EXECUTED bundle - an import
  // test cannot see a binding the bundler dropped, only running the output can.
  const core = await realpath(join(import.meta.dir, ".."))
  const meta = JSON.parse(await Bun.file(join(core, "package.json")).text()) as {
    readonly version: string
  }
  const ground = await realpath(await mkdtemp(join(tmpdir(), "nifra-single-copy-bundle-")))
  try {
    const app = join(ground, "app")
    const sibling = join(ground, "sibling")
    const ui = join(sibling, "packages", "ui")
    const theirs = join(sibling, "node_modules", "@nifrajs", "core")
    await mkdir(join(app, ".git"), { recursive: true })
    await mkdir(join(app, "node_modules", "@nifrajs"), { recursive: true })
    await mkdir(join(app, "node_modules", "@example"), { recursive: true })
    await mkdir(join(app, "src"), { recursive: true })
    await mkdir(join(sibling, ".git"), { recursive: true })
    await mkdir(join(theirs, "src"), { recursive: true })
    await mkdir(ui, { recursive: true })
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "app",
        nifra: { singleCopy: ["@nifrajs/*"] },
        dependencies: {
          "@nifrajs/core": meta.version,
          "@example/ui": "link:../sibling/packages/ui",
        },
      }),
    )
    // The app's copy is the real checkout; the sibling's is a distinct physical copy at the same
    // version whose files fail loudly if anything ever loads them instead of the app's.
    await symlink(core, join(app, "node_modules", "@nifrajs", "core"))
    await writeFile(join(theirs, "package.json"), await Bun.file(join(core, "package.json")).text())
    for (const file of ["index.ts", "server.ts"]) {
      await writeFile(
        join(theirs, "src", file),
        'throw new Error("foreign @nifrajs/core copy loaded")\n',
      )
    }
    await writeFile(
      join(ui, "package.json"),
      JSON.stringify({
        name: "@example/ui",
        version: "1.0.0",
        main: "index.js",
        type: "module",
        peerDependencies: { "@nifrajs/core": "*" },
      }),
    )
    await writeFile(join(ui, "index.js"), 'export { METHODS as libMethods } from "@nifrajs/core"\n')
    await symlink(ui, join(app, "node_modules", "@example", "ui"))
    await writeFile(
      join(app, "src", "main.ts"),
      'import { METHODS } from "@nifrajs/core"\n' +
        'import { libMethods } from "@example/ui"\n' +
        "console.log(JSON.stringify({ methods: METHODS, shared: METHODS === libMethods }))\n",
    )
    const plugin = singleCopyPlugin({ cwd: app })
    expect(plugin.plan.redirects.map((redirect) => redirect.package)).toEqual(["@nifrajs/core"])
    const result = await Bun.build({
      entrypoints: [join(app, "src", "main.ts")],
      outdir: join(app, "out"),
      target: "bun",
      plugins: [plugin],
    })
    expect(result.success).toBe(true)
    const probe = Bun.spawnSync({
      cmd: ["bun", join(app, "out", "main.js")],
      cwd: app,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(probe.stderr.toString()).toBe("")
    const output = JSON.parse(probe.stdout.toString()) as {
      readonly methods: readonly string[]
      readonly shared: boolean
    }
    // The binding must exist in the executed output, hold the documented set, and be the SAME
    // module instance for the app and the linked package.
    expect(output.methods).toContain("GET")
    expect(output.methods).toContain("OPTIONS")
    expect(output.methods.length).toBeGreaterThanOrEqual(7)
    expect(output.shared).toBe(true)
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("the plugin builds even when the app has no duplicates to collapse", async () => {
  const ground = await mkdtemp(join(tmpdir(), "nifra-single-copy-clean-"))
  try {
    await mkdir(join(ground, ".git"), { recursive: true })
    await writeFile(
      join(ground, "package.json"),
      JSON.stringify({ name: "clean", nifra: { singleCopy: ["react"] } }),
    )
    const plugin = singleCopyPlugin({ cwd: ground })
    expect(plugin.plan.redirects).toHaveLength(0)
    expect(plugin.name).toBe("nifra-single-copy")
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

/**
 * Run `probe.ts` under a preload that registers the plugin (twice, to prove the warning is
 * once-per-process), in a child - `Bun.plugin` is global and permanent.
 */
const runRegistered = async (
  app: string,
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const register = JSON.stringify(join(import.meta.dir, "..", "src", "single-copy.ts"))
  await writeFile(
    join(app, "preload.ts"),
    `import { registerSingleCopy } from ${register};\nregisterSingleCopy();\nregisterSingleCopy();\n`,
  )
  await writeFile(
    join(app, "probe.ts"),
    'import { seen } from "@example/ui"\nconsole.log(JSON.stringify(seen()))\n',
  )
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  if (env[SINGLE_COPY_STRICT_ENV] === undefined) delete childEnv[SINGLE_COPY_STRICT_ENV]
  const probe = Bun.spawnSync({
    cmd: ["bun", "--preload", "./preload.ts", "./probe.ts"],
    cwd: app,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: probe.exitCode,
    stdout: probe.stdout.toString().trim(),
    stderr: probe.stderr.toString(),
  }
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

test("the registrar warns once per package on a version skew, naming both copies and versions", async () => {
  const { ground, app, ours, theirs } = await linkedRepos("register-skew", {
    declaration: ["state"],
    siblingVersion: "2.0.0",
  })
  try {
    const run = await runRegistered(app)
    // Not strict: the app still starts, on two copies.
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe("[]")
    expect(
      occurrences(run.stderr, "[nifra] single-copy: state is NOT deduplicated (version-skew)"),
    ).toBe(1)
    expect(run.stderr).toContain(`app copy: ${ours} (1.0.0)`)
    expect(run.stderr).toContain(`linked copy: ${theirs} (2.0.0)`)
    expect(run.stderr).toContain("align the dependency ranges")
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("strict mode refuses to start on a version skew, from package.json or the environment", async () => {
  const declared = await linkedRepos("register-strict", {
    declaration: { packages: ["state"], strict: true },
    siblingVersion: "2.0.0",
  })
  try {
    const run = await runRegistered(declared.app)
    expect(run.exitCode).not.toBe(0)
    // The throw happens in the preload, before the entry point runs.
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("state is NOT deduplicated (version-skew)")
    expect(run.stderr).toContain("Strict mode is on")
  } finally {
    await rm(declared.ground, { recursive: true, force: true })
  }
  const viaEnv = await linkedRepos("register-strict-env", {
    declaration: ["state"],
    siblingVersion: "2.0.0",
  })
  try {
    const run = await runRegistered(viaEnv.app, { [SINGLE_COPY_STRICT_ENV]: "1" })
    expect(run.exitCode).not.toBe(0)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("Strict mode is on")
  } finally {
    await rm(viaEnv.ground, { recursive: true, force: true })
  }
})

test("the registrar stays silent when every declared copy collapses", async () => {
  const { ground, app } = await linkedRepos("register-clean", {
    declaration: { packages: ["state"], strict: true },
  })
  try {
    const run = await runRegistered(app)
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe("[]")
    expect(run.stderr).toBe("")
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("a linked file with no counterpart in the app's copy is reported, and fails strict mode", async () => {
  const withExtra = async (label: string, declaration: unknown) => {
    const repos = await linkedRepos(label, { declaration })
    // Same version, different layout: the linked copy ships a file the app's copy lacks, and the
    // linked package imports it directly.
    await writeFile(join(repos.theirs, "extra.js"), "export const extra = new Set();\n")
    await writeFile(
      join(repos.ground, "sibling", "packages", "ui", "index.js"),
      'export { mark, seen } from "state"\nexport { extra } from "state/extra.js"\n',
    )
    return repos
  }
  const lax = await withExtra("register-no-counterpart", ["state"])
  try {
    const run = await runRegistered(lax.app)
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe("[]")
    expect(
      occurrences(run.stderr, "[nifra] single-copy: state is NOT deduplicated (no-counterpart)"),
    ).toBe(1)
    expect(run.stderr).toContain(`linked copy: ${join(lax.theirs, "extra.js")} (1.0.0)`)
    expect(run.stderr).toContain("extra.js has no file at the same path in the app's copy")
  } finally {
    await rm(lax.ground, { recursive: true, force: true })
  }
  const strict = await withExtra("register-no-counterpart-strict", {
    packages: ["state"],
    strict: true,
  })
  try {
    const run = await runRegistered(strict.app)
    expect(run.exitCode).not.toBe(0)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("state is NOT deduplicated (no-counterpart)")
  } finally {
    await rm(strict.ground, { recursive: true, force: true })
  }
})

test("a root that does not exist plans nothing instead of throwing", async () => {
  const ground = await realpath(await mkdtemp(join(tmpdir(), "nifra-single-copy-missing-")))
  try {
    const missing = join(ground, "never-created")
    expect(planSingleCopy({ cwd: missing })).toEqual({
      root: missing,
      declared: [],
      redirects: [],
      skipped: [],
    })
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("a workspace package wins with the copy hoisted to its repository root", async () => {
  const { ground, app, ours, theirs } = await linkedRepos("workspace")
  try {
    // No `node_modules` of its own: the install hoisted everything to the repository root, which is
    // also where the linked package is symlinked in.
    const web = join(app, "packages", "web")
    await mkdir(web, { recursive: true })
    await writeFile(
      join(web, "package.json"),
      JSON.stringify({ name: "web", nifra: { singleCopy: ["state"] } }),
    )
    const plan = planSingleCopy({ cwd: web })
    expect(plan.root).toBe(web)
    expect(plan.redirects).toEqual([{ package: "state", from: theirs, to: ours, version: "1.0.0" }])
    expect(plan.skipped).toHaveLength(0)
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

interface RecordedHook {
  readonly filter: RegExp
  readonly run: (path: string) => unknown
}

/**
 * Run `setup` against a recording builder. The hooks are then called directly, in this process,
 * without `Bun.plugin` ever installing them.
 */
const hooksOf = (
  plugin: SingleCopyPlugin,
): { readonly resolve: RecordedHook | undefined; readonly load: RecordedHook | undefined } => {
  const resolvers: RecordedHook[] = []
  const loaders: RecordedHook[] = []
  const record =
    (into: RecordedHook[]) =>
    (
      constraints: { readonly filter: RegExp },
      callback: (args: { readonly path: string }) => unknown,
    ): void => {
      into.push({ filter: constraints.filter, run: (path) => callback({ path }) })
    }
  plugin.setup({
    onResolve: record(resolvers),
    onLoad: record(loaders),
  } as unknown as PluginBuilder)
  return { resolve: resolvers[0], load: loaders[0] }
}

const hook = (recorded: RecordedHook | undefined): RecordedHook => {
  if (recorded === undefined) throw new Error("the plugin registered no such hook")
  return recorded
}

test("the resolve hook pins a declared name and its subpaths to the app's copy", async () => {
  const { ground, app, ours } = await linkedRepos("resolve-hook", {
    declaration: ["state", "@example/*"],
  })
  try {
    const resolve = hook(hooksOf(singleCopyPlugin({ cwd: app })).resolve)
    for (const specifier of ["state", "state/index.js", "@example/ui", "@example/ui/deep/file.js"])
      expect(resolve.filter.test(specifier)).toBe(true)
    // A name that merely starts with, or ends in, a declared one is a different package.
    for (const specifier of ["stateful", "@example", "./state", "other/state"])
      expect(resolve.filter.test(specifier)).toBe(false)
    expect(resolve.run("state")).toEqual({ path: join(ours, "index.js") })
    expect(resolve.run("state/index.js")).toEqual({ path: join(ours, "index.js") })
    // Declared, but not resolvable from the app: there is nothing to pin it TO, so the import is
    // left to the default resolver rather than turned into a failure.
    expect(resolve.run("state/missing.js")).toBeUndefined()
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

const EXTRA = "export const extra = new Set();\n"

test("the load hook re-exports the app's counterpart, and returns a file with none untouched", async () => {
  const { ground, app, ours, theirs } = await linkedRepos("load-hook", { declaration: ["state"] })
  try {
    const extra = join(theirs, "extra.js")
    await writeFile(extra, EXTRA)
    const skips: SingleCopySkip[] = []
    const load = hook(
      hooksOf(
        singleCopyPlugin({
          cwd: app,
          onSkip: (skip) => {
            skips.push(skip)
          },
        }),
      ).load,
    )
    // Anchored at the linked copy: the app's own files, and anything that is not source, never match.
    expect(load.filter.test(join(theirs, "index.js"))).toBe(true)
    expect(load.filter.test(join(ours, "index.js"))).toBe(false)
    expect(load.filter.test(join(theirs, "package.json"))).toBe(false)

    const target = JSON.stringify(join(ours, "index.js"))
    expect(load.run(join(theirs, "index.js"))).toEqual({
      contents:
        `export * from ${target};\n` +
        `import * as __singleCopy from ${target};\n` +
        "export default __singleCopy.default ?? __singleCopy;\n",
      loader: "js",
    })
    expect(skips).toHaveLength(0)

    expect(load.run(extra)).toEqual({ contents: EXTRA, loader: "js" })
    expect(skips).toEqual([
      {
        package: "state",
        from: extra,
        to: ours,
        fromVersion: "1.0.0",
        toVersion: "1.0.0",
        reason: "no-counterpart",
        detail:
          "extra.js has no file at the same path in the app's copy, so it loads from the linked copy and its module state is not shared",
      },
    ])

    // Without a listener the plugin stays silent, and still hands the file back.
    const silent = hook(hooksOf(singleCopyPlugin({ cwd: app })).load)
    expect(silent.run(extra)).toEqual({ contents: EXTRA, loader: "js" })
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("no declaration registers no hook, and a version skew registers the resolver alone", async () => {
  const { ground, app } = await linkedRepos("hooks-registered", { siblingVersion: "2.0.0" })
  try {
    expect(hooksOf(singleCopyPlugin({ cwd: app }))).toEqual({ resolve: undefined, load: undefined })
    // Nothing is redirected across versions, so no file of the linked copy is ever intercepted.
    const skewed = hooksOf(singleCopyPlugin({ cwd: app, packages: ["state"] }))
    expect(skewed.resolve).toBeDefined()
    expect(skewed.load).toBeUndefined()
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

const globals = globalThis as Record<symbol, unknown>
const REGISTRAR_STATE = [
  Symbol.for("nifra.single-copy.warned"),
  Symbol.for("nifra.single-copy.installed"),
  SINGLE_COPY_ACTIVE,
] as const

/**
 * Call the registrar in THIS process without installing anything. `Bun.plugin` is global and
 * permanent, so it is swapped for a recorder; the bookkeeping the registrar keeps on `globalThis` and
 * the strict switch in the environment start empty and are put back afterwards.
 */
const withRegistrar = async (
  body: (seen: {
    readonly installed: readonly SingleCopyPlugin[]
    readonly warnings: readonly string[]
  }) => void | Promise<void>,
): Promise<void> => {
  const saved = REGISTRAR_STATE.map((key) => [key, globals[key]] as const)
  const strictEnv = process.env[SINGLE_COPY_STRICT_ENV]
  for (const key of REGISTRAR_STATE) delete globals[key]
  delete process.env[SINGLE_COPY_STRICT_ENV]
  const installed: SingleCopyPlugin[] = []
  const warnings: string[] = []
  const install = spyOn(Bun, "plugin").mockImplementation(((plugin: SingleCopyPlugin) => {
    installed.push(plugin)
  }) as unknown as typeof Bun.plugin)
  const warn = spyOn(console, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message))
  })
  try {
    await body({ installed, warnings })
  } finally {
    install.mockRestore()
    warn.mockRestore()
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
    if (strictEnv === undefined) delete process.env[SINGLE_COPY_STRICT_ENV]
    else process.env[SINGLE_COPY_STRICT_ENV] = strictEnv
  }
}

test("the registrar reports each planned skip, warns once, and installs one plugin per plan", async () => {
  const { ground, app, ours, theirs } = await linkedRepos("inprocess-skew", {
    declaration: ["state"],
    siblingVersion: "2.0.0",
  })
  try {
    await withRegistrar(({ installed, warnings }) => {
      const skips: SingleCopySkip[] = []
      const onSkip = (skip: SingleCopySkip): void => {
        skips.push(skip)
      }
      const first = registerSingleCopy({ cwd: app, onSkip })
      expect(globals[SINGLE_COPY_ACTIVE]).toBe(first)
      const second = registerSingleCopy({ cwd: app, onSkip })
      expect(globals[SINGLE_COPY_ACTIVE]).toBe(second)
      expect(second).toEqual(first)
      expect(first.root).toBe(app)
      expect(first.skipped).toHaveLength(1)

      // The listener hears every call; the console and the runtime hear the first one only.
      expect(skips).toEqual([...first.skipped, ...second.skipped])
      expect(installed).toHaveLength(1)
      expect(installed[0]?.plan).toBe(first)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.split("\n")).toEqual([
        "[nifra] single-copy: state is NOT deduplicated (version-skew) - a second copy loads, so its module state is not shared.",
        `  app copy: ${ours} (1.0.0)`,
        `  linked copy: ${theirs} (2.0.0)`,
        "  2.0.0 there, 1.0.0 here - redirecting would serve a version that copy did not ask for",
        "  Fix: align the dependency ranges so both trees install one version, then reinstall. nifra never redirects across versions.",
      ])
    })
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("strict mode is the option first, then the declaration or the environment", async () => {
  const declared = await linkedRepos("inprocess-strict", {
    declaration: { packages: ["state"], strict: true },
    siblingVersion: "2.0.0",
  })
  try {
    await withRegistrar(({ installed, warnings }) => {
      expect(() => registerSingleCopy({ cwd: declared.app })).toThrow(
        "Strict mode is on, so this process refuses to start.",
      )
      // A refusal leaves nothing behind: no hook, no warning, no "active" marker for a checker to trust.
      expect(installed).toHaveLength(0)
      expect(warnings).toHaveLength(0)
      expect(globals[SINGLE_COPY_ACTIVE]).toBeUndefined()

      expect(registerSingleCopy({ cwd: declared.app, strict: false }).skipped).toHaveLength(1)
      expect(installed).toHaveLength(1)
      expect(warnings).toHaveLength(1)
    })
  } finally {
    await rm(declared.ground, { recursive: true, force: true })
  }

  const viaEnv = await linkedRepos("inprocess-strict-env", {
    declaration: ["state"],
    siblingVersion: "2.0.0",
  })
  try {
    await withRegistrar(() => {
      for (const on of ["1", "true"]) {
        process.env[SINGLE_COPY_STRICT_ENV] = on
        expect(() => registerSingleCopy({ cwd: viaEnv.app })).toThrow("Strict mode is on")
      }
      for (const off of ["0", "false", "yes", ""]) {
        process.env[SINGLE_COPY_STRICT_ENV] = off
        expect(registerSingleCopy({ cwd: viaEnv.app }).skipped).toHaveLength(1)
      }
      process.env[SINGLE_COPY_STRICT_ENV] = "1"
      expect(registerSingleCopy({ cwd: viaEnv.app, strict: false }).skipped).toHaveLength(1)
    })
  } finally {
    await rm(viaEnv.ground, { recursive: true, force: true })
  }
})

test("the installed plugin warns once for a file with no counterpart, and throws in strict mode", async () => {
  const { ground, app, theirs } = await linkedRepos("inprocess-no-counterpart", {
    declaration: ["state"],
  })
  try {
    const extra = join(theirs, "extra.js")
    await writeFile(extra, EXTRA)
    await withRegistrar(({ installed, warnings }) => {
      const skips: SingleCopySkip[] = []
      const plan = registerSingleCopy({
        cwd: app,
        onSkip: (skip) => {
          skips.push(skip)
        },
      })
      // Same version, so the plan is clean: this skip only exists once a file is actually loaded.
      expect(plan.skipped).toHaveLength(0)
      expect(warnings).toHaveLength(0)
      const [plugin] = installed
      if (plugin === undefined) throw new Error("the registrar installed no plugin")
      const load = hook(hooksOf(plugin).load)
      expect(load.run(extra)).toEqual({ contents: EXTRA, loader: "js" })
      expect(load.run(extra)).toEqual({ contents: EXTRA, loader: "js" })
      expect(skips.map((skip) => [skip.reason, skip.from])).toEqual([
        ["no-counterpart", extra],
        ["no-counterpart", extra],
      ])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("state is NOT deduplicated (no-counterpart)")
      expect(warnings[0]).toContain(`  linked copy: ${extra} (1.0.0)`)
      expect(warnings[0]).toContain("Fix: install the same build of the package in both trees")
    })
    await withRegistrar(({ installed, warnings }) => {
      registerSingleCopy({ cwd: app, strict: true })
      const [plugin] = installed
      if (plugin === undefined) throw new Error("the registrar installed no plugin")
      const load = hook(hooksOf(plugin).load)
      expect(() => load.run(extra)).toThrow("Strict mode is on")
      // Strict only fails the file that cannot be shared; one with a counterpart still redirects.
      expect(load.run(join(theirs, "index.js"))).toMatchObject({ loader: "js" })
      expect(warnings).toHaveLength(0)
    })
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("with nothing declared the registrar installs no plugin and still records its plan", async () => {
  const { ground, app } = await linkedRepos("inprocess-undeclared")
  try {
    await withRegistrar(({ installed, warnings }) => {
      const plan = registerSingleCopy({ cwd: app })
      expect(plan).toEqual({ root: app, declared: [], redirects: [], skipped: [] })
      expect(installed).toHaveLength(0)
      expect(warnings).toHaveLength(0)
      expect(globals[SINGLE_COPY_ACTIVE]).toBe(plan)
    })
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})
