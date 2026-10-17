import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ancestorPins } from "../src/init-agents.ts"
import { getRecipe, listRecipeVersions, type UpgradeRecipe } from "../src/recipes/index.ts"
import {
  applyImportMoves,
  chainRecipes,
  compareSemverSpec,
  computeUpgrade,
  installedGroupVersion,
  moveDependenciesText,
  pendingInstall,
  pinSweepText,
  rewriteVersionSpec,
  runUpgrade,
  specIncludes,
  specVersion,
  upgradeTargets,
} from "../src/upgrade.ts"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("tmp-nifra-upgrade-fixtures")

afterEach(() => {
  removeFixtureRoot(FIXTURES)
})

const RECIPE: UpgradeRecipe = {
  version: "1.8.0",
  pins: [{ match: "@nifrajs/", to: "1.8.0" }],
  importMoves: [{ from: "old-lib", to: "old-lib/nifra" }],
}

describe("published upgrade recipes", () => {
  test("offers the 2.0.0 GA migration target", () => {
    expect(listRecipeVersions()).toContain("2.0.0")
  })

  test("offers the 3.0.0 GA migration target that pins the fixed group", () => {
    expect(listRecipeVersions()).toContain("3.0.0")
    const recipe = getRecipe("3.0.0")
    expect(recipe?.pins).toContainEqual({ match: "@nifrajs/", to: "3.0.0" })
    expect(recipe?.importMoves).toEqual([])
  })

  test("2.0 migrates the fixed group and removed budget package without touching lookalikes", async () => {
    const root = join(FIXTURES, "v2-repo")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "app",
          dependencies: {
            "@nifrajs/budget": "^1.13.0",
            "@nifrajs/core": "^1.13.0",
            nifra: "~1.13.0",
            "nifra-plugin": "^1.0.0",
          },
          devDependencies: { "create-nifra": "1.13.0" },
        },
        null,
        2,
      ),
    )
    await writeFile(
      join(root, "src", "app.ts"),
      'import { budget } from "@nifrajs/budget"\nexport { budget }',
    )

    const recipe = getRecipe("2.0.0")
    expect(recipe).toBeDefined()
    const dryRun = computeUpgrade(root, recipe as UpgradeRecipe, false)
    expect(dryRun.dependencyMoves).toHaveLength(1)
    expect(dryRun.pins.some((pin) => pin.name === "@nifrajs/budget")).toBe(false)
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("@nifrajs/budget")
    const plan = computeUpgrade(root, recipe as UpgradeRecipe, true)
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))

    expect(manifest.dependencies["@nifrajs/core"]).toBe("^2.0.0")
    expect(manifest.dependencies["@nifrajs/budget"]).toBeUndefined()
    expect(manifest.dependencies.nifra).toBe("~2.0.0")
    expect(manifest.devDependencies["create-nifra"]).toBe("2.0.0")
    expect(manifest.dependencies["nifra-plugin"]).toBe("^1.0.0")
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toContain('"@nifrajs/core/budget"')
    expect(plan.importMoves).toHaveLength(1)
  })
})

// ── rewriteVersionSpec (pure) ─────────────────────────────────────────────────

describe("rewriteVersionSpec", () => {
  test("preserves the range operator", () => {
    expect(rewriteVersionSpec("^1.7.0", "1.8.0")).toBe("^1.8.0")
    expect(rewriteVersionSpec("~1.7.0", "1.8.0")).toBe("~1.8.0")
    expect(rewriteVersionSpec("1.7.0", "1.8.0")).toBe("1.8.0")
    expect(rewriteVersionSpec(">=1.7.0", "1.8.0")).toBe(">=1.8.0")
  })
  test("a strict bound becomes inclusive, so the result admits the target", () => {
    expect(rewriteVersionSpec(">1.7.0", "1.8.0")).toBe(">=1.8.0")
    expect(rewriteVersionSpec("<1.7.0", "1.8.0")).toBe("<=1.8.0")
    expect(rewriteVersionSpec("<=1.7.0", "1.8.0")).toBe("<=1.8.0")
  })
  test("skips non-semver / already-current specs (returns null)", () => {
    expect(rewriteVersionSpec("workspace:*", "1.8.0")).toBeNull()
    expect(rewriteVersionSpec("link:../x", "1.8.0")).toBeNull()
    expect(rewriteVersionSpec("*", "1.8.0")).toBeNull()
    expect(rewriteVersionSpec("latest", "1.8.0")).toBeNull()
    expect(rewriteVersionSpec("npm:@scope/pkg@1.0.0", "1.8.0")).toBeNull()
    expect(rewriteVersionSpec("^1.8.0", "1.8.0")).toBeNull() // no-op
  })
})

test("semver downgrade protection includes prerelease precedence", () => {
  expect(compareSemverSpec("2.3.0-beta", "2.3.0")).toBeLessThan(0)
  expect(compareSemverSpec("2.3.0", "2.3.0-beta")).toBeGreaterThan(0)
  expect(compareSemverSpec("2.3.0-beta.2", "2.3.0-beta.10")).toBeLessThan(0)
})

// ── pinSweepText (pure, format-preserving) ────────────────────────────────────

