import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import { defineReplayFile } from "@nifrajs/core/replay"
import { t } from "@nifrajs/schema"
import { collectAssureBundle } from "../src/assure.ts"
import {
  buildContractsLock,
  CONTRACT_DIGEST_FORMAT,
  type ContractsLock,
  checkContractsLock,
  isVacuousLock,
  parseContractsLock,
  snapshotContracts,
} from "../src/contracts.ts"
import { applyDiagnosticRecipe, listFixRecipes } from "../src/fix-recipes.ts"
import { runReplay } from "../src/replay.ts"
import { assertUniqueRuleCodes } from "../src/rules/codes.ts"
import { validateRulePacks } from "../src/rules/index.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const ROOT = createFixtureRoot("tmp-agent-verification")

afterAll(() => {
  removeFixtureRoot(ROOT)
})

describe("agent verification surfaces", () => {
  test("built-in codes are unique and pack codes cannot use NF", () => {
    expect(() => assertUniqueRuleCodes()).not.toThrow()
    expect(() =>
      validateRulePacks([
        {
          name: "bad",
          rules: [{ code: "NF-C999", title: "bad", scan: async () => [] }],
        },
      ]),
    ).toThrow("reserved NF- prefix")
  })

  test("contract snapshot detects a schema digest change", async () => {
    const dir = join(ROOT, "contracts")
    await mkdir(dir, { recursive: true })
    writeAppFile(
      dir,
      "backend/app.ts",
      'import { server } from "@nifrajs/core"\nexport const backend = server().get("/users", () => ({ ok: true }))\n',
    )
    const lock = await snapshotContracts(dir)
    expect(Object.keys(lock.routes)).toEqual(["GET /users"])
    expect((await checkContractsLock(dir)).diagnostics).toEqual([])
    writeAppFile(
      dir,
      "backend/app.ts",
      'import { server } from "@nifrajs/core"\nexport const backend = server().get("/users", () => ({ ok: false }))\n',
    )
    expect((await checkContractsLock(dir)).diagnostics).toHaveLength(0)
  })

  describe("contract digest format", () => {
    async function locked(name: string): Promise<{ dir: string; lock: ContractsLock }> {
      const dir = join(ROOT, name)
      await mkdir(dir, { recursive: true })
      writeAppFile(
        dir,
        "backend/app.ts",
        'import { server } from "@nifrajs/core"\nimport { t } from "@nifrajs/schema"\nexport const backend = server().get("/users", { query: t.object({ q: t.string() }) }, () => 1)\n',
      )
      return { dir, lock: await snapshotContracts(dir) }
    }
    const write = (dir: string, lock: unknown): Promise<void> =>
      writeFile(join(dir, "contracts.lock.json"), JSON.stringify(lock))

    test("a snapshot records the format it was hashed with", async () => {
      const { lock } = await locked("digest-recorded")
      expect(lock.digest).toBe(CONTRACT_DIGEST_FORMAT)
      expect(Object.keys(lock)).toEqual(["version", "digest", "routes"])
    })

    test("an older format fails as a re-snapshot, never as drift on each route", async () => {
      const { dir, lock } = await locked("digest-older")
      await write(dir, { ...lock, digest: CONTRACT_DIGEST_FORMAT - 1 })
      const { diagnostics } = await checkContractsLock(dir)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.route).toBeUndefined()
      expect(diagnostics[0]?.message).toContain(
        `written with contract digest format ${CONTRACT_DIGEST_FORMAT - 1}`,
      )
      expect(diagnostics[0]?.message).toContain("nifra contracts snapshot")
      expect(diagnostics[0]?.message).not.toContain("newer")
    })

    test("a newer format names the CLI upgrade", async () => {
      const { dir, lock } = await locked("digest-newer")
      await write(dir, { ...lock, digest: CONTRACT_DIGEST_FORMAT + 1 })
      const { diagnostics } = await checkContractsLock(dir)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.message).toContain("a newer @nifrajs/cli wrote it")
    })

    test("a lock without a format still compares, and drift there notes the format may be the cause", async () => {
      const { dir, lock } = await locked("digest-absent")
      const { digest: _digest, ...legacy } = lock
      await write(dir, legacy)
      expect((await checkContractsLock(dir)).diagnostics).toEqual([])
      const users = legacy.routes["GET /users"]
      await write(dir, {
        ...legacy,
        routes: { "GET /users": { response: users?.response, request: "0".repeat(64) } },
      })
      const { diagnostics } = await checkContractsLock(dir)
      expect(diagnostics.map((d) => d.route)).toEqual(["GET /users", undefined])
      expect(diagnostics[1]?.message).toContain("records no contract digest format")
    })

    test("a malformed format is refused", () => {
      for (const digest of ["2", 0, -1, 1.5]) {
        expect(() => parseContractsLock({ version: 1, digest, routes: {} })).toThrow(
          "digest must be a positive integer",
        )
      }
    })
  })

  test("the contracts lock lists routes in code-unit order, the same in every locale", async () => {
    const lock = await buildContractsLock(
      server()
        .get("/a_y", () => 1)
        .get("/B", () => 1)
        .get("/a-x", () => 1)
        .get("/a", () => 1),
    )
    expect(Object.keys(lock.routes)).toEqual(["GET /B", "GET /a", "GET /a-x", "GET /a_y"])
  })

  test("a lock whose every route has no schema is vacuous; declaring one clears it", async () => {
    const noSchema = await buildContractsLock(
      server()
        .get("/a", () => ({ ok: true }))
        .get("/b", () => ({ ok: true })),
    )
    expect(await isVacuousLock(noSchema)).toBe(true)

    const withSchema = await buildContractsLock(
      server()
        .get("/a", () => ({ ok: true }))
        .get("/b", { query: t.object({ q: t.string() }) }, () => ({ ok: true })),
    )
    expect(await isVacuousLock(withSchema)).toBe(false)

    // No routes at all is not "vacuous" - there is no unguarded contract to warn about.
    expect(await isVacuousLock(await buildContractsLock(server()))).toBe(false)
  })

  test("assurance bundle includes explicit skipped gates", async () => {
    const dir = join(ROOT, "bundle")
    await mkdir(dir, { recursive: true })
    writeAppFile(dir, "backend/app.ts", "export const backend = { routes: () => [] }\n")
    await writeFile(
      join(dir, "nifra.assurance.ts"),
      'import { defineAssuranceConfig } from "@nifrajs/core/assurance"\nimport { backend } from "./backend/app.ts"\nexport default defineAssuranceConfig({ source: backend, policy: { rules: [], unmatched: "ignore", allowEmpty: true } })\n',
    )
    const bundle = await collectAssureBundle(dir)
    expect(bundle.version).toBe(1)
    expect(bundle.gates.find((gate) => gate.gate === "contracts")?.status).toBe("skip")
    expect(bundle.verdict).toBe("green")
  })

  test("assurance bundle evaluates its config once", async () => {
    const dir = join(ROOT, "single-assurance-load")
    const key = Symbol.for("nifra.test.assurance-load-count")
    const globals = globalThis as unknown as Record<PropertyKey, unknown>
    globals[key] = 0
    await mkdir(dir, { recursive: true })
    writeAppFile(dir, "backend/app.ts", "export const backend = { routes: () => [] }\n")
    await writeFile(
      join(dir, "nifra.assurance.ts"),
      [
        `const key = Symbol.for("nifra.test.assurance-load-count")`,
        `const globals = globalThis as unknown as Record<PropertyKey, unknown>`,
        `globals[key] = Number(globals[key] ?? 0) + 1`,
        `import { defineAssuranceConfig } from "@nifrajs/core/assurance"`,
        `import { backend } from "./backend/app.ts"`,
        `export default defineAssuranceConfig({ source: backend, policy: { rules: [], unmatched: "ignore", allowEmpty: true } })`,
        "",
      ].join("\n"),
    )
    await collectAssureBundle(dir)
    expect(globals[key]).toBe(1)
  })

  test("missing assurance config preserves the check gate behavior", async () => {
    const dir = join(ROOT, "missing-assurance")
    await mkdir(dir, { recursive: true })
    const bundle = await collectAssureBundle(dir)
    const check = bundle.gates.find((gate) => gate.gate === "check")
    expect(check?.status).toBe("pass")
    expect(
      check?.diagnostics.some((item) => item.message.includes("route assurance config not found")),
    ).toBe(false)
  })

  test("mechanical fix recipes are registered and apply timing-safe comparison", async () => {
    const dir = join(ROOT, "fixes")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "security.ts"), "if (token === expected) return true\n")
    const changed = await applyDiagnosticRecipe(dir, {
      code: "NF-S002",
      severity: "error",
      message: "secret comparison",
      file: "security.ts",
      line: 1,
      fix: { recipe: "security.timing-safe-equal" },
    })
    expect(changed).toEqual(["security.ts"])
    const source = await Bun.file(join(dir, "security.ts")).text()
    expect(source).toContain("timingSafeEqual")
    expect(listFixRecipes().map((recipe) => recipe.id)).toEqual([
      "security.timing-safe-equal",
      "manifest.sync",
      "framework.api-prefix",
      "contracts.snapshot",
      "workspace-dist.rebuild",
      "imports.moved-export",
      "route.split",
      "layout.migrate",
      "schemas.draft",
      "client.reserved-segment",
    ])
  })

  test("replay dispatch is shared and remains project-scoped", async () => {
    const dir = join(ROOT, "replay")
    await mkdir(join(dir, ".nifra", "replays"), { recursive: true })
    writeAppFile(
      dir,
      "backend/app.ts",
      'import { server } from "@nifrajs/core"\nexport const backend = server().get("/health", () => ({ ok: true }))\n',
    )
    await snapshotContracts(dir)
    const replay = defineReplayFile({
      gate: "contracts",
      case: "GET /health",
      seed: "test",
      inputsDigest: "a".repeat(64),
      meta: {},
    })
    await writeFile(join(dir, ".nifra", "replays", "contracts.json"), `${JSON.stringify(replay)}\n`)
    expect((await runReplay(dir, ".nifra/replays/contracts.json")).ok).toBe(true)
    await expect(runReplay(dir, "../outside.json")).rejects.toThrow(
      "replay file must stay inside the project root",
    )

    // A project reached through a symlink, handed the real path of its file as the MCP host does.
    const link = join(ROOT, "replay-link")
    await symlink(dir, link)
    const real = join(await realpath(dir), ".nifra", "replays", "contracts.json")
    expect((await runReplay(link, real)).ok).toBe(true)

    // A replay file that is itself a link out of the project is refused.
    await writeFile(join(ROOT, "outside.json"), `${JSON.stringify(replay)}\n`)
    await symlink(join(ROOT, "outside.json"), join(dir, ".nifra", "replays", "escape.json"))
    await expect(runReplay(dir, ".nifra/replays/escape.json")).rejects.toThrow(
      "replay file must stay inside the project root",
    )
  })
})
