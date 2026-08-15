import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aliasMatcher,
  applyDoctorAutoFix,
  collectAllDuplicateInstalls,
  collectDoctorResult,
  collectDuplicateInstalls,
  collectStaleWorkspaceDists,
  packageOf,
  scanUndeclaredImports,
} from "../src/doctor.ts"

describe("packageOf - specifier → installable package name", () => {
  test("reduces subpaths to the package; keeps scope", () => {
    expect(packageOf("react")).toBe("react")
    expect(packageOf("drizzle-orm/postgres-js")).toBe("drizzle-orm")
    expect(packageOf("@nifrajs/core")).toBe("@nifrajs/core")
    expect(packageOf("@nifrajs/web/client")).toBe("@nifrajs/web")
  })

  test("returns undefined for non-deps: relative, absolute, builtins, malformed scope", () => {
    expect(packageOf("./db")).toBeUndefined()
    expect(packageOf("../x")).toBeUndefined()
    expect(packageOf("/abs")).toBeUndefined()
    expect(packageOf("node:fs")).toBeUndefined()
    expect(packageOf("bun:sqlite")).toBeUndefined()
    expect(packageOf("fs")).toBeUndefined() // bare node builtin
    expect(packageOf("path")).toBeUndefined()
    expect(packageOf("bun")).toBeUndefined() // Bun's own module
    expect(packageOf("@/components")).toBeUndefined() // path-alias shape, not a package
    expect(packageOf("@scope/../package")).toBeUndefined()
  })
})

describe("aliasMatcher - tsconfig paths are local, not npm deps", () => {
  test("matches alias prefixes (with and without /*)", () => {
    const isAlias = aliasMatcher({ "@/*": [], "~/utils": [], "@ui/*": [] })
    expect(isAlias("@/foo")).toBe(true)
    expect(isAlias("~/utils")).toBe(true)
    expect(isAlias("@ui/button")).toBe(true)
    expect(isAlias("@nifrajs/core")).toBe(false) // a real scoped package, not an alias
    expect(isAlias("react")).toBe(false)
  })

  test("empty/undefined paths match nothing", () => {
    expect(aliasMatcher(undefined)("react")).toBe(false)
    expect(aliasMatcher({})("anything")).toBe(false)
  })
})

describe("scanUndeclaredImports - undeclared bare imports, all import forms", () => {
  const declared = new Set(["react", "@nifrajs/core"])
  const noAlias = () => false

  test("flags only undeclared packages; covers import/from, side-effect, dynamic, require, re-export", () => {
    const src = [
      'import { useState } from "react"', // declared → ok
      'import { server } from "@nifrajs/core"', // declared → ok
      'import { z } from "zod"', // UNDECLARED
      'import "side-effect-pkg/register"', // UNDECLARED (side-effect)
      'const m = await import("dynamic-pkg")', // UNDECLARED (dynamic)
      'const c = require("cjs-pkg")', // UNDECLARED (require)
      'export { thing } from "reexport-pkg"', // UNDECLARED (re-export)
      'import { x } from "./local"', // relative → ok
      'import { readFile } from "node:fs"', // builtin → ok
    ].join("\n")
    const found = scanUndeclaredImports("a.ts", src, declared, noAlias)
    expect(found.map((f) => f.snippet).sort()).toEqual([
      "cjs-pkg",
      "dynamic-pkg",
      "reexport-pkg",
      "side-effect-pkg",
      "zod",
    ])
  })

  test("does not match identifiers that merely contain import/require", () => {
    const src = ["const myimport = 1", 'obj.import("x")', 'foorequire("y")'].join("\n")
    expect(scanUndeclaredImports("a.ts", src, declared, noAlias)).toHaveLength(0)
  })

  test("does NOT flag import examples written inside comments (the dogfood false-positive)", () => {
    const src = [
      "/**",
      ' * Usage: `import { z } from "zod"` - or dynamically `() => import("@vitejs/plugin-vue")`.',
      " */",
      '// also a line comment: require("commented-pkg") and export { y } from "ghost"',
      'import { useState } from "react"', // the only REAL import → declared → ok
    ].join("\n")
    expect(scanUndeclaredImports("a.ts", src, declared, noAlias)).toHaveLength(0)
  })

  test("ignores imports embedded in quoted documentation and generated-code strings", () => {
    const src = [
      `const singleDocs = 'Usage: import { server } from "nifra"'`,
      `const doubleDocs = "Usage: import { server } from 'nifra-double'"`,
      `lines.push('import { serve } from "@nifrajs/node"')`,
      `lines.push("const generated = require('generated-cjs')")`,
      `const realDynamic = await import("real-dynamic")`,
      `import { realStatic } from "real-static"`,
    ].join("\n")

    expect(scanUndeclaredImports("a.ts", src, new Set(), noAlias)).toEqual([
      { file: "a.ts", line: 5, snippet: "real-dynamic" },
      { file: "a.ts", line: 6, snippet: "real-static" },
    ])
  })

  test("skips alias specifiers", () => {
    const isAlias = aliasMatcher({ "@/*": [] })
    const src = 'import { Button } from "@/ui/button"'
    expect(scanUndeclaredImports("a.ts", src, declared, isAlias)).toHaveLength(0)
  })

  test("dedupes per (package, line)", () => {
    const src = 'import { a } from "dup"; import { b } from "dup"' // two specifiers, same line+pkg
    const found = scanUndeclaredImports("a.ts", src, new Set(), noAlias)
    expect(found).toHaveLength(1)
    expect(found[0]?.snippet).toBe("dup")
  })
})

