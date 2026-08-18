import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  matchesSingleCopyDeclaration,
  planSingleCopy,
  readSingleCopyDeclaration,
  readSingleCopyRegistration,
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
  } finally {
    await rm(all.ground, { recursive: true, force: true })
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
