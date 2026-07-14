import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { collectVerificationLevels, runLevels } from "../src/levels-tool.ts"
import { runManifestEmit } from "../src/manifest-tool.ts"

const FIXTURES = join(import.meta.dir, ".tmp-nifra-levels-fixtures")

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true })
})

/** A minimal project whose ladder climbs as far as the pieces we write for it. */
async function project(name: string, options: { assurance?: boolean } = {}): Promise<string> {
  const cwd = join(FIXTURES, name)
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(cwd, "backend.ts"),
    [
      `import { server } from "@nifrajs/core"`,
      `const okBody = {`,
      `  "~standard": { version: 1, vendor: "levels-test", validate: (value) => (typeof value?.amount === "number" ? { value } : { issues: [{ message: "amount" }] }) },`,
      `  jsonSchema: { type: "object", properties: { amount: { type: "number", minimum: 1, maximum: 9 } }, required: ["amount"] },`,
      `}`,
      `export const backend = server().post("/pay", { body: okBody }, () => ({ ok: true }))`,
      "",
    ].join("\n"),
  )
  if (options.assurance !== false) {
    await writeFile(
      join(cwd, "nifra.assurance.ts"),
      [
        `import { defineAssuranceConfig } from "@nifrajs/core/assurance"`,
        `import { backend } from "./backend.ts"`,
        `export default defineAssuranceConfig({`,
        `  source: backend,`,
        `  policy: { rules: [{ name: "all", match: {}, require: [] }] },`,
        `  invariants: { executor: (request) => backend.fetch(request) },`,
        `})`,
        "",
      ].join("\n"),
    )
  }
  return cwd
}

describe("nifra levels", () => {
  test("without an assurance config the ladder stops at L0, with the reason on every rung", async () => {
    const cwd = await project("no-config", { assurance: false })
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[0]?.ok).toBe(true) // typed contract holds
    expect(result.achieved).toBe(0)
    for (const status of result.levels.slice(1)) {
      expect(status.ok).toBe(false)
      expect(status.reasons.length).toBeGreaterThan(0)
    }
  })

  test("climbs to L1 with assurance, and reports why L2/L3 are missing", async () => {
    const cwd = await project("l1")
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[1]?.ok).toBe(true)
    expect(result.achieved).toBe(1)
    expect(result.levels[2]?.reasons[0]).toMatch(/no capabilities policy/)
    expect(result.levels[3]?.reasons[0]).toMatch(/manifest missing/)
  })

  test("the ladder is cumulative: a passing L3 does not count while L2 fails", async () => {
    const cwd = await project("gap")
    expect(await runManifestEmit(cwd)).toBe(true) // L3 artifact present + in sync
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[3]?.ok).toBe(true) // rung itself holds…
    expect(result.levels[2]?.ok).toBe(false) // …but the rung below it does not
    expect(result.achieved).toBe(1) // so the achieved level stays below the gap
  })

  test("L4 runs contract invariants only through the configured isolated executor", async () => {
    const cwd = await project("l4")
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[4]?.ok).toBe(true) // the fixture app satisfies its own contract
  })

  test("runLevels honors --min for CI gating and --json emits the structured report", async () => {
    const cwd = await project("gate")
    expect(await runLevels(cwd, { min: 1, json: true })).toBe(true)
    expect(await runLevels(cwd, { min: 3 })).toBe(false)
  })
})