describe("collectDoctorResult - project-level import vs declared-deps diff", () => {
  test("flags the undeclared import, passes the declared one; reports import sites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-"))
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "^19" } }),
    )
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(
      join(dir, "src", "x.ts"),
      ['import { useState } from "react"', 'import { z } from "zod"'].join("\n"),
    )
    const result = await collectDoctorResult(dir)
    expect(result.ran).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ file: "src/x.ts", package: "zod" })
    await rm(dir, { recursive: true, force: true })
  })

  test("clean project (all imports declared) passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-"))
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "^19" },
        devDependencies: { zod: "^3" },
      }),
    )
    await writeFile(join(dir, "x.ts"), 'import "react"\nimport "zod"\nimport "node:fs"')
    const result = await collectDoctorResult(dir)
    expect(result.ok).toBe(true)
    expect(result.findings).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  test("uses each workspace package's own dependency declarations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-workspaces-"))
    try {
      const app = join(dir, "packages", "app")
      const lib = join(dir, "packages", "lib")
      await mkdir(join(app, "src"), { recursive: true })
      await mkdir(join(lib, "src"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "workspace", private: true, workspaces: ["packages/*"] }),
      )
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({ name: "app", dependencies: { react: "^19" } }),
      )
      await writeFile(
        join(lib, "package.json"),
        JSON.stringify({ name: "lib", dependencies: { valibot: "^1" } }),
      )
      await writeFile(join(app, "src", "x.ts"), 'import "react"\nimport "valibot"')
      await writeFile(join(lib, "src", "x.ts"), 'import "valibot"')

      const result = await collectDoctorResult(dir)
      expect(result.findings).toEqual([
        { file: "packages/app/src/x.ts", line: 2, package: "valibot" },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("auto-fix writes the owning workspace manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-workspace-fix-"))
    try {
      const app = join(dir, "packages", "app")
      await mkdir(join(app, "src"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"], dependencies: { zod: "^4" } }),
      )
      await writeFile(join(app, "package.json"), JSON.stringify({ name: "app" }))
      await writeFile(join(app, "src", "x.ts"), 'import "zod"')

      const result = await applyDoctorAutoFix(dir)
      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>
      }
      const child = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>
      }
      expect(result.ok).toBe(true)
      expect(root.dependencies?.zod).toBe("^4")
      expect(child.dependencies?.zod).toBe("^4")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("finds the hoisted root copy even when the root manifest does not declare it", async () => {
    // The real split: every declaring package nests onto one copy while the root holds another. Only
    // consulting declarers sees one path and reports nothing.
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-hoisted-"))
    try {
      const app = join(dir, "packages", "app")
      await mkdir(join(app, "src"), { recursive: true })
      await mkdir(join(dir, "node_modules", "@nifrajs", "core"), { recursive: true })
      await mkdir(join(app, "node_modules", "@nifrajs", "core"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "workspace", private: true, workspaces: ["packages/*"] }),
      )
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "1.13.0" } }),
      )
      await writeFile(join(app, "src", "x.ts"), 'import { server } from "@nifrajs/core"')
      await writeFile(
        join(dir, "node_modules", "@nifrajs", "core", "package.json"),
        JSON.stringify({ name: "@nifrajs/core", version: "1.13.0" }),
      )
      await writeFile(
        join(app, "node_modules", "@nifrajs", "core", "package.json"),
        JSON.stringify({ name: "@nifrajs/core", version: "1.12.0" }),
      )

      const result = await collectDoctorResult(dir)
      expect(result.duplicateInstalls).toHaveLength(1)
      expect(result.duplicateInstalls[0]?.copies.map((copy) => copy.version).sort()).toEqual([
        "1.12.0",
        "1.13.0",
      ])
      expect(result.duplicateInstalls[0]?.cause).toBe("version-skew")
      expect(result.duplicateInstalls[0]?.versions).toEqual(["1.12.0", "1.13.0"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fails when workspaces resolve different physical copies even at the same version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-duplicates-"))
    const app = join(dir, "packages", "app")
    await mkdir(join(app, "src"), { recursive: true })
    await mkdir(join(dir, "node_modules", "@nifrajs", "core"), { recursive: true })
    await mkdir(join(app, "node_modules", "@nifrajs", "core"), { recursive: true })
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "workspace",
        private: true,
        workspaces: ["packages/*"],
        dependencies: { "@nifrajs/core": "1.12.0" },
      }),
    )
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "1.12.0" } }),
    )
    await writeFile(join(app, "src", "x.ts"), 'import { server } from "@nifrajs/core"')
    await writeFile(
      join(dir, "node_modules", "@nifrajs", "core", "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "1.12.0" }),
    )
    await writeFile(
      join(app, "node_modules", "@nifrajs", "core", "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "1.12.0" }),
    )

    const result = await collectDoctorResult(dir)
    expect(result.ok).toBe(false)
    expect(result.duplicateInstalls).toHaveLength(1)
    expect(result.duplicateInstalls[0]?.package).toBe("@nifrajs/core")
    expect(result.duplicateInstalls[0]?.copies.map((copy) => copy.version)).toEqual([
      "1.12.0",
      "1.12.0",
    ])
    expect(result.duplicateInstalls[0]?.cause).toBe("duplicate-path")
    expect(result.duplicateInstalls[0]?.versions).toEqual(["1.12.0"])
    await rm(dir, { recursive: true, force: true })
  })

  test("flags a package that IS installed in node_modules but declared in no manifest", async () => {
    // Resolvability is not evidence of declaration. `zod` sits in node_modules because some OTHER
    // dependency pulled it in transitively, so the import resolves, `bun install` reports no changes,
    // and a hoisted local `tsc` is green - while a clean `bun install --frozen-lockfile` produces a
    // tree without it. doctor diffs against DECLARED deps only, never against what is on disk.
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-transitive-"))
    try {
      await mkdir(join(dir, "src"), { recursive: true })
      await mkdir(join(dir, "node_modules", "zod"), { recursive: true })
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
      await writeFile(
        join(dir, "node_modules", "zod", "package.json"),
        JSON.stringify({ name: "zod", version: "4.4.3" }),
      )
      await writeFile(join(dir, "src", "x.ts"), 'import * as z from "zod"')

      const result = await collectDoctorResult(dir)
      expect(result.ok).toBe(false)
      expect(result.findings).toEqual([{ file: "src/x.ts", line: 1, package: "zod" }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("scans test files - an undeclared import there breaks the same clean build", async () => {
    // The gap that shipped: `nifra check` skips `*.test.ts` (tests legitimately drive `fetch`), and
    // doctor inherited that surface. So an undeclared `zod` in a test passed doctor, passed a hoisted
    // local `tsc`, then failed CI with `TS2307: Cannot find module 'zod'`. `tsc` compiles tests.
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-tests-"))
    try {
      await mkdir(join(dir, "test"), { recursive: true })
      await mkdir(join(dir, "node_modules", "zod"), { recursive: true })
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
      await writeFile(
        join(dir, "node_modules", "zod", "package.json"),
        JSON.stringify({ name: "zod", version: "4.4.3" }),
      )
      await writeFile(join(dir, "test", "contract.test.ts"), 'import * as z from "zod"')
      await writeFile(join(dir, "test", "other.spec.tsx"), 'import "spec-only-pkg"')

      const result = await collectDoctorResult(dir)
      expect(result.ok).toBe(false)
      expect(result.findings).toEqual([
        { file: "test/contract.test.ts", line: 1, package: "zod" },
        { file: "test/other.spec.tsx", line: 1, package: "spec-only-pkg" },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a test file whose imports are declared still passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-tests-clean-"))
    try {
      await mkdir(join(dir, "test"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "app", devDependencies: { zod: "^4.4.3" } }),
      )
      await writeFile(
        join(dir, "test", "contract.test.ts"),
        ['import { test } from "bun:test"', 'import * as z from "zod"'].join("\n"),
      )

      const result = await collectDoctorResult(dir)
      expect(result.ok).toBe(true)
      expect(result.findings).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a package importing its own name is not flagged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-"))
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@nifrajs/web" }))
    await writeFile(join(dir, "x.ts"), 'import { build } from "@nifrajs/web/build"')
    const result = await collectDoctorResult(dir)
    expect(result.ok).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("no package.json → ran:false, ok:true (cannot check, not a failure)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-"))
    const result = await collectDoctorResult(dir)
    expect(result.ran).toBe(false)
    expect(result.ok).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("auto-fix copies a declared ancestor dependency spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-"))
    const app = join(dir, "packages", "app")
    await mkdir(join(app, "src"), { recursive: true })
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ private: true, dependencies: { zod: "^4.1.0" } }),
    )
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "app" }))
    await writeFile(join(app, "src", "x.ts"), 'import { z } from "zod"')

    const result = await applyDoctorAutoFix(app)
    const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(result.ok).toBe(true)
    expect(result.fixed).toEqual([
      {
        package: "zod",
        field: "dependencies",
        version: "^4.1.0",
        source: "ancestor-package-json",
      },
    ])
    expect(pkg.dependencies?.zod).toBe("^4.1.0")
    await rm(dir, { recursive: true, force: true })
  })

  test("auto-fix infers a version from local node_modules metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await mkdir(join(dir, "node_modules", "zod"), { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
    await writeFile(join(dir, "src", "x.ts"), 'import { z } from "zod"')
    await writeFile(
      join(dir, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "4.2.3" }),
    )

    const result = await applyDoctorAutoFix(dir)
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(result.ok).toBe(true)
    expect(result.fixed).toEqual([
      {
        package: "zod",
        field: "dependencies",
        version: "^4.2.3",
        source: "installed-package-json",
      },
    ])
    expect(pkg.dependencies?.zod).toBe("^4.2.3")
    await rm(dir, { recursive: true, force: true })
  })

  test("auto-fix skips packages whose version is not locally knowable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
    await writeFile(join(dir, "src", "x.ts"), 'import "not-installed-here"')

    const result = await applyDoctorAutoFix(dir)
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(result.ok).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.skippedFixes).toEqual([
      {
        package: "not-installed-here",
        reason: "no declared ancestor version or installed package metadata was found locally",
        command: ["bun", "add", "not-installed-here"],
      },
    ])
    expect(pkg.dependencies).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})

