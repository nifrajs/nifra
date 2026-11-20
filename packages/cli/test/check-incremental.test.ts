import { afterAll, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { collectProjectVerification } from "../src/verification.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  FIXTURE_TSCONFIG,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const fixtures = createFixtureRoot("nifra-incremental-")
afterAll(() => removeFixtureRoot(fixtures))

test("warm checks report the same type and source findings as clean checks after an edit", async () => {
  const cwd = createFixtureProject(fixtures, "app-")
  writeAppFile(cwd, "tsconfig.json", FIXTURE_TSCONFIG)
  writeAppFile(cwd, "package.json", '{"name":"incremental-fixture","private":true}')
  writeAppFile(cwd, "shared/model.ts", "export const value: number = 1\n")
  writeAppFile(
    cwd,
    "backend/consumer.ts",
    'import { value } from "../shared/model.ts"\nexport const result: number = value\n',
  )
  const check = async (incremental: boolean) =>
    (await collectProjectVerification(cwd, { incremental, timings: incremental })).check()

  const seeded = await check(true)
  expect(seeded.typecheck).toBe("pass")
  expect(seeded.timings?.phasesMs.typecheck).toBeGreaterThan(0)
  expect(seeded.timings?.phasesMs["read-sources"]).toBeGreaterThan(0)
  expect(await readdir(join(cwd, ".nifra/check"))).toEqual([
    expect.stringMatching(/\.tsbuildinfo$/),
  ])

  writeAppFile(cwd, "shared/model.ts", 'export const value = "changed"\n')
  writeAppFile(cwd, "backend/consumer.test.ts", 'import "undeclared-in-test"\n')
  const warm = await check(true)
  const clean = await check(false)
  expect(warm.ok).toBe(false)
  expect(warm.typecheck).toBe("fail")
  expect(warm.structuredDiagnostics).toEqual(clean.structuredDiagnostics)
  expect(warm.structuredDiagnostics?.map(({ code }) => code)).toContain("NF-C008")
  expect(warm.structuredDiagnostics?.map(({ code }) => code)).toContain("NF-C001")

  writeAppFile(cwd, "shared/model.ts", "export const value: number = 2\n")
  writeAppFile(cwd, "backend/consumer.test.ts", "export {}\n")
  const checks = await Promise.all([check(true), check(true)])
  expect(checks.map((result) => result.ok)).toEqual([true, true])
  expect(await readdir(join(cwd, ".nifra/check"))).toHaveLength(1)
})
