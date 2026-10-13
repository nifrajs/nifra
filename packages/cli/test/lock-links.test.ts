import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectDoctorResult } from "../src/doctor.ts"
import { parseJsonc } from "../src/internal/project-specifiers.ts"
import {
  bunLockDir,
  linkLockUpdate,
  pruneLinkLocks,
  staleLinkLockMessage,
  staleLinkLocks,
} from "../src/lock-links.ts"
import type { UpgradeRecipe } from "../src/recipes/index.ts"
import { runRuleRegistry } from "../src/rules/index.ts"
import { legacyRules } from "../src/rules/legacy.ts"
import { computeUpgrade, runUpgrade } from "../src/upgrade.ts"
import { collectVersionDrift } from "../src/version-drift.ts"
import { writeAppFile } from "./fixture-root.ts"
import { projectFacts } from "./rule-facts.ts"

const created: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-lock-links-"))
  created.push(dir)
  mkdirSync(join(dir, ".git"))
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** bun.lock as Bun 1.4 writes it: one entry per line, blank lines between, trailing commas. */
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "@nifrajs/core": "4.0.2",
        "@scope/kit": "file:./scoped",
        "linked-kit": "file:./kit",
      },
    },
  },
  "packages": {
    "@nifrajs/core": ["@nifrajs/core@4.0.2", "", {}, ""],

    "@scope/kit": ["@scope/kit@file:scoped", { "dependencies": { "dep-a": "^1.0.0" } }],

    "@scope/kit/dep-a": ["dep-a@1.0.0", "", {}, ""],

    "dep-a": ["dep-a@1.0.0", "", {}, ""],

    "linked-kit": ["linked-kit@file:kit", { "dependencies": { "@nifrajs/core": "4.0.2", "dep-a": "^1.0.0" } }],

    "linked-kit/@nifrajs/core": ["@nifrajs/core@4.0.2", "", {}, ""],

    "linked-kit/inner": ["inner@file:inner", { "dependencies": { "dep-a": "^9.0.0" } }],
  }
}
`

/** An app whose two `file:` packages match the lock until a test edits one. */
function linkedApp(kit: Record<string, string> = { "@nifrajs/core": "4.0.2", "dep-a": "^1.0.0" }) {
  const root = scratch()
  writeAppFile(
    root,
    "package.json",
    json({
      name: "app",
      dependencies: {
        "@nifrajs/core": "4.0.2",
        "@scope/kit": "file:./scoped",
        "linked-kit": "file:./kit",
      },
    }),
  )
  writeAppFile(root, "kit/package.json", json({ name: "linked-kit", dependencies: kit }))
  writeAppFile(
    root,
    "scoped/package.json",
    json({ name: "@scope/kit", dependencies: { "dep-a": "^1.0.0" } }),
  )
  // Scoped under linked-kit, so never an entry of its own, however stale.
  writeAppFile(
    root,
    "inner/package.json",
    json({ name: "inner", dependencies: { "dep-a": "^1.0.0" } }),
  )
  writeAppFile(root, "bun.lock", LOCK)
  return root
}

describe("stale file: entries in bun.lock", () => {
  test("a lock that matches every linked package.json reports nothing", () => {
    expect(staleLinkLocks(linkedApp())).toEqual([])
  })

  test("reports each dependency the linked package changed, added, or removed", () => {
    const root = linkedApp({ "@nifrajs/core": "5.0.0", "dep-b": "^2.0.0" })
    expect(staleLinkLocks(root)).toEqual([
      {
        package: "linked-kit",
        path: "kit",
        changes: [
          { name: "@nifrajs/core", recorded: "4.0.2", declared: "5.0.0" },
          { name: "dep-a", recorded: "^1.0.0" },
          { name: "dep-b", declared: "^2.0.0" },
        ],
      },
    ])
  })

  test("a scoped file: package is read; the dependencies scoped under it are not entries", () => {
    const root = linkedApp()
    writeAppFile(
      root,
      "scoped/package.json",
      json({ name: "@scope/kit", peerDependencies: { "dep-a": "^1.0.0" } }),
    )
    expect(staleLinkLocks(root).map((entry) => entry.changes)).toEqual([
      [
        { name: "dep-a", recorded: "^1.0.0" },
        { name: "dep-a", declared: "^1.0.0" },
      ],
    ])
  })

  test("a planned manifest stands in for the file on disk", () => {
    const root = linkedApp()
    const planned = new Map([
      [
        join(root, "kit/package.json"),
        json({ dependencies: { "@nifrajs/core": "5.0.0", "dep-a": "^1.0.0" } }),
      ],
    ])
    expect(staleLinkLocks(root, planned)[0]?.changes).toEqual([
      { name: "@nifrajs/core", recorded: "4.0.2", declared: "5.0.0" },
    ])
  })

  test("an unreadable lock or linked manifest reports nothing", () => {
    const root = linkedApp({ "@nifrajs/core": "5.0.0" })
    rmSync(join(root, "kit/package.json"))
    expect(staleLinkLocks(root)).toEqual([])
    writeAppFile(root, "bun.lock", "{ not json")
    expect(staleLinkLocks(root)).toEqual([])
  })

  test("the nearest lock is found from a nested directory, never above the repository", () => {
    const root = linkedApp()
    mkdirSync(join(root, "kit/src"))
    expect(bunLockDir(join(root, "kit/src"))).toBe(root)
    const bare = scratch()
    expect(bunLockDir(bare)).toBeUndefined()
  })
})

describe("pruneLinkLocks", () => {
  test("drops the entries and what is scoped under them; the rest parses unchanged", () => {
    const pruned = pruneLinkLocks(LOCK, ["linked-kit", "@scope/kit"])
    expect(pruned).toBeDefined()
    const before = Object(parseJsonc(LOCK))
    const after = Object(parseJsonc(pruned ?? ""))
    expect(Object.keys(after.packages)).toEqual(["@nifrajs/core", "dep-a"])
    expect(after.workspaces).toEqual(before.workspaces)
    expect(after.lockfileVersion).toBe(1)
  })

  test("a workspaces key that shares a dropped name is kept", () => {
    const lock = LOCK.replace(
      '    "": {',
      '    "linked-kit": {\n      "name": "member",\n    },\n    "": {',
    )
    const pruned = pruneLinkLocks(lock, ["linked-kit"])
    expect(Object.keys(Object(parseJsonc(pruned ?? "")).workspaces)).toEqual(["linked-kit", ""])
  })

  test("refuses a lock not laid out one entry per line", () => {
    const spread = LOCK.replace(
      '"linked-kit": ["linked-kit@file:kit", {',
      '"linked-kit": [\n      "linked-kit@file:kit", {',
    )
    expect(pruneLinkLocks(spread, ["linked-kit"])).toBeUndefined()
    expect(pruneLinkLocks("{}", ["linked-kit"])).toBeUndefined()
  })

  test("refuses when a dropped line carries an entry it was not asked to drop", () => {
    const shared = LOCK.replace(
      '""],\n\n    "linked-kit/inner"',
      '""], "kept": ["kept@1.0.0", "", {}, ""],\n\n    "linked-kit/inner"',
    )
    expect(shared).not.toBe(LOCK)
    expect(pruneLinkLocks(shared, ["linked-kit"])).toBeUndefined()
  })
})

describe("doctor, check, and upgrade", () => {
  const recipe: UpgradeRecipe = {
    version: "5.0.0",
    pins: [{ match: "@nifrajs/", to: "5.0.0" }],
    importMoves: [],
  }

  test("doctor carries the advisory without failing ok; check reports NF-D003", async () => {
    const root = linkedApp({ "@nifrajs/core": "5.0.0", "dep-a": "^1.0.0" })
    const result = await collectDoctorResult(root)
    expect(result.ok).toBe(true)
    expect(result.staleLinkLocks?.lock).toBe("bun.lock")
    const message = staleLinkLockMessage(result.staleLinkLocks ?? { lock: "", entries: [] })
    expect(message).toContain("linked-kit (file:kit): @nifrajs/core 4.0.2 -> 5.0.0")
    expect(message).toContain("`bun update linked-kit`")

    const facts = projectFacts("backend/app.ts", "")
    const project = { ...facts, packages: { ...facts.packages, doctor: result } }
    const findings = await runRuleRegistry({ root, sources: facts.source, project }, legacyRules)
    const stale = findings.filter((finding) => finding.code === "NF-D003")
    expect(stale).toHaveLength(1)
    expect(stale[0]?.severity).toBe("warn")
    expect(stale[0]?.file).toBe("bun.lock")
    expect(stale[0]?.fix).toEqual({
      recipe: "lock.refresh-file-links",
      command: "bun update linked-kit",
    })
  })

  test("an exact recorded nifra pin is a version the workspace installs", () => {
    const root = linkedApp({ "@nifrajs/core": "5.0.0", "dep-a": "^1.0.0" })
    writeAppFile(
      root,
      "package.json",
      json({ name: "app", dependencies: { "@nifrajs/core": "5.0.0", "linked-kit": "file:./kit" } }),
    )
    const drift = collectVersionDrift(root)
    expect(drift?.versions.find((entry) => entry.version === "4.0.2")?.sources).toEqual([
      "recorded for linked-kit in bun.lock, which Bun never refreshes (NF-D003)",
    ])
  })

  test("a dry run lists the entries the upgrade leaves stale; --write drops them", () => {
    const root = linkedApp()
    const dry = computeUpgrade(root, recipe, false)
    expect(dry.linkLocks.map((entry) => entry.package)).toEqual(["linked-kit"])
    expect(dry.lockPruned).toBe(false)
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(LOCK)

    const written = computeUpgrade(root, recipe, true)
    expect(written.lockPruned).toBe(true)
    const lock = Object(parseJsonc(readFileSync(join(root, "bun.lock"), "utf8")))
    expect(Object.keys(lock.packages)).toEqual([
      "@nifrajs/core",
      "@scope/kit",
      "@scope/kit/dep-a",
      "dep-a",
    ])
  })

  test("--write leaves a lock it cannot prune safely and names the update instead", () => {
    const root = linkedApp()
    const spread = LOCK.replace(
      '"linked-kit": ["linked-kit@file:kit", {',
      '"linked-kit": [\n      "linked-kit@file:kit", {',
    )
    writeAppFile(root, "bun.lock", spread)
    const plan = computeUpgrade(root, recipe, true)
    expect(plan.lockPruned).toBe(false)
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(spread)
    expect(linkLockUpdate(plan.linkLocks)).toBe("bun update linked-kit")
  })
})

test("the upgrade report names what a dry run would drop and what --write dropped", async () => {
  const root = linkedApp()
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
  try {
    await runUpgrade(root, { version: "5.0.0", cliVersion: "5.0.0", verify: false })
    await runUpgrade(root, { version: "5.0.0", cliVersion: "5.0.0", write: true, verify: false })
  } finally {
    log.mockRestore()
  }
  const out = lines.join("\n")
  expect(out).toContain("--write drops them so `bun install` reads each linked package.json again:")
  expect(out).toContain("  linked-kit (file:kit)  @nifrajs/core 4.0.2 -> 5.0.0")
  expect(out).toContain("Dropped 1 file: package(s) from bun.lock")
  expect(out).toContain("`bun install --frozen-lockfile` fails.")
})
