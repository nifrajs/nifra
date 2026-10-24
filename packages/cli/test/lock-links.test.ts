import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bindCommandArgv, findCommandSpec } from "../src/command-catalog.ts"
import { collectDoctorResult } from "../src/doctor.ts"
import {
  bunLockDir,
  linkLockUpdate,
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

  test("a linked package's devDependencies are recorded and installed, so they go stale too", () => {
    const root = linkedApp()
    writeAppFile(
      root,
      "bun.lock",
      LOCK.replace(
        `"dep-a": "^1.0.0" } }],\n\n    "linked-kit/@nifrajs/core"`,
        `"dep-a": "^1.0.0" }, "devDependencies": { "@nifrajs/testing": "4.0.2" } }],\n\n    "linked-kit/@nifrajs/core"`,
      ),
    )
    const declare = (testing: string): void => {
      writeAppFile(
        root,
        "kit/package.json",
        json({
          name: "linked-kit",
          dependencies: { "@nifrajs/core": "4.0.2", "dep-a": "^1.0.0" },
          devDependencies: { "@nifrajs/testing": testing },
        }),
      )
    }
    declare("4.0.2")
    expect(staleLinkLocks(root)).toEqual([])
    declare("5.0.0")
    expect(staleLinkLocks(root)).toEqual([
      {
        package: "linked-kit",
        path: "kit",
        changes: [{ name: "@nifrajs/testing", recorded: "4.0.2", declared: "5.0.0" }],
      },
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

  test("`nifra doctor` prints the advisories it collected, not only pass or fail", async () => {
    const root = linkedApp({ "@nifrajs/core": "5.0.0", "dep-a": "^1.0.0" })
    const doctor = findCommandSpec("doctor")
    const out = await doctor?.run(bindCommandArgv(doctor, []), { cwd: root })
    const printed = doctor?.render(out).join("\n") ?? ""
    expect(printed).toStartWith("nifra doctor\n")
    expect(printed).toContain(
      "⚠ bun.lock records dependencies its file: packages no longer declare",
    )
    expect(printed).toContain("(NF-D003)")
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
      "recorded for linked-kit in bun.lock, stale until `bun update linked-kit` (NF-D003)",
    ])
  })

  // An install that finds a file: entry missing re-resolves every package in the lock (Bun 1.4.2 and
  // 1.4.4), so upgrade lists the entries and never edits bun.lock.
  test("a dry run and --write list the stale entries and leave bun.lock as it is", () => {
    const root = linkedApp()
    const dry = computeUpgrade(root, recipe, false)
    expect(dry.linkLocks.map((entry) => entry.package)).toEqual(["linked-kit"])
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(LOCK)
    const written = computeUpgrade(root, recipe, true)
    expect(linkLockUpdate(written.linkLocks)).toBe("bun update linked-kit")
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(LOCK)
  })
})

test("the upgrade report names the stale entries and the update that refreshes them", async () => {
  const root = linkedApp()
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")))
  const options = { version: "5.0.0", cliVersion: "5.0.0", verify: false }
  try {
    await runUpgrade(root, options)
    await runUpgrade(root, { ...options, write: true })
  } finally {
    log.mockRestore()
  }
  expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(LOCK)
  const out = lines.join("\n")
  expect(out).toContain(
    "--write leaves it as it is; run `bun update linked-kit`, which refreshes those entries and keeps every other pin:",
  )
  expect(out).toContain(
    "Left as it is; run `bun update linked-kit`, which refreshes those entries and keeps every other pin:",
  )
  expect(out).toContain("  linked-kit (file:kit)  @nifrajs/core 4.0.2 -> 5.0.0")
  expect(out).toContain("uncommitted edits included: review the bun.lock diff")
})