describe("pinSweepText", () => {
  test("bumps matching deps and preserves formatting + non-matching deps", () => {
    const pkg = JSON.stringify(
      {
        name: "app",
        dependencies: { "@nifrajs/core": "^1.7.0", zod: "^3.0.0" },
        devDependencies: { "@nifrajs/cli": "1.7.0", "@nifrajs/testing": "workspace:*" },
      },
      null,
      2,
    )
    const { text, changes } = pinSweepText(pkg, RECIPE.pins)
    expect(text).toContain('"@nifrajs/core": "^1.8.0"')
    expect(text).toContain('"@nifrajs/cli": "1.8.0"')
    expect(text).toContain('"zod": "^3.0.0"') // untouched
    expect(text).toContain('"@nifrajs/testing": "workspace:*"') // skipped
    expect(changes).toHaveLength(2)
  })

  test("is idempotent - a second sweep makes no changes", () => {
    const pkg = JSON.stringify({ dependencies: { "@nifrajs/core": "^1.7.0" } }, null, 2)
    const first = pinSweepText(pkg, RECIPE.pins)
    const second = pinSweepText(first.text, RECIPE.pins)
    expect(second.changes).toHaveLength(0)
    expect(second.text).toBe(first.text)
  })

  test("invalid JSON is left untouched", () => {
    const { text, changes } = pinSweepText("{ not json", RECIPE.pins)
    expect(changes).toHaveLength(0)
    expect(text).toBe("{ not json")
  })

  test("refuses a rollback (older target on a newer install) but keeps forward pins", () => {
    const pkg = JSON.stringify({ dependencies: { "@nifrajs/core": "^2.3.0" } }, null, 2)
    const { text, changes, downgrades } = pinSweepText(pkg, [{ match: "@nifrajs/", to: "2.0.0" }])
    expect(changes).toHaveLength(0)
    expect(downgrades).toEqual([
      { field: "dependencies", name: "@nifrajs/core", from: "^2.3.0", to: "^2.0.0" },
    ])
    expect(text).toBe(pkg) // untouched
  })

  test("applies a rollback only when explicitly allowed", () => {
    const pkg = JSON.stringify({ dependencies: { "@nifrajs/core": "^2.3.0" } }, null, 2)
    const { changes, downgrades } = pinSweepText(pkg, [{ match: "@nifrajs/", to: "2.0.0" }], true)
    expect(downgrades).toHaveLength(0)
    expect(changes).toEqual([
      { field: "dependencies", name: "@nifrajs/core", from: "^2.3.0", to: "^2.0.0" },
    ])
  })

  test("a forward upgrade is not treated as a downgrade", () => {
    const pkg = JSON.stringify({ dependencies: { "@nifrajs/core": "^2.0.0" } }, null, 2)
    const { changes, downgrades } = pinSweepText(pkg, [{ match: "@nifrajs/", to: "2.3.0" }])
    expect(downgrades).toHaveLength(0)
    expect(changes[0]?.to).toBe("^2.3.0")
  })

  test("overrides, resolutions and pnpm.overrides are swept in their own objects", () => {
    const pkg = JSON.stringify(
      {
        config: { overrides: { "@nifrajs/core": "1.7.0" } },
        dependencies: { "@nifrajs/core": "1.7.0" },
        overrides: {
          "@nifrajs/core": "1.7.0",
          "@nifrajs/web": "$@nifrajs/web",
          "some-lib": { ".": "2.0.0", "@nifrajs/client": "~1.7.0" },
        },
        resolutions: { "**/@nifrajs/web": "1.7.0", "nifra-lookalike": "1.7.0" },
        pnpm: { overrides: { "parent>@nifrajs/schema": "1.7.0", "@nifrajs/cli@<1.8": "1.7.0" } },
      },
      null,
      2,
    )
    const { text, changes } = pinSweepText(pkg, RECIPE.pins)
    expect(changes).toEqual([
      { field: "dependencies", name: "@nifrajs/core", from: "1.7.0", to: "1.8.0" },
      { field: "overrides", name: "@nifrajs/core", from: "1.7.0", to: "1.8.0" },
      { field: "overrides", name: "@nifrajs/client", from: "~1.7.0", to: "~1.8.0" },
      { field: "resolutions", name: "**/@nifrajs/web", from: "1.7.0", to: "1.8.0" },
      { field: "pnpm.overrides", name: "parent>@nifrajs/schema", from: "1.7.0", to: "1.8.0" },
      { field: "pnpm.overrides", name: "@nifrajs/cli@<1.8", from: "1.7.0", to: "1.8.0" },
    ])
    const parsed = JSON.parse(text)
    // A same-named key deeper in the document is not the package manager's field.
    expect(parsed.config.overrides["@nifrajs/core"]).toBe("1.7.0")
    expect(parsed.overrides["@nifrajs/web"]).toBe("$@nifrajs/web")
    expect(parsed.overrides["some-lib"]["."]).toBe("2.0.0")
    expect(parsed.resolutions["nifra-lookalike"]).toBe("1.7.0")
  })

  test("a nested override pins only the package it sits under", () => {
    const pkg = JSON.stringify(
      {
        overrides: {
          "@nifrajs/core": { ".": "1.7.0", "some-dep": { ".": "1.7.0" } },
          "some-lib": { ".": "1.7.0", "@nifrajs/core": "1.7.0" },
        },
      },
      null,
      2,
    )
    const { text, changes } = pinSweepText(pkg, RECIPE.pins)
    expect(changes).toEqual([
      { field: "overrides", name: ".", from: "1.7.0", to: "1.8.0" },
      { field: "overrides", name: "@nifrajs/core", from: "1.7.0", to: "1.8.0" },
    ])
    const parsed = JSON.parse(text)
    expect(parsed.overrides["@nifrajs/core"]).toEqual({
      ".": "1.8.0",
      "some-dep": { ".": "1.7.0" },
    })
    expect(parsed.overrides["some-lib"]).toEqual({ ".": "1.7.0", "@nifrajs/core": "1.8.0" })
  })

  test("an override above the target is a rollback like any pin", () => {
    const pkg = JSON.stringify({ overrides: { "@nifrajs/core": "2.3.0" } }, null, 2)
    const { downgrades } = pinSweepText(pkg, [{ match: "@nifrajs/", to: "2.0.0" }])
    expect(downgrades).toEqual([
      { field: "overrides", name: "@nifrajs/core", from: "2.3.0", to: "2.0.0" },
    ])
  })
})

