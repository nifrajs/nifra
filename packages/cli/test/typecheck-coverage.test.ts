import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { collectCheckResult, renderCheckReport } from "../src/check.ts"
import {
  filesOutsideProgram,
  routeTableOutsideProgram,
  splitListedFiles,
  zoneFolderOf,
} from "../src/typecheck-coverage.ts"
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

describe("routeTableOutsideProgram", () => {
  const user = [{ content: 'import { Link } from "@nifrajs/web-react"\n' }]

  test("names the table only when a file navigates, it exists, and no program holds it", () => {
    const cwd = createFixtureProject(root, "table-")
    const table = join(cwd, ".nifra/types/routes.d.ts")
    const program = [join(cwd, "routes/index.ts")]
    expect(routeTableOutsideProgram(cwd, program, user)).toBeUndefined()
    writeAppFile(cwd, ".nifra/types/routes.d.ts", "export {}\n")
    expect(routeTableOutsideProgram(cwd, program, user)).toBe(".nifra/types/routes.d.ts")
    expect(routeTableOutsideProgram(cwd, [...program, table], user)).toBeUndefined()
  })

  test("recognizes navigation APIs from browser-safe subpaths", () => {
    const cwd = createFixtureProject(root, "table-subpaths-")
    const table = join(cwd, ".nifra/types/routes.d.ts")
    writeAppFile(cwd, ".nifra/types/routes.d.ts", "export {}\n")
    for (const source of [
      "@nifrajs/web/client",
      "@nifrajs/web-react/router",
      "@nifrajs/web-preact/router",
      "@nifrajs/web-solid/router",
      "@nifrajs/web-svelte/router",
      "@nifrajs/web-vue/router",
    ]) {
      const sources = [{ content: `import { href as routeHref, useNavigate } from "${source}"\n` }]
      expect(routeTableOutsideProgram(cwd, [], sources)).toBe(".nifra/types/routes.d.ts")
      expect(routeTableOutsideProgram(cwd, [table], sources)).toBeUndefined()
    }
    for (const source of [
      "@nifrajs/web-react/query",
      "@nifrajs/web-react/router-extra",
      "@nifrajs/web/client-extra",
      "@nifrajs/web/router/extra",
    ])
      expect(
        routeTableOutsideProgram(cwd, [], [{ content: `import { href } from "${source}"\n` }]),
      ).toBeUndefined()
  })

  test("is silent for an app that imports no navigation API", () => {
    const cwd = createFixtureProject(root, "table-quiet-")
    writeAppFile(cwd, ".nifra/types/routes.d.ts", "export {}\n")
    for (const content of [
      "export const a = 1\n",
      'import { json } from "@nifrajs/core"\n',
      'import { Link } from "./link"\n',
    ])
      expect(routeTableOutsideProgram(cwd, [], [{ content }])).toBeUndefined()
    for (const content of [
      'import { redirect } from "@nifrajs/web"\n',
      'import { Link, NavLink } from "@nifrajs/web-react"\n',
      'import type { Href } from "@nifrajs/web"\nimport { useNavigate as go } from "@nifrajs/web-solid"\n',
    ])
      expect(routeTableOutsideProgram(cwd, [], [{ content }])).toBe(".nifra/types/routes.d.ts")
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

  test("a compiler that exits after more than a pipe buffer preserves its final listed files", async () => {
    const cwd = project(["routes", "backend"])
    writeAppFile(
      cwd,
      "node_modules/typescript/bin/tsc",
      String.raw`
const cwd = process.cwd().replaceAll("\\", "/")
const padding = cwd + "/node_modules/padding.d.ts\n"
process.stdout.write(padding.repeat(20_000))
for (const file of ["routes/index.ts", "backend/app.ts", "backend/jobs/cleanup.ts"])
  process.stdout.write(cwd + "/" + file + "\n")
process.exit(0)
`,
    )
    const result = await collectCheckResult(cwd)
    expect(result.typecheck).toBe("pass")
    expect(result.diagnostics.filter((d) => d.rule === "typecheck")).toHaveLength(0)
  }, 30_000)

  test("a route table no program loads is a warning, and listing it under files clears it", async () => {
    const cwd = project(["routes", "backend"])
    writeAppFile(
      cwd,
      "routes/link.ts",
      '// @ts-nocheck\nimport { Link } from "@nifrajs/web-react"\nexport const view = Link\n',
    )
    const result = await collectCheckResult(cwd)
    const findings = result.diagnostics.filter((d) => d.rule === "typecheck")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe("warning")
    expect(findings[0]?.file).toBe(".nifra/types/routes.d.ts")
    expect(findings[0]?.message).toContain("is outside tsc's program")
    // A warning leaves the typecheck itself standing: it read every zoned file.
    expect(result.typecheck).toBe("pass")

    writeAppFile(
      cwd,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ["routes", "backend"],
        files: [".nifra/types/routes.d.ts"],
      }),
    )
    const fixed = await collectCheckResult(cwd)
    expect(fixed.diagnostics.filter((d) => d.rule === "typecheck")).toHaveLength(0)
  }, 60_000)

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

describe("nifra check - more than one TypeScript program", () => {
  const options = { strict: true, noEmit: true, skipLibCheck: true, types: [] }

  function zones(cwd: string, backendSource = "export const port: number = 3000\n"): string {
    writeAppFile(cwd, "routes/index.ts", "export const title: string = 'home'\n")
    writeAppFile(cwd, "backend/app.ts", backendSource)
    return cwd
  }

  test("a solution-style tsconfig typechecks every project it references", async () => {
    const cwd = zones(createFixtureProject(root, "refs-"))
    writeAppFile(
      cwd,
      "tsconfig.json",
      JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.web.json" }, { path: "./server" }],
      }),
    )
    const composite = { ...options, composite: true, noEmit: undefined, emitDeclarationOnly: true }
    writeAppFile(
      cwd,
      "tsconfig.web.json",
      JSON.stringify({ compilerOptions: composite, include: ["routes"] }),
    )
    writeAppFile(
      cwd,
      "server/tsconfig.json",
      JSON.stringify({ compilerOptions: composite, include: ["../backend"] }),
    )
    const result = await collectCheckResult(cwd)
    expect(result.typecheck).toBe("pass")
    expect(result.diagnostics.filter((d) => d.rule === "typecheck")).toEqual([])

    // An error in a referenced project fails the check; tsc -p on the root alone read no file.
    writeAppFile(cwd, "backend/app.ts", "export const port: number = 'many'\n")
    const failing = await collectCheckResult(cwd)
    expect(failing.typecheck).toBe("fail")
    expect(failing.diagnostics.map((d) => [d.file, d.message])).toEqual([
      ["backend/app.ts", "Type 'string' is not assignable to type 'number'."],
    ])
  }, 60_000)

  test('nifra.check.json "tsconfigs" runs each named config, and a file both hold reports once', async () => {
    const cwd = zones(
      createFixtureProject(root, "configs-"),
      "export const port: number = 'many'\n",
    )
    writeAppFile(
      cwd,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: options, include: ["routes", "backend"] }),
    )
    writeAppFile(
      cwd,
      "tsconfig.server.json",
      JSON.stringify({ extends: "./tsconfig.json", include: ["backend"] }),
    )
    writeAppFile(
      cwd,
      "nifra.check.json",
      JSON.stringify({ tsconfigs: ["tsconfig.json", "tsconfig.server.json"] }),
    )
    const result = await collectCheckResult(cwd)
    expect(result.tsconfigs).toEqual(["tsconfig.json", "tsconfig.server.json"])
    expect(result.typecheck).toBe("fail")
    expect(result.diagnostics.map((d) => [d.file, d.message])).toEqual([
      ["backend/app.ts", "Type 'string' is not assignable to type 'number'."],
    ])
    expect(renderCheckReport(result)).toContain(
      '• typecheck programs (nifra.check.json "tsconfigs"): tsconfig.json, tsconfig.server.json',
    )
  }, 60_000)

  test("each config covers its own folder: zoned files in either program are read", async () => {
    const cwd = zones(createFixtureProject(root, "split-"))
    writeAppFile(
      cwd,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: options, include: ["routes"] }),
    )
    writeAppFile(
      cwd,
      "tsconfig.server.json",
      JSON.stringify({ compilerOptions: options, include: ["backend"] }),
    )
    expect((await collectCheckResult(cwd)).typecheck).toBe("fail")
    writeAppFile(
      cwd,
      "nifra.check.json",
      JSON.stringify({ tsconfigs: ["tsconfig.json", "tsconfig.server.json"] }),
    )
    const result = await collectCheckResult(cwd)
    expect(result.typecheck).toBe("pass")
    expect(result.diagnostics.filter((d) => d.rule === "typecheck")).toEqual([])
  }, 60_000)

  test("a configured tsconfig that does not exist fails the typecheck, naming it", async () => {
    const cwd = zones(createFixtureProject(root, "missing-"))
    writeAppFile(
      cwd,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: options, include: ["routes", "backend"] }),
    )
    writeAppFile(cwd, "nifra.check.json", JSON.stringify({ tsconfigs: ["tsconfig.gone.json"] }))
    const result = await collectCheckResult(cwd)
    expect(result.typecheck).toBe("fail")
    expect(JSON.stringify(result.diagnostics)).toContain(
      'nifra.check.json \\"tsconfigs\\" names \\"tsconfig.gone.json\\", which does not exist',
    )
  }, 30_000)
})
