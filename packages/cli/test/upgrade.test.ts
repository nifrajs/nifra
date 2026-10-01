import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getRecipe, listRecipeVersions, type UpgradeRecipe } from "../src/recipes/index.ts"
import {
  applyImportMoves,
  chainRecipes,
  compareSemverSpec,
  computeUpgrade,
  installedGroupVersion,
  moveDependenciesText,
  pinSweepText,
  rewriteVersionSpec,
  runUpgrade,
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
    const chain = chainRecipes("3.6.0", "1.13.0")
    expect(chain.steps).toEqual(["2.0.0", "3.0.0", "3.6.0"])
    expect(chain.dependencyMoves).toEqual([
      { from: "@nifrajs/budget", to: "@nifrajs/core", toVersion: "2.0.0" },
    ])
    expect(chain.pins).toContainEqual({ match: "@nifrajs/", to: "3.6.0" })
    expect(chain.pins.filter((pin) => pin.match === "@nifrajs/")).toHaveLength(1)
    expect(chain.notes?.[0]).toStartWith("2.0.0: ")
    expect(chain.notes?.at(-1)).toStartWith("3.6.0: ")
    expect(chainRecipes("3.6.0", "3.0.0").steps).toEqual(["3.6.0"])
    expect(chainRecipes("3.6.0", "3.6.0").steps).toEqual([])
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
      runUpgrade(root, { version: "3.6.0", cliVersion: "3.6.0", write: true, verify: false }),
    )
    expect(result).toBe(true)
    expect(out).toContain("From 1.13.0, applying the 2.0.0, 3.0.0, 3.6.0 recipes.")
    const site = JSON.parse(await readFile(join(root, "apps", "site", "package.json"), "utf8"))
    expect(site.dependencies).toEqual({ "@nifrajs/core": "^3.6.0" })
    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    expect(rootManifest.dependencies).toEqual({
      "@nifrajs/core": "^3.6.0",
      "@nifrajs/web": "workspace:*",
      hono: "^4.0.0",
    })
    expect(await readFile(join(root, "apps", "site", "src", "app.ts"), "utf8")).toContain(
      '"@nifrajs/core/budget"',
    )
  })

  test("--exact pins the exact version", async () => {
    const root = await scaffoldV1("chain-exact")
    const { result } = await captureConsole(() =>
      runUpgrade(root, {
        version: "3.6.0",
        cliVersion: "3.6.0",
        write: true,
        exact: true,
        verify: false,
      }),
    )
    expect(result).toBe(true)
    const site = JSON.parse(await readFile(join(root, "apps", "site", "package.json"), "utf8"))
    expect(site.dependencies).toEqual({ "@nifrajs/core": "3.6.0" })
  })

  test("a target newer than the CLI prints that release's command and changes nothing", async () => {
    const root = await scaffoldV1("newer")
    const before = await readFile(join(root, "apps", "site", "package.json"), "utf8")
    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "3.7.0", cliVersion: "3.6.0", write: true, exact: true }),
    )
    expect(result).toBe(false)
    expect(out).toContain("bunx @nifrajs/cli@3.7.0 upgrade 3.7.0 --write --exact")
    expect(await readFile(join(root, "apps", "site", "package.json"), "utf8")).toBe(before)
  })

  test("a version that is not a release, or one this CLI has no recipe for, fails closed", async () => {
    const root = await scaffoldV1("bad-target")
    for (const version of ["^3.6.0", "3.6", "3.6.0; rm -rf /", "latest"]) {
      const { result, out } = await captureConsole(() =>
        runUpgrade(root, { version, cliVersion: "3.6.0" }),
      )
      expect(result).toBe(false)
      expect(out).toContain("is not a release version")
      expect(out).not.toContain("bunx")
    }
    const { result, out } = await captureConsole(() =>
      runUpgrade(root, { version: "3.2.0", cliVersion: "3.6.0" }),
    )
    expect(result).toBe(false)
    expect(out).toContain("This CLI upgrades to: 1.8.0, 2.0.0, 3.0.0, 3.6.0")
  })

  test("the targets are the recipes up to the CLI's version, and that version", () => {
    expect(upgradeTargets("3.5.0")).toEqual(["1.8.0", "2.0.0", "3.0.0", "3.5.0"])
    expect(upgradeTargets("3.6.0")).toEqual(["1.8.0", "2.0.0", "3.0.0", "3.6.0"])
  })
})