describe("peer ranges", () => {
  test("specIncludes reads a single-comparator range as npm does", () => {
    expect(specIncludes(">=3.1.0", "5.2.0")).toBe(true)
    expect(specIncludes(">5.2.0", "5.2.0")).toBe(false)
    expect(specIncludes("<6.0.0", "5.2.0")).toBe(true)
    expect(specIncludes("<=5.1.0", "5.2.0")).toBe(false)
    expect(specIncludes("^5.0.0", "5.2.0")).toBe(true)
    expect(specIncludes("^4.0.0", "5.2.0")).toBe(false)
    expect(specIncludes("^0.3.0", "0.3.9")).toBe(true)
    expect(specIncludes("^0.3.0", "0.4.0")).toBe(false)
    expect(specIncludes("^0.0.3", "0.0.4")).toBe(false)
    expect(specIncludes("~5.1.0", "5.1.9")).toBe(true)
    expect(specIncludes("~5.1.0", "5.2.0")).toBe(false)
    expect(specIncludes("5.2.0", "5.2.0")).toBe(true)
    expect(specIncludes("=5.1.0", "5.2.0")).toBe(false)
    // A prerelease satisfies only a spec naming a prerelease of the same core.
    expect(specIncludes(">=5.0.0", "6.0.0-beta.1")).toBe(false)
    expect(specIncludes("^6.0.0-beta.0", "6.0.0-beta.1")).toBe(true)
    expect(specIncludes(">=3.1.0 <6", "5.2.0")).toBe(false)
    expect(specIncludes("workspace:*", "5.2.0")).toBe(false)
  })

  test("a peer range that admits the target is left; one that excludes it keeps its operator", () => {
    const pkg = JSON.stringify(
      {
        peerDependencies: {
          "@nifrajs/core": ">=3.1.0",
          "@nifrajs/web": "^5.0.0",
          "@nifrajs/client": "^4.0.0",
          "@nifrajs/schema": "~5.1.0",
        },
        devDependencies: { "@nifrajs/core": "5.1.0", "@nifrajs/web": "5.1.0" },
      },
      null,
      2,
    )
    const pins = [{ match: "@nifrajs/", to: "5.2.0" }]
    for (const exact of [false, true]) {
      const { changes, downgrades } = pinSweepText(pkg, pins, false, exact)
      expect(downgrades).toHaveLength(0)
      expect(changes).toEqual([
        { field: "devDependencies", name: "@nifrajs/core", from: "5.1.0", to: "5.2.0" },
        { field: "devDependencies", name: "@nifrajs/web", from: "5.1.0", to: "5.2.0" },
        { field: "peerDependencies", name: "@nifrajs/client", from: "^4.0.0", to: "^5.2.0" },
        { field: "peerDependencies", name: "@nifrajs/schema", from: "~5.1.0", to: "~5.2.0" },
      ])
    }
  })

  test("every rewritten range admits the target, and an upper bound that does is left alone", () => {
    for (const field of ["dependencies", "peerDependencies"]) {
      const pkg = JSON.stringify({
        [field]: {
          "@nifrajs/core": "<5.2.0",
          "@nifrajs/web": "<6.0.0",
          "@nifrajs/client": ">5.2.0",
          "@nifrajs/schema": "<=5.2.0",
        },
      })
      const { text, downgrades } = pinSweepText(pkg, [{ match: "@nifrajs/", to: "5.3.0" }])
      expect(downgrades).toEqual([])
      const after: Record<string, string> = JSON.parse(text)[field]
      for (const spec of Object.values(after)) expect(specIncludes(spec, "5.3.0")).toBe(true)
      expect(after["@nifrajs/web"]).toBe("<6.0.0")
    }
  })

  test("a peer floor is not the version a workspace upgrades from", async () => {
    const root = join(FIXTURES, "peer-floor")
    await mkdir(join(root, "packages", "lib"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "libs", private: true }))
    const lib = (dev: Record<string, string>) =>
      writeFile(
        join(root, "packages", "lib", "package.json"),
        JSON.stringify(
          { name: "lib", peerDependencies: { "@nifrajs/core": ">=3.1.0" }, devDependencies: dev },
          null,
          2,
        ),
      )
    await lib({})
    expect(installedGroupVersion(root)).toBe("3.1.0")
    await mkdir(join(root, "node_modules", "@nifrajs", "core"), { recursive: true })
    await writeFile(
      join(root, "node_modules", "@nifrajs", "core", "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "5.0.0" }),
    )
    expect(installedGroupVersion(root)).toBe("5.0.0")
    await lib({ "@nifrajs/core": "5.1.0" })
    expect(installedGroupVersion(root)).toBe("5.1.0")

    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
    try {
      expect(await runUpgrade(root, { version: "5.2.0", json: true, cliVersion: "5.2.0" })).toBe(
        true,
      )
    } finally {
      log.mockRestore()
    }
    const report = Object(JSON.parse(lines.join("\n")))
    expect(Reflect.get(report, "from")).toBe("5.1.0")
    expect(Reflect.get(report, "steps")).toEqual(["5.2.0"])
    expect(Reflect.get(report, "pins")).toEqual([
      {
        file: "packages/lib/package.json",
        field: "devDependencies",
        name: "@nifrajs/core",
        from: "5.1.0",
        to: "5.2.0",
      },
    ])
  })
})

describe("moveDependenciesText", () => {
  test("renames a removed dependency when its replacement is not already declared", () => {
    const manifest = JSON.stringify({ dependencies: { "@nifrajs/budget": "~1.13.0" } }, null, 2)
    const result = moveDependenciesText(manifest, [
      { from: "@nifrajs/budget", to: "@nifrajs/core", toVersion: "2.0.0" },
    ])
    expect(result.text).toContain('"@nifrajs/core": "~2.0.0"')
    expect(result.text).not.toContain("@nifrajs/budget")
    expect(result.changes[0]?.action).toBe("renamed")
  })

  test("keeps a runtime replacement when core exists only as a dev dependency", () => {
    const manifest = JSON.stringify(
      {
        dependencies: { "@nifrajs/budget": "^1.13.0" },
        devDependencies: { "@nifrajs/core": "^1.13.0" },
      },
      null,
      2,
    )
    const result = moveDependenciesText(manifest, [
      { from: "@nifrajs/budget", to: "@nifrajs/core", toVersion: "2.0.0" },
    ])
    const moved = JSON.parse(result.text)

    expect(moved.dependencies["@nifrajs/core"]).toBe("^2.0.0")
    expect(moved.dependencies["@nifrajs/budget"]).toBeUndefined()
    expect(moved.devDependencies["@nifrajs/core"]).toBe("^1.13.0")
    expect(result.changes[0]?.action).toBe("renamed")
  })

  test("removing the last entry, or one between others, leaves valid JSON", () => {
    for (const order of [
      ["@nifrajs/core", "@nifrajs/web", "@nifrajs/web-legacy"],
      ["@nifrajs/web-legacy", "@nifrajs/core", "@nifrajs/web"],
      ["@nifrajs/core", "@nifrajs/web-legacy", "@nifrajs/web"],
    ]) {
      const manifest = `${JSON.stringify(
        { name: "app", dependencies: Object.fromEntries(order.map((name) => [name, "^3.0.0"])) },
        null,
        2,
      )}\n`
      const result = moveDependenciesText(manifest, [
        { from: "@nifrajs/web-legacy", to: "@nifrajs/web", toVersion: "4.0.0" },
      ])
      expect(result.changes[0]?.action).toBe("removed")
      expect(Object.keys(JSON.parse(result.text).dependencies)).toEqual(
        order.filter((name) => name !== "@nifrajs/web-legacy"),
      )
    }
  })
})

