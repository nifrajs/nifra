import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getRecipe, listRecipeVersions, type UpgradeRecipe } from "../src/recipes/index.ts"
import {
  applyImportMoves,
  computeUpgrade,
  moveDependenciesText,
  pinSweepText,
  rewriteVersionSpec,
  runUpgrade,
} from "../src/upgrade.ts"

const FIXTURES = join(import.meta.dir, ".tmp-nifra-upgrade-fixtures")

afterEach(async () => {
  await rm(FIXTURES, { recursive: true, force: true })
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

  test("is idempotent — a second sweep makes no changes", () => {
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