describe("doctor production readiness", () => {
  test("reports the table and only strict mode fails an unconfigured app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-readiness-"))
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
      await writeFile(
        join(dir, "backend.ts"),
        'const app = server().get("/users", () => ({ ok: true }))\nexport { app }\n',
      )
      const advisory = await collectDoctorResult(dir, { target: "cf-pages" })
      expect(advisory.ok).toBe(true)
      expect(advisory.readiness?.items.filter((item) => item.status === "absent")).toHaveLength(5)
      expect(
        advisory.readiness?.items.find((item) => item.id === "graceful-lifecycle")?.status,
      ).toBe("not-applicable")

      const strict = await collectDoctorResult(dir, { target: "cf-pages", strict: true })
      expect(strict.ok).toBe(false)
      expect(strict.readiness?.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("passes strict mode when all applicable rules have static evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-readiness-complete-"))
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
      await writeFile(
        join(dir, "backend.ts"),
        `const app = server({
  requestTimeoutMs: 1000,
  admission: gate,
  logger: jsonLogger(),
  gracefulSignals: true,
})
  .use(requestId())
  .use(tracing())
  .use(healthcheck())
  .get("/health", () => ({ ok: true }))
export { app }
`,
      )
      const result = await collectDoctorResult(dir, { target: "bun", strict: true })
      expect(result.ok).toBe(true)
      expect(result.readiness?.ok).toBe(true)
      expect(result.readiness?.items.every((item) => item.status === "configured")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Each widened pattern gets a matching AND a deliberately-non-matching sample, so the next
  // widening cannot silently turn a rule into "always configured".
  const readinessItem = async (source: string, id: string) => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-readiness-item-"))
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
      await writeFile(join(dir, "backend.ts"), source)
      const result = await collectDoctorResult(dir, { target: "bun" })
      return result.readiness?.items.find((item) => item.id === id)?.status
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("admission accepts the ES6 shorthand property forms", async () => {
    expect(await readinessItem("const app = server({ admission })\n", "admission")).toBe(
      "configured",
    )
    expect(await readinessItem("const app = server({ admission, logger })\n", "admission")).toBe(
      "configured",
    )
    expect(await readinessItem("const app = server({ logger, admission })\n", "admission")).toBe(
      "configured",
    )
    expect(
      await readinessItem("const app = server({\n  admission,\n  logger,\n})\n", "admission"),
    ).toBe("configured")
  })

  test("admission accepts the documented constructor call", async () => {
    expect(
      await readinessItem(
        "const gate = createAdmissionController({ maxConcurrent: 64 })\n",
        "admission",
      ),
    ).toBe("configured")
  })

  test("admission stays absent for near-miss identifiers", async () => {
    // A longer identifier, a member access, and an unrelated app: none is wired admission.
    expect(await readinessItem("const admissionless = true\n", "admission")).toBe("absent")
    expect(await readinessItem("const x = admission.evaluate()\n", "admission")).toBe("absent")
    expect(await readinessItem('const app = server().get("/", () => 1)\n', "admission")).toBe(
      "absent",
    )
  })

  test("log-redaction accepts the framework request logger and redacting constructors", async () => {
    expect(await readinessItem("const app = server().use(logger())\n", "log-redaction")).toBe(
      "configured",
    )
    expect(
      await readinessItem("const app = server({ logger: jsonLogger() })\n", "log-redaction"),
    ).toBe("configured")
    expect(
      await readinessItem("const log = redactLogFields(base, ['password'])\n", "log-redaction"),
    ).toBe("configured")
  })

  test("log-redaction stays absent for a bare logger property that redacts nothing", async () => {
    expect(await readinessItem("const app = server({ logger: console })\n", "log-redaction")).toBe(
      "absent",
    )
    expect(await readinessItem("const app = server({ logger: myLogger })\n", "log-redaction")).toBe(
      "absent",
    )
  })

  test("health-route fallback accepts the conventional path variants", async () => {
    for (const path of ["/health", "/healthz", "/health-check", "/_health", "/health/live"]) {
      expect(
        await readinessItem(
          `const app = server().get("${path}", () => ({ ok: true }))\n`,
          "health-route",
        ),
      ).toBe("configured")
    }
  })

  test("health-route fallback stays absent for non-health paths", async () => {
    expect(
      await readinessItem('const app = server().get("/healthy", () => 1)\n', "health-route"),
    ).toBe("absent")
    expect(
      await readinessItem('const app = server().get("/users", () => 1)\n', "health-route"),
    ).toBe("absent")
  })
})