// ── applyImportMoves (pure) ───────────────────────────────────────────────────

describe("applyImportMoves", () => {
  test("rewrites exact import/export/require/dynamic specifiers", () => {
    const src = [
      `import { cache } from "old-lib"`,
      `export { x } from 'old-lib'`,
      `const c = require("old-lib")`,
      `const d = await import("old-lib")`,
      `import "old-lib"`,
    ].join("\n")
    const { text, changes } = applyImportMoves(src, RECIPE.importMoves)
    expect(text).not.toContain('"old-lib"')
    expect(text).not.toContain("'old-lib'")
    expect(changes[0]?.count).toBe(5)
  })

  test("does NOT touch a different package with the same prefix", () => {
    const src = `import { x } from "old-lib-utils"`
    const { text, changes } = applyImportMoves(src, RECIPE.importMoves)
    expect(text).toBe(src) // exact-source match only
    expect(changes).toHaveLength(0)
  })

  test("is idempotent", () => {
    const src = `import { cache } from "old-lib"`
    const once = applyImportMoves(src, RECIPE.importMoves)
    const twice = applyImportMoves(once.text, RECIPE.importMoves)
    expect(twice.changes).toHaveLength(0)
  })
})

// ── computeUpgrade + runUpgrade (integration on a fixture repo) ────────────────

async function scaffold(): Promise<string> {
  const root = join(FIXTURES, "repo")
  await mkdir(join(root, "packages", "web", "src"), { recursive: true })
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "root", dependencies: { "@nifrajs/core": "^1.7.0" } }, null, 2),
  )
  await writeFile(
    join(root, "packages", "web", "package.json"),
    JSON.stringify({ name: "web", dependencies: { "@nifrajs/web": "1.7.0" } }, null, 2),
  )
  await writeFile(
    join(root, "packages", "web", "src", "app.ts"),
    `import { cache } from "old-lib"\nexport const x = cache`,
  )
  return root
}

