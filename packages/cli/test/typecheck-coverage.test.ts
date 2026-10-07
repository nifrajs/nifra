import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { collectCheckResult, renderCheckReport } from "../src/check.ts"
import { filesOutsideProgram, splitListedFiles, zoneFolderOf } from "../src/typecheck-coverage.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const root = createFixtureRoot("typecheck-coverage-")
afterAll(() => removeFixtureRoot(root))

describe("splitListedFiles", () => {
  test("separates program files from diagnostics and continuation lines", () => {
    const output = [
      "/repo/node_modules/typescript/lib/lib.es5.d.ts",
      "routes/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  The expected type comes from here.",
      "/repo/routes/index.ts",
      "/repo/x(1,2): error TS1005: ';' expected.",
      "",
    ].join("\n")
    const split = splitListedFiles(output)
    expect(split.programFiles).toEqual([
      "/repo/node_modules/typescript/lib/lib.es5.d.ts",
      "/repo/routes/index.ts",
    ])
    expect(split.output).toBe(
      [
        "routes/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        "  The expected type comes from here.",
        "/repo/x(1,2): error TS1005: ';' expected.",
      ].join("\n"),
    )
  })
})

describe("zoneFolderOf", () => {
  test("names the first zone folder, nested apps included", () => {
    expect(zoneFolderOf("backend/db.ts")).toBe("backend")
    expect(zoneFolderOf("apps/web/routes/index.tsx")).toBe("apps/web/routes")
    expect(zoneFolderOf("lib/backend.ts")).toBeUndefined()
    expect(zoneFolderOf("scripts/seed.ts")).toBeUndefined()
  })
})

describe("filesOutsideProgram", () => {
  test("reports zoned TypeScript files the program left out, skipping declarations and tests", () => {
    const cwd = createFixtureProject(root, "unit-")
    const files = [
      "routes/index.ts",
      "backend/app.ts",
      "backend/app.test.ts",
      "backend/env.d.ts",
      "frontend/view.svelte",
      "shared/format.ts",
      "scripts/seed.ts",
    ]
    const program = [join(cwd, "routes/index.ts"), join(cwd, "shared/format.ts")]
    expect(filesOutsideProgram(cwd, files, program)).toEqual(["backend/app.ts"])
  })

  test("leaves an app with its own tsconfig to that program", () => {
    const cwd = createFixtureProject(root, "nested-")
    writeAppFile(cwd, "apps/web/tsconfig.json", "{}")
    const files = ["apps/web/backend/app.ts", "apps/api/backend/app.ts"]
    expect(filesOutsideProgram(cwd, files, [])).toEqual(["apps/api/backend/app.ts"])
  })

  test("a file the tsconfig excludes is out on purpose, through extends and folder patterns", () => {
    const cwd = createFixtureProject(root, "exclude-")
    writeAppFile(
      cwd,
      "config/base.json",
      // A comment, a trailing comma, and patterns relative to this file.
      '{\n  // shared\n  "exclude": ["../backend/worker.ts", "../backend/generated", "../shared/*.gen.ts",],\n}',
    )
    writeAppFile(cwd, "tsconfig.json", '{ "extends": "./config/base" }')
    const files = [
      "backend/worker.ts",
      "backend/generated/routes.ts",
      "backend/app.ts",
      "shared/api.gen.ts",
      "shared/api.ts",
    ]
    expect(filesOutsideProgram(cwd, files, [])).toEqual(["backend/app.ts", "shared/api.ts"])
    writeAppFile(cwd, "tsconfig.json", '{ "extends": "./config/base", "exclude": [] }')
    expect(filesOutsideProgram(cwd, files, [])).toEqual(files)
  })

  test("matches a program that names files through a symlinked directory", () => {
    const real = createFixtureProject(root, "real-")
    const link = join(root, `link-${Date.now()}`)
    symlinkSync(real, link)
    mkdirSync(join(real, "backend"), { recursive: true })
    writeAppFile(real, "backend/app.ts", "export {}\n")
    expect(filesOutsideProgram(link, ["backend/app.ts"], [join(real, "backend/app.ts")])).toEqual(
      [],
    )
  })
})

describe("nifra check - zoned files outside the tsc program", () => {
  const tsconfig = (include: readonly string[]): string =>
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include,
    })

  function project(include: readonly string[]): string {
    const cwd = createFixtureProject(root, "app-")
    writeAppFile(cwd, "tsconfig.json", tsconfig(include))
    writeAppFile(cwd, "routes/index.ts", "export const title: string = 'home'\n")
    writeAppFile(cwd, "backend/app.ts", "export const port: number = 3000\n")
    writeAppFile(cwd, "backend/jobs/cleanup.ts", "export const every: string = '1h'\n")
    return cwd
  }

  test("a folder missing from tsconfig include fails the typecheck, one finding per folder", async () => {
    const result = await collectCheckResult(project(["routes"]))
    expect(result.typecheck).toBe("fail")
    expect(result.ok).toBe(false)
    const findings = result.diagnostics.filter((d) => d.rule === "typecheck")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe("error")
    expect(findings[0]?.message).toContain("2 file(s) under backend/ are outside tsc's program")
    expect(findings[0]?.evidence).toEqual(["backend/app.ts", "backend/jobs/cleanup.ts"])
    expect(renderCheckReport(result)).toContain(
      "✗ typecheck failed - 2 file(s) in zone folders are outside tsc's program, so the typecheck never read them",
    )
  }, 30_000)

  test("every zone folder in the program passes", async () => {
    const result = await collectCheckResult(project(["routes", "backend"]))
    expect(result.typecheck).toBe("pass")
    expect(result.diagnostics.filter((d) => d.rule === "typecheck")).toHaveLength(0)
  }, 30_000)

  test("typecheck ignore globs keep deliberately excluded files out of the finding", async () => {
    const cwd = project(["routes"])
    writeAppFile(
      cwd,
      "nifra.check.json",
      JSON.stringify({ rules: { typecheck: { ignore: ["backend/**"] } } }),
    )
    const result = await collectCheckResult(cwd)
    expect(result.typecheck).toBe("pass")
    expect(result.diagnostics.filter((d) => d.rule === "typecheck")).toHaveLength(0)
  }, 30_000)
})
