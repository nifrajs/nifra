import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aliasMatcher,
  applyDoctorAutoFix,
  collectDoctorResult,
  collectDuplicateInstalls,
  packageOf,
  scanUndeclaredImports,
} from "../src/doctor.ts"

describe("packageOf — specifier → installable package name", () => {
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

describe("aliasMatcher — tsconfig paths are local, not npm deps", () => {
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

describe("scanUndeclaredImports — undeclared bare imports, all import forms", () => {
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
      ' * Usage: `import { z } from "zod"` — or dynamically `() => import("@vitejs/plugin-vue")`.',
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

describe("collectDoctorResult — project-level import vs declared-deps diff", () => {
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
    await rm(dir, { recursive: true, force: true })
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

describe("collectDuplicateInstalls — discovery anchored at the workspace root", () => {
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
      // Same VERSION, different physical directories - the case the plan calls out, since module
      // identity is path-based and aligning versions does not fix it.
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
