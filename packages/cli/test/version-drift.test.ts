import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectDoctorResult } from "../src/doctor.ts"
import type { UpgradeRecipe } from "../src/recipes/index.ts"
import { runRuleRegistry } from "../src/rules/index.ts"
import { legacyRules } from "../src/rules/legacy.ts"
import { computeUpgrade } from "../src/upgrade.ts"
import { collectVersionDrift, versionDriftMessage } from "../src/version-drift.ts"
import { writeAppFile } from "./fixture-root.ts"
import { projectFacts } from "./rule-facts.ts"

const created: string[] = []
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * A workspace pinning two group versions, with one installed package real and one linked from a
 * repository outside the root, plus a symlinked package directory and package.json file that point
 * there too.
 */
function linkedWorkspace() {
  const root = scratch("nifra-drift-")
  const outside = scratch("nifra-linked-")
  writeAppFile(
    root,
    "package.json",
    json({ name: "app", dependencies: { "@nifrajs/core": "4.0.2" } }),
  )
  writeAppFile(
    root,
    "packages/api/package.json",
    json({ name: "api", dependencies: { "@nifrajs/web": "^4.0.1" } }),
  )
  writeAppFile(
    root,
    "node_modules/@nifrajs/core/package.json",
    json({ name: "@nifrajs/core", version: "4.0.2" }),
  )
  writeAppFile(outside, "web/package.json", json({ name: "@nifrajs/web", version: "4.1.0" }))
  symlinkSync(join(outside, "web"), join(root, "node_modules/@nifrajs/web"), "dir")
  const linkedDir = json({ name: "linked-dir", dependencies: { "@nifrajs/core": "4.0.2" } })
  writeAppFile(outside, "repo/package.json", linkedDir)
  symlinkSync(join(outside, "repo"), join(root, "packages/linked-dir"), "dir")
  const linkedFile = json({ name: "linked-file", dependencies: { "@nifrajs/core": "4.0.2" } })
  writeAppFile(outside, "file/package.json", linkedFile)
  mkdirSync(join(root, "packages/linked-file"), { recursive: true })
  symlinkSync(join(outside, "file/package.json"), join(root, "packages/linked-file/package.json"))
  return { root, outside, linkedDir, linkedFile, web: realpathSync(join(outside, "web")) }
}

describe("version drift", () => {
  test("pins, installs (followed to their real location) and the CLI, oldest first", () => {
    const { root, web } = linkedWorkspace()
    const drift = collectVersionDrift(root, "5.0.0")
    expect(drift?.versions.map((entry) => entry.version)).toEqual([
      "4.0.1",
      "4.0.2",
      "4.1.0",
      "5.0.0",
    ])
    expect(drift?.highest).toBe("5.0.0")
    expect(drift?.versions[0]?.sources).toEqual(["pinned in packages/api/package.json"])
    expect(drift?.versions[1]?.sources).toEqual([
      "pinned in package.json",
      "installed @nifrajs/core",
    ])
    expect(drift?.versions[2]?.sources).toEqual([`installed @nifrajs/web (linked from ${web})`])
    expect(drift?.versions[3]?.sources).toEqual(["the running nifra CLI"])
    expect(drift?.linkedOutside).toEqual([{ package: "@nifrajs/web", path: web, version: "4.1.0" }])
    const message = versionDriftMessage(drift!)
    expect(message).toContain("Run `nifra upgrade 5.0.0` (it runs each release's migration steps")
    expect(message).toContain(`It does not edit @nifrajs/web 4.1.0 at ${web}, linked from outside`)
  })

  test("one version everywhere is not drift; workspace: and link: specs are not versions", () => {
    const root = scratch("nifra-drift-")
    writeAppFile(
      root,
      "package.json",
      json({
        dependencies: {
          "@nifrajs/core": "^5.0.0",
          "@nifrajs/web": "workspace:*",
          nifra: "link:../nifra",
        },
      }),
    )
    writeAppFile(root, "node_modules/@nifrajs/core/package.json", json({ version: "5.0.0" }))
    expect(collectVersionDrift(root, "5.0.0")).toBeUndefined()
    expect(collectVersionDrift(root, "4.0.2")?.highest).toBe("5.0.0")
  })

  test("doctor carries it as an advisory that never fails ok; check reports NF-D002", async () => {
    const { root } = linkedWorkspace()
    const result = await collectDoctorResult(root, { cliVersion: "5.0.0" })
    expect(result.versionDrift?.highest).toBe("5.0.0")
    expect(result.ok).toBe(true)

    const facts = projectFacts("backend/app.ts", "")
    const project = { ...facts, packages: { ...facts.packages, doctor: result } }
    const findings = await runRuleRegistry({ root, sources: facts.source, project }, legacyRules)
    const drift = findings.filter((finding) => finding.code === "NF-D002")
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ severity: "info", verify: "nifra doctor" })
    expect(drift[0]?.fix).toEqual({
      recipe: "upgrade.align-versions",
      command: "nifra upgrade 5.0.0",
    })
  })
})