describe("computeUpgrade / runUpgrade", () => {
  test("dry-run computes the plan but writes nothing", async () => {
    const root = await scaffold()
    const plan = computeUpgrade(root, RECIPE, false)
    expect(plan.pins).toHaveLength(2) // both package.json files
    expect(plan.importMoves).toHaveLength(1)
    // Files unchanged on dry-run.
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("^1.7.0")
    expect(await readFile(join(root, "packages/web/src/app.ts"), "utf8")).toContain('"old-lib"')
  })

  test("--write applies edits across the workspace and is idempotent", async () => {
    const root = await scaffold()
    const first = computeUpgrade(root, RECIPE, true)
    expect(first.pins).toHaveLength(2)
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("^1.8.0")
    expect(await readFile(join(root, "packages/web/package.json"), "utf8")).toContain('"1.8.0"')
    expect(await readFile(join(root, "packages/web/src/app.ts"), "utf8")).toContain(
      '"old-lib/nifra"',
    )
    // Second pass: nothing left to change.
    const second = computeUpgrade(root, RECIPE, true)
    expect(second.pins).toHaveLength(0)
    expect(second.importMoves).toHaveLength(0)
  })

  test("versions pinned outside package.json are listed with their line and never edited", async () => {
    const root = await scaffold()
    const files: Record<string, string> = {
      "tools/.mcp.json":
        '{\n  "mcpServers": {\n    "nifra": { "command": "bunx", "args": ["@nifrajs/cli@1.7.0", "mcp"] }\n  }\n}\n',
      "infra/Dockerfile": "FROM oven/bun:1\nRUN bun add -g nifra@1.7.0 create-nifra@1.8.0\n",
      "infra/build.bun.lock":
        '{\n  "packages": {\n    "@nifrajs/core": ["@nifrajs/core@1.7.0"],\n    "@nifrajs/web": ["@nifrajs/web@1.7.0"]\n  }\n}\n',
      "bun.lock": '{ "packages": { "@nifrajs/core": ["@nifrajs/core@1.7.0"] } }\n',
      ".github/workflows/ci.yml": "steps:\n  - run: bunx @scope/nifra@1.7.0 check\n",
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), text)
    }
    const plan = computeUpgrade(root, RECIPE, true)
    expect(plan.agentPins).toEqual([])
    expect(plan.strayPins).toEqual([
      { file: "infra/Dockerfile", line: 2, pin: "nifra@1.7.0", lockfile: false, more: 0 },
      {
        file: "infra/build.bun.lock",
        line: 3,
        pin: "@nifrajs/core@1.7.0",
        lockfile: true,
        more: 1,
      },
      { file: "tools/.mcp.json", line: 3, pin: "@nifrajs/cli@1.7.0", lockfile: false, more: 0 },
    ])
    for (const [path, text] of Object.entries(files))
      expect(await readFile(join(root, path), "utf8")).toBe(text)
  })

  const registry = (version: string): string =>
    `{\n  "mcpServers": {\n    "nifra": { "command": "bunx", "args": ["@nifrajs/cli@${version}", "mcp"] }\n  }\n}\n`
  const agentFiles = (version: string): Record<string, string> => ({
    ".mcp.json": registry(version),
    ".cursor/mcp.json": registry(version),
    "CLAUDE.md": `# CLAUDE.md\n\nLaunch: \`bunx @nifrajs/cli@${version} mcp\`\n`,
    "AGENTS.md": `# AGENTS.md\n\nBuilt on @nifrajs/core@1.7.0.\n\n## MCP server\n\n\`bunx @nifrajs/cli@${version} mcp\`\n`,
  })
  const writeAll = async (root: string, files: Record<string, string>): Promise<void> => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), text)
    }
  }

  test("the MCP launch pin in the agent files moves to the target; other pins there are listed", async () => {
    const root = await scaffold()
    await writeAll(root, agentFiles("1.7.0"))
    const preview = computeUpgrade(root, RECIPE, false)
    const moved = [".mcp.json", ".cursor/mcp.json", "CLAUDE.md", "AGENTS.md"].map((file) => ({
      file,
      from: ["1.7.0"],
      to: "1.8.0",
    }))
    expect(preview.agentPins).toEqual(moved)
    // The dry run lists what --write leaves: the launch pins move, the AGENTS.md prose does not.
    const prose = {
      file: "AGENTS.md",
      line: 3,
      pin: "@nifrajs/core@1.7.0",
      lockfile: false,
      more: 0,
    }
    expect(preview.strayPins).toEqual([prose])
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(registry("1.7.0"))

    const applied = computeUpgrade(root, RECIPE, true)
    expect(applied.agentPins).toEqual(moved)
    expect(applied.strayPins).toEqual([prose])
    const expected = agentFiles("1.8.0")
    for (const [path, text] of Object.entries(expected))
      expect(await readFile(join(root, path), "utf8")).toBe(text)
    expect(computeUpgrade(root, RECIPE, true).agentPins).toEqual([])
  })

  test("a workspace root's launch that serves the project moves with it", async () => {
    const root = join(FIXTURES, "member-repo")
    const app = join(root, "app")
    await mkdir(join(root, ".git"), { recursive: true })
    await mkdir(app, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["app"] }))
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "1.7.0" } }),
    )
    const launch = (version: string) =>
      `{ "mcpServers": { "nifra": { "command": "bunx", "args": ["@nifrajs/cli@${version}", "mcp", "app"] } } }\n`
    await writeFile(join(root, ".mcp.json"), launch("1.7.0"))
    const above = (await ancestorPins(app)).owned
    const moved = [{ file: "../.mcp.json", from: ["1.7.0"], to: "1.8.0" }]
    expect(computeUpgrade(app, RECIPE, false, false, false, above).agentPins).toEqual(moved)
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(launch("1.7.0"))
    expect(computeUpgrade(app, RECIPE, true, false, false, above).agentPins).toEqual(moved)
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(launch("1.8.0"))
  })

  test("a project that declares @nifrajs/cli drops the launch pin; a root launch above it stays pinned", async () => {
    const root = join(FIXTURES, "declaring-repo")
    const app = join(root, "app")
    await mkdir(join(root, ".git"), { recursive: true })
    await mkdir(app, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["app"] }))
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "app", devDependencies: { "@nifrajs/cli": "1.7.0" } }),
    )
    await writeAll(app, agentFiles("1.7.0"))
    const launch = (spec: string) =>
      `{ "mcpServers": { "nifra": { "command": "bunx", "args": ["${spec}", "mcp", "app"] } } }\n`
    await writeFile(join(root, ".mcp.json"), launch("@nifrajs/cli@1.7.0"))
    const above = (await ancestorPins(app)).owned
    const plan = computeUpgrade(app, RECIPE, true, false, false, above)
    expect(plan.agentPins).toEqual([
      ...[".mcp.json", ".cursor/mcp.json", "CLAUDE.md", "AGENTS.md"].map((file) => ({
        file,
        from: ["1.7.0"],
        to: "unpinned",
      })),
      { file: "../.mcp.json", from: ["1.7.0"], to: "1.8.0" },
    ])
    expect(await readFile(join(app, ".mcp.json"), "utf8")).toBe(
      registry("1.7.0").replace("@nifrajs/cli@1.7.0", "@nifrajs/cli"),
    )
    expect(await readFile(join(app, "CLAUDE.md"), "utf8")).toContain("`bunx @nifrajs/cli mcp`")
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(launch("@nifrajs/cli@1.8.0"))
    expect(computeUpgrade(app, RECIPE, true, false, false, above).agentPins).toEqual([])
  })

  test("a symlinked agent file or folder is never written through", async () => {
    const root = await scaffold()
    const outside = join(root, "..", "outside-agent-files")
    await writeAll(outside, agentFiles("1.7.0"))
    await symlink(join(outside, ".cursor"), join(root, ".cursor"))
    await symlink(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"))
    const plan = computeUpgrade(root, RECIPE, true)
    expect(plan.agentPins).toEqual([])
    for (const [path, text] of Object.entries(agentFiles("1.7.0")))
      expect(await readFile(join(outside, path), "utf8")).toBe(text)
  })

  test("an override counts as an installed version", async () => {
    const root = join(FIXTURES, "overridden")
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@nifrajs/core": "1.8.0" },
        overrides: { "@nifrajs/core": "1.7.0" },
      }),
    )
    expect(installedGroupVersion(root)).toBe("1.7.0")
  })

  test("build output and coverage at the workspace root are left alone", async () => {
    const root = await scaffold()
    for (const dir of ["dist", "build", "coverage"]) {
      await mkdir(join(root, dir), { recursive: true })
      await writeFile(join(root, dir, "app.js"), `import { cache } from "old-lib"\n`)
      await writeFile(
        join(root, dir, "package.json"),
        JSON.stringify({ dependencies: { "@nifrajs/core": "^1.7.0" } }),
      )
    }
    const plan = computeUpgrade(root, RECIPE, true)
    expect(plan.pins).toHaveLength(2)
    expect(plan.importMoves).toHaveLength(1)
    for (const dir of ["dist", "build", "coverage"])
      expect(await readFile(join(root, dir, "app.js"), "utf8")).toContain('"old-lib"')
  })

  test("runUpgrade fails closed on an unknown version", async () => {
    const root = await scaffold()
    const ok = await runUpgrade(root, { version: "9.9.9", verify: false })
    expect(ok).toBe(false)
  })

  test("runUpgrade fails closed when no version is given", async () => {
    const root = await scaffold()
    const ok = await runUpgrade(root, { verify: false })
    expect(ok).toBe(false)
  })

  test("--list returns available targets", async () => {
    const ok = await runUpgrade(process.cwd(), { list: true, json: true })
    expect(ok).toBe(true)
  })

  test("--list shows the notes of every release after the declared one", async () => {
    const root = join(FIXTURES, "list-notes")
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "^5.0.0" } }),
    )
    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
    try {
      expect(await runUpgrade(root, { list: true, cliVersion: "5.1.0" })).toBe(true)
      expect(await runUpgrade(root, { list: true, json: true, cliVersion: "5.1.0" })).toBe(true)
    } finally {
      log.mockRestore()
    }
    const [text, json] = lines
    expect(text).toContain("this project declares 5.0.0")
    expect(text).toContain("  5.0.0  (declared)\n  5.1.0\n    - `merge()` now recompiles")
    // A release at or below the declared one is listed by version only.
    expect(text).not.toContain("@nifra-gate-reviewed")
    const parsed: unknown = JSON.parse(json ?? "{}")
    expect(Reflect.get(Object(parsed), "installed")).toBe("5.0.0")
    const notes = Reflect.get(Object(parsed), "notes")
    expect(Reflect.get(notes, "5.1.0")).toEqual(getRecipe("5.1.0")?.notes ?? ["missing"])
    expect(Reflect.get(notes, "5.0.0")).toEqual(getRecipe("5.0.0")?.notes ?? ["missing"])
  })

  test("every minor and major release this CLI offers has its own recipe", () => {
    for (const version of upgradeTargets("5.1.0").filter((v) => /^\d+\.\d+\.0$/.test(v)))
      if (compareSemverSpec(version, "5.0.0") >= 0) expect(getRecipe(version)).toBeDefined()
  })

  test("an upgrade across 5.1.0 carries its notes", () => {
    const chained = chainRecipes("5.1.0", "5.0.0")
    expect(
      (chained.notes ?? []).some((note) => note.startsWith("5.1.0: `merge()` now recompiles")),
    ).toBe(true)
  })

  test("an upgrade from 5.0 to 5.4 carries the notes of every minor, in order", () => {
    const notes = chainRecipes("5.4.0", "5.0.0").notes ?? []
    const at = (prefix: string) => notes.findIndex((note) => note.startsWith(prefix))
    const order = [
      at("5.1.0: "),
      at("5.2.0: A closed request-header schema"),
      at("5.2.0: The development `unusedScopedHooks` audit"),
      at("5.2.0: The Bun build"),
      at("5.3.0: A route answering `status(code, body)`"),
      at("5.3.0: `nifra check` adds NF-C045"),
      at("5.3.0: `nifra upgrade` leaves a `peerDependencies` range"),
      at("5.4.0: The server entry a `node` build generates"),
      at("5.4.0: Static files carry a strong `ETag`"),
      at("5.4.0: On Bun, `servePublicDir`"),
    ]
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order.toSorted((a, b) => a - b)).toEqual(order)
  })
})

