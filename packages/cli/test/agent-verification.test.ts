import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { defineReplayFile } from "@nifrajs/core/replay"
import { collectAssureBundle } from "../src/assure.ts"
import { checkContractsLock, snapshotContracts } from "../src/contracts.ts"
import { applyDiagnosticRecipe, listFixRecipes } from "../src/fix-recipes.ts"
import { runReplay } from "../src/replay.ts"
import { assertUniqueRuleCodes } from "../src/rules/codes.ts"
import { validateRulePacks } from "../src/rules/index.ts"

const ROOT = join(import.meta.dir, ".tmp-agent-verification")

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
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
    await writeFile(
      join(dir, "backend.ts"),
      'import { server } from "@nifrajs/core"\nexport const backend = server().get("/users", () => ({ ok: true }))\n',
    )
    const lock = await snapshotContracts(dir)
    expect(Object.keys(lock.routes)).toEqual(["GET /users"])
    expect((await checkContractsLock(dir)).diagnostics).toEqual([])
    await writeFile(
      join(dir, "backend.ts"),
      'import { server } from "@nifrajs/core"\nexport const backend = server().get("/users", () => ({ ok: false }))\n',
    )
    expect((await checkContractsLock(dir)).diagnostics).toHaveLength(0)
  })

  test("assurance bundle includes explicit skipped gates", async () => {
    const dir = join(ROOT, "bundle")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "backend.ts"), "export const backend = { routes: () => [] }\n")
    await writeFile(
      join(dir, "nifra.assurance.ts"),
      'import { defineAssuranceConfig } from "@nifrajs/core/assurance"\nimport { backend } from "./backend.ts"\nexport default defineAssuranceConfig({ source: backend, policy: { rules: [], unmatched: "ignore", allowEmpty: true } })\n',
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
    await writeFile(join(dir, "backend.ts"), "export const backend = { routes: () => [] }\n")
    await writeFile(
      join(dir, "nifra.assurance.ts"),
      [
        `const key = Symbol.for("nifra.test.assurance-load-count")`,
        `const globals = globalThis as unknown as Record<PropertyKey, unknown>`,
        `globals[key] = Number(globals[key] ?? 0) + 1`,
        `import { defineAssuranceConfig } from "@nifrajs/core/assurance"`,
        `import { backend } from "./backend.ts"`,
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
      "contracts.snapshot",
      "workspace-dist.rebuild",
    ])
  })

  test("replay dispatch is shared and remains project-scoped", async () => {
    const dir = join(ROOT, "replay")
    await mkdir(join(dir, ".nifra", "replays"), { recursive: true })
    await writeFile(
      join(dir, "backend.ts"),
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
  })
})