describe("nifra upgrade write scope", () => {
  const recipe: UpgradeRecipe = {
    version: "5.0.0",
    pins: [{ match: "@nifrajs/", to: "5.0.0" }],
    importMoves: [],
  }

  test("edits only files under the root; a linked repository is listed, never edited", () => {
    const { root, outside, linkedDir, linkedFile, web } = linkedWorkspace()
    const plan = computeUpgrade(root, recipe, true)
    expect([...new Set(plan.pins.map((pin) => pin.file))]).toEqual([
      "package.json",
      "packages/api/package.json",
    ])
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"@nifrajs/core": "5.0.0"')
    expect(readFileSync(join(outside, "repo/package.json"), "utf8")).toBe(linkedDir)
    expect(readFileSync(join(outside, "file/package.json"), "utf8")).toBe(linkedFile)
    expect(plan.linkedOutside).toEqual([{ package: "@nifrajs/web", path: web, version: "4.1.0" }])
  })

  test("a linked install already at the target is not listed", () => {
    const { root } = linkedWorkspace()
    const plan = computeUpgrade(root, { ...recipe, version: "4.1.0" }, false)
    expect(plan.linkedOutside).toEqual([])
  })
})

describe("version drift, installs", () => {
  test("an install nothing declares is not drift; one a declared package depends on is", () => {
    const root = scratch("nifra-drift-")
    writeAppFile(root, "package.json", json({ dependencies: { "@nifrajs/web": "5.0.0" } }))
    writeAppFile(
      root,
      "node_modules/@nifrajs/web/package.json",
      json({ version: "5.0.0", dependencies: { "@nifrajs/core": "5.0.0" } }),
    )
    writeAppFile(root, "node_modules/create-nifra/package.json", json({ version: "3.5.0" }))
    writeAppFile(root, "node_modules/@nifrajs/core/package.json", json({ version: "5.0.0" }))
    expect(collectVersionDrift(root, "5.0.0")).toBeUndefined()
    writeAppFile(root, "node_modules/@nifrajs/core/package.json", json({ version: "4.0.2" }))
    expect(collectVersionDrift(root, "5.0.0")?.versions[0]?.sources).toEqual([
      "installed @nifrajs/core",
    ])
  })

  test("a repository's linked installs read as one phrase per install and version", () => {
    const root = scratch("nifra-drift-")
    const outside = scratch("nifra-linked-")
    const names = ["core", "web", "client", "schema", "cli"]
    writeAppFile(
      root,
      "package.json",
      json({ dependencies: Object.fromEntries(names.map((n) => [`@nifrajs/${n}`, "5.0.0"])) }),
    )
    mkdirSync(join(root, "node_modules/@nifrajs"), { recursive: true })
    for (const name of names) {
      writeAppFile(
        outside,
        `node_modules/@nifrajs/${name}/package.json`,
        json({ name: `@nifrajs/${name}`, version: "4.0.2" }),
      )
      symlinkSync(
        join(outside, "node_modules/@nifrajs", name),
        join(root, "node_modules/@nifrajs", name),
        "dir",
      )
    }
    const message = versionDriftMessage(collectVersionDrift(root, "5.0.0")!)
    expect(message).toContain(
      `It does not edit 5 packages at 4.0.2 under ${realpathSync(outside)} (@nifrajs/cli, @nifrajs/client, @nifrajs/core and 2 more), linked from outside`,
    )
  })
})