// ── chained upgrades across releases ──────────────────────────────────────────

async function scaffoldV1(name: string): Promise<string> {
  const root = join(FIXTURES, name)
  await mkdir(join(root, "apps", "site", "src"), { recursive: true })
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "root",
        dependencies: { "@nifrajs/core": "^2.4.0", "@nifrajs/web": "workspace:*", hono: "^4.0.0" },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(root, "apps", "site", "package.json"),
    JSON.stringify(
      { name: "site", dependencies: { "@nifrajs/budget": "^1.13.0", "@nifrajs/core": "^1.13.0" } },
      null,
      2,
    ),
  )
  await writeFile(
    join(root, "apps", "site", "src", "app.ts"),
    'import { budget } from "@nifrajs/budget"\nexport { budget }',
  )
  return root
}

const captureConsole = async <T>(run: () => Promise<T>): Promise<{ result: T; out: string }> => {
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
  const error = spyOn(console, "error").mockImplementation((...args) => lines.push(args.join(" ")))
  try {
    return { result: await run(), out: lines.join("\n") }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

describe("chained upgrades", () => {
  test("specVersion reads the version a plain spec names", () => {
    expect(specVersion("^2.4.1")).toBe("2.4.1")
    expect(specVersion("3.0.0-beta.2")).toBe("3.0.0-beta.2")
    expect(specVersion("workspace:*")).toBeNull()
    expect(specVersion("^2.0.0 || ^3.0.0")).toBeNull()
  })

  test("the installed version is the lowest fixed-group version any package declares", async () => {
    const root = await scaffoldV1("installed")
    expect(installedGroupVersion(root)).toBe("1.13.0")
    const empty = join(FIXTURES, "no-group")
    await mkdir(empty, { recursive: true })
    await writeFile(
      join(empty, "package.json"),
      JSON.stringify({ dependencies: { hono: "4.0.0" } }),
    )
    expect(installedGroupVersion(empty)).toBeNull()
  })

  test("chains every recipe after the installed version up to the target, oldest first", () => {
    const chain = chainRecipes("4.0.0", "1.13.0")
    expect(chain.steps).toEqual(["2.0.0", "3.0.0", "4.0.0"])
    expect(chain.dependencyMoves).toEqual([
      { from: "@nifrajs/budget", to: "@nifrajs/core", toVersion: "2.0.0" },
    ])
    expect(chain.pins).toContainEqual({ match: "@nifrajs/", to: "4.0.0" })
    expect(chain.pins.filter((pin) => pin.match === "@nifrajs/")).toHaveLength(1)
    expect(chain.notes?.[0]).toStartWith("2.0.0: ")
    expect(chain.notes?.at(-1)).toStartWith("4.0.0: ")
    expect(chainRecipes("4.0.0", "3.0.0").steps).toEqual(["4.0.0"])
    expect(chainRecipes("4.0.0", "4.0.0").steps).toEqual([])
  })

  test("5.0.0 pins the group and names each changed default and how to keep the old one", () => {
    const chain = chainRecipes("5.0.0", "4.0.2")
    expect(chain.steps).toEqual(["5.0.0"])
    expect(chain.pins).toContainEqual({ match: "@nifrajs/", to: "5.0.0" })
    const notes = chain.notes?.join("\n") ?? ""
    expect(notes).toContain("export const inLayouts = false")
    expect(notes).toContain("NF-C034")
    expect(notes).toContain("nifra fix --code NF-C035")
    expect(notes).toContain("NF-C040")
    expect(notes).toContain("app.ws()")
    expect(notes).toContain("500")
    expect(chainRecipes("5.0.0", "3.5.0").steps).toEqual(["4.0.0", "5.0.0"])
  })

  test("4.0.0 moves the retired backend-only marker import and leads with the layout move", () => {
    const chain = chainRecipes("4.0.0", "3.5.0")
    expect(chain.steps).toEqual(["4.0.0"])
    expect(chain.importMoves).toContainEqual({
      from: "@nifrajs/web/server-only",
      to: "@nifrajs/web/backend-only",
    })
    expect(chain.notes?.[0]).toStartWith("4.0.0: Run `nifra migrate layout`")
    // What a test suite or tool reads off the wire changed too: the handover and the ISR headers.
    const notes = chain.notes?.join("\n") ?? ""
    expect(notes).toContain('id="__nifra-handover"')
    expect(notes).toContain("window.__NIFRA_DATA__")
    expect(notes).toContain("`x-nifra-isr-revalidate` and `x-nifra-isr-tags`")
  })

  test("a target without a recipe pins the fixed group; an unknown install runs only the target's", () => {
    const pinOnly = chainRecipes("3.5.0", "3.0.0")
    expect(pinOnly.steps).toEqual([])
    expect(pinOnly.pins).toEqual([
      { match: "@nifrajs/", to: "3.5.0" },
      { match: "create-nifra", to: "3.5.0" },
      { match: "nifra", to: "3.5.0" },
    ])
    expect(chainRecipes("3.0.0", null).steps).toEqual(["3.0.0"])
    expect(chainRecipes("3.5.0", null).steps).toEqual([])
  })

  test("one run takes a 1.x workspace to the target, moving the removed package on the way", async () => {
    const root = await scaffoldV1("chain-write")
    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "4.0.0", cliVersion: "4.0.0", write: true, verify: false }),
    )
    expect(result).toBe(true)
    expect(out).toContain("From 1.13.0, applying the 2.0.0, 3.0.0, 4.0.0 recipes.")
    const site = JSON.parse(await readFile(join(root, "apps", "site", "package.json"), "utf8"))
    expect(site.dependencies).toEqual({ "@nifrajs/core": "^4.0.0" })
    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    expect(rootManifest.dependencies).toEqual({
      "@nifrajs/core": "^4.0.0",
      "@nifrajs/web": "workspace:*",
      hono: "^4.0.0",
    })
    expect(await readFile(join(root, "apps", "site", "src", "app.ts"), "utf8")).toContain(
      '"@nifrajs/core/budget"',
    )
  })

  interface UpgradeReport {
    readonly write: boolean
    readonly check?: { readonly ok: boolean }
    readonly install?: unknown
  }
  const jsonUpgrade = async (root: string): Promise<{ result: boolean; report: UpgradeReport }> => {
    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = await runUpgrade(root, {
        version: "4.0.0",
        cliVersion: "4.0.0",
        write: true,
        json: true,
        hooks: false,
      })
      return { result, report: JSON.parse(lines.join("\n")) }
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  }

  test("--write leaves the check until the edited pins are installed", async () => {
    const root = await scaffoldV1("chain-uninstalled")
    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "4.0.0", cliVersion: "4.0.0", write: true, hooks: false }),
    )
    expect(result).toBe(true)
    expect(out).toContain(
      "Not checked yet: `nifra check` reads the installed packages, and the edited pins are not installed yet, so it would judge the release this upgrade leaves rather than 4.0.0. Install, then check:\n  bun install\n  nifra check",
    )
    expect(out).not.toContain("upgrade applied but")

    const json = await jsonUpgrade(await scaffoldV1("chain-uninstalled-json"))
    expect(json.result).toBe(true)
    expect(json.report.check).toBeUndefined()
    expect(json.report.install).toEqual({ command: "bun install", installed: [] })
  })

  test("--write --json verifies inside the one JSON document once the target is installed", async () => {
    const root = await scaffoldV1("chain-json-verify")
    await captureConsole(() =>
      runUpgrade(root, { version: "4.0.0", cliVersion: "4.0.0", write: true, verify: false }),
    )
    const { result, report } = await jsonUpgrade(root)
    expect(report.write).toBe(true)
    expect(report.install).toBeUndefined()
    expect(typeof report.check?.ok).toBe("boolean")
    expect(result).toBe(report.check?.ok === true)
  }, 120_000)

  test("an install below the target, or a lockfile, decides what the deferred check names", async () => {
    const root = join(FIXTURES, "installed-below")
    const core = join(root, "node_modules", "@nifrajs", "core")
    await mkdir(core, { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "4.0.0" } }),
    )
    await writeFile(
      join(core, "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "3.7.0" }),
    )
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    const plan = computeUpgrade(root, chainRecipes("4.0.0", "4.0.0"), false)
    expect(plan.pins).toEqual([])
    expect(pendingInstall(root, plan)).toEqual({
      command: "pnpm install",
      installed: [{ package: "@nifrajs/core", version: "3.7.0" }],
    })
    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "4.0.0", cliVersion: "4.0.0", write: true, hooks: false }),
    )
    expect(result).toBe(true)
    expect(out).toContain("and node_modules still holds @nifrajs/core 3.7.0, so it would judge")
    expect(out).toContain("  pnpm install\n  nifra check")

    await writeFile(
      join(core, "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "4.0.0" }),
    )
    expect(pendingInstall(root, plan)).toBeUndefined()
  })

  test("--exact pins the exact version", async () => {
    const root = await scaffoldV1("chain-exact")
    const { result } = await captureConsole(() =>
      runUpgrade(root, {
        version: "4.0.0",
        cliVersion: "4.0.0",
        write: true,
        exact: true,
        verify: false,
      }),
    )
    expect(result).toBe(true)
    const site = JSON.parse(await readFile(join(root, "apps", "site", "package.json"), "utf8"))
    expect(site.dependencies).toEqual({ "@nifrajs/core": "4.0.0" })
  })

  test("a target newer than the CLI prints that release's command and changes nothing", async () => {
    const root = await scaffoldV1("newer")
    const before = await readFile(join(root, "apps", "site", "package.json"), "utf8")
    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "3.7.0", cliVersion: "4.0.0", write: true, exact: true }),
    )
    expect(result).toBe(false)
    expect(out).toContain("bunx @nifrajs/cli@3.7.0 upgrade 3.7.0 --write --exact")
    expect(await readFile(join(root, "apps", "site", "package.json"), "utf8")).toBe(before)
  })

  test("a version that is not a release, or one this CLI has no recipe for, fails closed", async () => {
    const root = await scaffoldV1("bad-target")
    for (const version of ["^4.0.0", "3.6", "4.0.0; rm -rf /", "latest"]) {
      const { result, out } = await captureConsole(() =>
        runUpgrade(root, { version, cliVersion: "4.0.0" }),
      )
      expect(result).toBe(false)
      expect(out).toContain("is not a release version")
      expect(out).not.toContain("bunx")
    }
    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "3.2.0", cliVersion: "4.0.0" }),
    )
    expect(result).toBe(false)
    expect(out).toContain("This CLI upgrades to: 1.8.0, 2.0.0, 3.0.0, 4.0.0")
  })

  test("the targets are the recipes up to the CLI's version, and that version", () => {
    expect(upgradeTargets("3.5.0")).toEqual(["1.8.0", "2.0.0", "3.0.0", "3.5.0"])
    expect(upgradeTargets("4.0.0")).toEqual(["1.8.0", "2.0.0", "3.0.0", "4.0.0"])
    expect(upgradeTargets("5.0.0")).toEqual(["1.8.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"])
  })

  test("5.0.0 lists each retired review comment with the line it covered and never rewrites one", async () => {
    const root = join(FIXTURES, "retired-review")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@nifrajs/core": "^4.0.2" } }),
    )
    const source = [
      "// @nifra-gate-reviewed: compares our own token",
      "// with the one we wrote.",
      "if (token === expected) ok()",
      "const flag = 1 // @nifra-gate-reviewed",
      "// @nifra-gate-reviewed",
      "",
      "const later = 2",
    ].join("\n")
    await writeFile(join(root, "src", "auth.ts"), source)

    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "5.0.0", cliVersion: "5.0.0", write: true, verify: false }),
    )
    expect(result).toBe(true)
    expect(out).toContain("3 retired comment(s)")
    expect(out).toContain(
      "src/auth.ts:1  @nifra-gate-reviewed  covers line 3: if (token === expected) ok()",
    )
    expect(out).toContain("src/auth.ts:4  @nifra-gate-reviewed  covers line 4: const flag = 1")
    expect(out).toContain("src/auth.ts:5  @nifra-gate-reviewed  covers no line")
    expect(out).toContain("write instead: // nifra-expect <code>: <reason>")
    expect(await readFile(join(root, "src", "auth.ts"), "utf8")).toBe(source)
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies).toEqual({
      "@nifrajs/core": "^5.0.0",
    })

    const plan = computeUpgrade(root, chainRecipes("5.0.0", "4.0.2"), false)
    expect(plan.retiredMarkers.map((site) => [site.line, site.covers?.line])).toEqual([
      [1, 3],
      [4, 4],
      [5, undefined],
    ])
  })
})