describe("collectDuplicateInstalls - discovery anchored at the workspace root", () => {
  test("finds a sibling package's duplicate when run from an app subdirectory", async () => {
    // The configuration the check was blind in, and the normal one: you run `nifra check` from the
    // app, whose manifest declares no `workspaces`, so discovery collapsed to the app itself and the
    // sibling holding the second copy was never probed. It reported "none" while dev 500'd.
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-wsroot-"))
    try {
      const app = join(dir, "apps", "web")
      const kit = join(dir, "packages", "kit")
      await mkdir(join(app, "src"), { recursive: true })
      await mkdir(join(kit, "node_modules", "react"), { recursive: true })
      await mkdir(join(dir, "node_modules", "react"), { recursive: true })
      // A `.git` at the real root, so the upward walk has a boundary to respect.
      await mkdir(join(dir, ".git"), { recursive: true })

      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
      )
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({ name: "web", dependencies: { react: "19.2.7" } }),
      )
      await writeFile(
        join(kit, "package.json"),
        JSON.stringify({ name: "kit", dependencies: { react: "19.2.7" } }),
      )
      // Same VERSION, different physical directories - still two copies, because module identity is
      // path-based and aligning versions does not merge them.
      await writeFile(
        join(dir, "node_modules", "react", "package.json"),
        JSON.stringify({ name: "react", version: "19.2.7" }),
      )
      await writeFile(
        join(kit, "node_modules", "react", "package.json"),
        JSON.stringify({ name: "react", version: "19.2.7" }),
      )

      const appPkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<
        string,
        unknown
      >
      const findings = await collectDuplicateInstalls(app, appPkg)

      expect(findings).toHaveLength(1)
      expect(findings[0]?.package).toBe("react")
      expect(findings[0]?.copies).toHaveLength(2)
      // Identical versions: the finding is about two paths, not two versions.
      expect(findings[0]?.copies.map((c) => c.version)).toEqual(["19.2.7", "19.2.7"])
      expect(findings[0]?.explanation).toContain("physical path")
      // Nothing declared this package single-copy, so it is still a hard finding, and the remediation
      // names both ways out: one physical path, or a declaration nifra enforces.
      expect(findings[0]?.deduplicated).toBe(false)
      expect(findings[0]?.remediation).toContain("single physical path")
      expect(findings[0]?.remediation).toContain("singleCopy")
      // The shape of the split, carried through to doctor unchanged: both copies live under install
      // roots the workspace owns, so this one collapses with a reinstall.
      expect(findings[0]?.topology).toContain("2 paths under 2 install roots")
      expect(findings[0]?.topology).toContain("inside the scanned root")

      // doctor states the basis it answered on. The reported failure mode was doctor saying "none"
      // while the build guard failed: with the workspace named in both outputs, a disagreement is
      // legible instead of looking like two tools contradicting each other.
      const identity = await collectAllDuplicateInstalls(app, appPkg)
      expect(identity.duplicates).toHaveLength(1)
      expect(identity.basis).toContain("the workspace governing")
      expect(identity.truncated).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a declared single-copy duplicate leaves the failing set and lands in the reported one", async () => {
    // Same fixture as above plus the declaration. `nifra check` must go green on it: the copies are
    // real, but the resolver collapses them, and the only alternative would be to demand a topology
    // change (one shared node_modules) that a linked sibling repo cannot make.
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-single-copy-"))
    try {
      const app = join(dir, "apps", "web")
      const kit = join(dir, "packages", "kit")
      await mkdir(join(app, "src"), { recursive: true })
      await mkdir(join(kit, "node_modules", "react"), { recursive: true })
      await mkdir(join(dir, "node_modules", "react"), { recursive: true })
      await mkdir(join(dir, ".git"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
      )
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({
          name: "web",
          dependencies: { react: "19.2.7" },
          nifra: { singleCopy: ["react"] },
        }),
      )
      await writeFile(
        join(kit, "package.json"),
        JSON.stringify({ name: "kit", dependencies: { react: "19.2.7" } }),
      )
      for (const copy of [join(dir, "node_modules", "react"), join(kit, "node_modules", "react")]) {
        await writeFile(
          join(copy, "package.json"),
          JSON.stringify({ name: "react", version: "19.2.7" }),
        )
      }
      const appPkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<
        string,
        unknown
      >
      const identity = await collectAllDuplicateInstalls(app, appPkg)
      expect(identity.duplicates).toEqual([])
      expect(identity.deduplicated).toHaveLength(1)
      expect(identity.deduplicated[0]?.package).toBe("react")
      expect(identity.deduplicated[0]?.deduplicated).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not adopt an ancestor whose workspace globs do not cover cwd", async () => {
    // A parent directory that merely contains a manifest is not this project's root. Adopting one
    // would silently widen the scan into an unrelated tree.
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-unrelated-"))
    try {
      const project = join(dir, "elsewhere", "project")
      await mkdir(join(project, "src"), { recursive: true })
      await mkdir(join(dir, "node_modules", "react"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        // Globs cover `packages/*`, which does NOT contain `elsewhere/project`.
        JSON.stringify({ name: "unrelated-root", private: true, workspaces: ["packages/*"] }),
      )
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: "project", dependencies: { react: "19.2.7" } }),
      )
      await writeFile(
        join(dir, "node_modules", "react", "package.json"),
        JSON.stringify({ name: "react", version: "19.2.7" }),
      )
      const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as Record<
        string,
        unknown
      >
      // One reachable copy only ⇒ no finding, and no crash from the widened walk.
      expect(await collectDuplicateInstalls(project, pkg)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("follows a symlinked dependency into a sibling checkout that installed its own copy", async () => {
    // `link:`/`npm link` of a package from another repo. The link target has its own node_modules, so
    // code crossing the link runs against a SECOND @nifrajs/core - different registries and symbols -
    // while a scan bounded by this workspace sees exactly one copy and reports clean.
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-linked-"))
    try {
      const app = join(dir, "app")
      const sibling = join(dir, "sibling")
      await mkdir(join(app, "node_modules", "@nifrajs", "core"), { recursive: true })
      await mkdir(join(sibling, "node_modules", "@nifrajs", "core"), { recursive: true })
      await mkdir(join(sibling, ".git"), { recursive: true })
      await mkdir(join(app, "node_modules", "@myorg"), { recursive: true })
      await symlink(sibling, join(app, "node_modules", "@myorg", "kit"), "dir")

      await writeFile(
        join(app, "package.json"),
        JSON.stringify({
          name: "app",
          dependencies: { "@nifrajs/core": "2.11.0", "@myorg/kit": "link:../sibling" },
        }),
      )
      await writeFile(
        join(sibling, "package.json"),
        JSON.stringify({ name: "@myorg/kit", dependencies: { "@nifrajs/core": "2.11.0" } }),
      )
      await writeFile(
        join(app, "node_modules", "@nifrajs", "core", "package.json"),
        JSON.stringify({ name: "@nifrajs/core", version: "2.11.0" }),
      )
      await writeFile(
        join(sibling, "node_modules", "@nifrajs", "core", "package.json"),
        JSON.stringify({ name: "@nifrajs/core", version: "2.11.0" }),
      )

      const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<
        string,
        unknown
      >
      const findings = await collectDuplicateInstalls(app, pkg)

      expect(findings).toHaveLength(1)
      expect(findings[0]?.package).toBe("@nifrajs/core")
      expect(findings[0]?.copies).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a symlinked dependency resolving to the same copy is not a duplicate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-linked-clean-"))
    try {
      const app = join(dir, "app")
      const sibling = join(dir, "sibling")
      await mkdir(join(app, "node_modules", "@myorg"), { recursive: true })
      await mkdir(join(app, "node_modules", "@nifrajs", "core"), { recursive: true })
      await mkdir(sibling, { recursive: true })
      await mkdir(join(sibling, ".git"), { recursive: true })
      await symlink(sibling, join(app, "node_modules", "@myorg", "kit"), "dir")
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({
          name: "app",
          dependencies: { "@nifrajs/core": "2.11.0", "@myorg/kit": "link:../sibling" },
        }),
      )
      // The sibling declares the dependency but installed nothing: it resolves nowhere of its own,
      // so there is still exactly one copy on disk.
      await writeFile(
        join(sibling, "package.json"),
        JSON.stringify({ name: "@myorg/kit", dependencies: { "@nifrajs/core": "2.11.0" } }),
      )
      await writeFile(
        join(app, "node_modules", "@nifrajs", "core", "package.json"),
        JSON.stringify({ name: "@nifrajs/core", version: "2.11.0" }),
      )
      const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<
        string,
        unknown
      >
      expect(await collectDuplicateInstalls(app, pkg)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no workspace root above cwd leaves the previous behaviour intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-standalone-"))
    try {
      await mkdir(join(dir, "src"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "solo", dependencies: { react: "19.2.7" } }),
      )
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<
        string,
        unknown
      >
      expect(await collectDuplicateInstalls(dir, pkg)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("collectStaleWorkspaceDists - a linked dep's dist lagging its src", () => {
  // The trap: `"exports": { "bun": "./src/…", "default": "./dist/…" }` makes Bun read live source
  // while Vite's SSR runner / node consumers read a build artifact nothing regenerates. Only a
  // SYMLINKED (workspace) install can drift - a tarball under node_modules is immutable.
  const scaffold = async (
    dir: string,
    opts: { readonly distMtime?: Date; readonly writeDist?: boolean; readonly link?: boolean },
  ): Promise<Record<string, unknown>> => {
    const lib = join(dir, "libs", "lib")
    await mkdir(join(lib, "src"), { recursive: true })
    await mkdir(join(lib, "dist"), { recursive: true })
    await writeFile(
      join(lib, "package.json"),
      JSON.stringify({
        name: "lib",
        version: "1.0.0",
        exports: {
          ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
        },
      }),
    )
    await writeFile(join(lib, "src", "index.ts"), "export const x = 1\n")
    if (opts.writeDist !== false) {
      await writeFile(join(lib, "dist", "index.js"), "export const x = 1;\n")
      if (opts.distMtime !== undefined)
        await utimes(join(lib, "dist", "index.js"), opts.distMtime, opts.distMtime)
    }
    const app = join(dir, "app")
    await mkdir(join(app, "node_modules"), { recursive: true })
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "app", dependencies: { lib: "workspace:*" } }),
    )
    if (opts.link !== false) await symlink(lib, join(app, "node_modules", "lib"), "dir")
    return JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<string, unknown>
  }

  test("flags a dist older than the newest source file, with the lag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-stale-dist-"))
    try {
      const appPkg = await scaffold(dir, { distMtime: new Date(Date.now() - 60_000) })
      const findings = await collectStaleWorkspaceDists(join(dir, "app"), appPkg)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.package).toBe("lib")
      expect(findings[0]?.missing).toBe(false)
      expect(findings[0]?.behindSeconds).toBeGreaterThanOrEqual(59)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("flags a dist that was never built at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-stale-dist-"))
    try {
      const appPkg = await scaffold(dir, { writeDist: false })
      const findings = await collectStaleWorkspaceDists(join(dir, "app"), appPkg)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.missing).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a fresh dist and a real (non-symlink) install both report nothing", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "nifra-doctor-stale-dist-"))
    const copied = await mkdtemp(join(tmpdir(), "nifra-doctor-stale-dist-"))
    try {
      // Fresh: dist written after src → not stale.
      const freshPkg = await scaffold(fresh, {})
      expect(await collectStaleWorkspaceDists(join(fresh, "app"), freshPkg)).toEqual([])
      // Real install: same stale layout, but a physical dir under node_modules (immutable tarball).
      const copiedPkg = await scaffold(copied, { link: false, distMtime: new Date(0) })
      const target = join(copied, "app", "node_modules", "lib")
      await mkdir(join(target, "src"), { recursive: true })
      await mkdir(join(target, "dist"), { recursive: true })
      await writeFile(
        join(target, "package.json"),
        JSON.stringify({
          name: "lib",
          version: "1.0.0",
          exports: { ".": { bun: "./src/index.ts", default: "./dist/index.js" } },
        }),
      )
      await writeFile(join(target, "src", "index.ts"), "export const x = 1\n")
      await writeFile(join(target, "dist", "index.js"), "export const x = 1;\n")
      await utimes(join(target, "dist", "index.js"), new Date(0), new Date(0))
      expect(await collectStaleWorkspaceDists(join(copied, "app"), copiedPkg)).toEqual([])
    } finally {
      await rm(fresh, { recursive: true, force: true })
      await rm(copied, { recursive: true, force: true })
    }
  })
})

describe("collectDoctorResult - CLI-vs-project version drift", () => {
  const installCore = async (dir: string, version: string): Promise<void> => {
    const coreDir = join(dir, "node_modules", "@nifrajs", "core")
    await mkdir(coreDir, { recursive: true })
    await writeFile(
      join(coreDir, "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version }),
    )
  }

  test("flags a running CLI a feature version behind the installed core - advisory, not ok-failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-drift-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "^2.11.0" } }),
      )
      await installCore(dir, "2.11.3")
      const result = await collectDoctorResult(dir, { cliVersion: "2.10.0" })
      expect(result.toolingDrift).toEqual({
        cli: "2.10.0",
        project: "2.11.3",
        package: "@nifrajs/core",
      })
      // Drift is an environment condition, never a project defect: it must not fail the gate on its own.
      expect(result.ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no drift when feature versions agree (patch differences ignored)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-drift-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "^2.11.0" } }),
      )
      await installCore(dir, "2.11.9")
      const result = await collectDoctorResult(dir, { cliVersion: "2.11.0" })
      expect(result.toolingDrift).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("never computed when the caller omits cliVersion (MCP path annotates drift itself)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-doctor-drift-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "app", dependencies: { "@nifrajs/core": "^2.11.0" } }),
      )
      await installCore(dir, "1.0.0")
      const result = await collectDoctorResult(dir)
      expect(result.toolingDrift).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
