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
  expect(matchesSingleCopyDeclaration(declared, "@nifra/core")).toBe(false)
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