// ── linked repositories on another nifra ──────────────────────────────────────

describe("a linked repository that loads its own nifra", () => {
  async function linkedLayout(name: string, kitCore: string | "app-copy"): Promise<string> {
    const base = join(FIXTURES, name)
    const app = join(base, "app")
    const kit = join(base, "kit")
    await mkdir(join(app, "node_modules", "@team"), { recursive: true })
    await mkdir(join(app, "node_modules", "@nifrajs", "core"), { recursive: true })
    await writeFile(
      join(app, "package.json"),
      JSON.stringify(
        { name: "app", dependencies: { "@nifrajs/core": "^5.0.0", "@team/kit": "link:../kit" } },
        null,
        2,
      ),
    )
    await writeFile(
      join(app, "node_modules", "@nifrajs", "core", "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "5.0.0" }),
    )
    await mkdir(join(kit, "node_modules", "@nifrajs"), { recursive: true })
    await writeFile(
      join(kit, "package.json"),
      JSON.stringify({ name: "@team/kit", dependencies: { "@nifrajs/core": "^5.0.0" } }),
    )
    if (kitCore === "app-copy") {
      await symlink(
        join(app, "node_modules", "@nifrajs", "core"),
        join(kit, "node_modules", "@nifrajs", "core"),
      )
    } else {
      await mkdir(join(kit, "node_modules", "@nifrajs", "core"), { recursive: true })
      await writeFile(
        join(kit, "node_modules", "@nifrajs", "core", "package.json"),
        JSON.stringify({ name: "@nifrajs/core", version: kitCore }),
      )
    }
    await symlink(kit, join(app, "node_modules", "@team", "kit"))
    return app
  }

  const quiet = async <T>(act: () => Promise<T>): Promise<{ value: T; out: string }> => {
    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
    const error = spyOn(console, "error").mockImplementation((...args) =>
      lines.push(args.join(" ")),
    )
    const warn = spyOn(console, "warn").mockImplementation((...args) => lines.push(args.join(" ")))
    try {
      return { value: await act(), out: lines.join("\n") }
    } finally {
      log.mockRestore()
      error.mockRestore()
      warn.mockRestore()
    }
  }
  const options = { version: "5.1.0", cliVersion: "5.1.0", verify: false, hooks: false } as const

  test("--write refuses before editing, naming the repository and its commands", async () => {
    const app = await linkedLayout("skew-refused", "5.0.0")
    const before = await readFile(join(app, "package.json"), "utf8")
    const { value, out } = await quiet(() => runUpgrade(app, { ...options, write: true }))
    expect(value).toBe(false)
    expect(await readFile(join(app, "package.json"), "utf8")).toBe(before)
    expect(out).toContain("Blocked: 1 linked repository loads its own nifra at another version")
    expect(out).toContain("@team/kit (package.json) at ../kit: @nifrajs/core 5.0.0")
    expect(out).toContain("cd ../kit && nifra upgrade 5.1.0 --write && bun install")
  })

  test("a dry run prints the plan and the blocker, and fails", async () => {
    const app = await linkedLayout("skew-dry", "5.0.0")
    const { value, out } = await quiet(() => runUpgrade(app, options))
    expect(value).toBe(false)
    expect(out).toContain("Planned")
    expect(out).toContain("Blocked:")
  })

  test("--allow-linked-skew writes and still names it", async () => {
    const app = await linkedLayout("skew-allowed", "5.0.0")
    const { value, out } = await quiet(() =>
      runUpgrade(app, { ...options, write: true, allowLinkedSkew: true }),
    )
    expect(value).toBe(true)
    expect(await readFile(join(app, "package.json"), "utf8")).toContain('"^5.1.0"')
    expect(out).toContain("Allowed by --allow-linked-skew")
  })

  test("a linked repository already on the target does not block", async () => {
    const app = await linkedLayout("skew-none", "5.1.0")
    const { value } = await quiet(() => runUpgrade(app, { ...options, write: true }))
    expect(value).toBe(true)
  })

  test("a linked repository resolving this project's copy follows its install", async () => {
    const app = await linkedLayout("skew-follows", "app-copy")
    const { value } = await quiet(() => runUpgrade(app, { ...options, write: true }))
    expect(value).toBe(true)
  })
})
