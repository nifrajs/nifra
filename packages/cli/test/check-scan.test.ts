import { describe, expect, test } from "bun:test"
import ts from "typescript"
import {
  codePositionMask,
  importSites,
  resolveServerOnlyChains,
  scanFetchText,
  scanResponseRoutes,
  scanServerOnlyImports,
  scanStaticRouteText,
  stripComments,
} from "../src/check-scan.ts"
import { scanUndeclaredImports } from "../src/doctor.ts"
import { createSourceFacts } from "../src/internal/source-facts.ts"

describe("check-scan", () => {
  test("strips comments and template code without changing offsets", () => {
    const source = '// fetch("/comment")\nconst x = `fetch("/template")`\nfetch("/real")'
    const stripped = stripComments(source)
    expect(stripped.length).toBe(source.length)
    expect(stripped.slice(0, source.indexOf('fetch("/real")'))).not.toContain("/comment")
    expect(stripped).toContain('fetch("/real")')
  })

  test("a quote or backtick inside a regex literal does not open a string", () => {
    const source = [
      "const QUOTED = /(['\"`])x\\1/g",
      '// an example: import("x") and require("y")',
      'const fence = text.replace(/```[\\s\\S]*?```/g, " ")',
      'fetch("/after-regex")',
    ].join("\n")
    const stripped = stripComments(source)
    expect(stripped.length).toBe(source.length)
    expect(stripped).not.toContain('import("x")')
    expect(stripped).toContain('fetch("/after-regex")')
    expect(scanFetchText("routes/index.tsx", source).map((f) => f.line)).toEqual([4])
    const imports = scanUndeclaredImports("src/a.ts", source, new Set(), () => false)
    expect(imports).toEqual([])
  })

  test("division and regex literals are told apart by what precedes the slash", () => {
    const source = [
      'const half = total / 2 / "x".length',
      "const r = cond ? /'/ : /\"/",
      "function f() { return /[/']/.test(s) }",
      'import("real-dep")',
    ].join("\n")
    const mask = codePositionMask(source)
    expect(mask.split("\n")[0]).toContain("total / 2 /")
    expect(mask.split("\n")[1]).toBe("const r = cond ?     :    ")
    expect(mask.split("\n")[2]).toContain(`return ${" ".repeat("/[/']/".length)}.test(s)`)
    const imports = scanUndeclaredImports("src/a.ts", source, new Set(), () => false)
    expect(imports.map((finding) => finding.line)).toEqual([4])
  })

  test("finds same-origin fetches while honoring external mounts", () => {
    const findings = scanFetchText(
      "routes/index.tsx",
      'fetch("/users")\nfetch("/auth/session")\nfetch("https://example.test/users")',
      ["/auth"],
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  test("keeps server-only import scanning scoped to route modules", () => {
    expect(scanServerOnlyImports("routes/users.tsx", 'import fs from "node:fs"')).toHaveLength(1)
    expect(scanServerOnlyImports("server/db.ts", 'import fs from "node:fs"')).toEqual([])
  })

  test("a value re-export is an import edge; a type-only one is not", () => {
    const reexports = [
      'export { readFileSync } from "node:fs"',
      'export * from "pg"',
      'export * as redis from "ioredis"',
      'export type { Stats } from "node:fs"',
      'export type * from "postgres"',
      "export const from = 1",
    ].join("\n")
    expect(scanServerOnlyImports("routes/index.tsx", reexports).map((f) => f.specifier)).toEqual([
      "node:fs",
      "pg",
      "ioredis",
    ])
    // The parser also sees an all-type named re-export, which the lexical rule keeps as an edge.
    const inline = 'export { type Stats } from "node:fs"\nexport { type A, b } from "pg"'
    expect(
      scanServerOnlyImports("routes/index.tsx", inline, createSourceFacts(ts)).map(
        (f) => f.specifier,
      ),
    ).toEqual(["pg"])
    expect(importSites('export * from "../frontend/widget.tsx"', "backend/api.ts")).toEqual([
      { specifier: "../frontend/widget.tsx", line: 1 },
    ])
  })

  test("the parser erases only an import its compiler erases", () => {
    const specifiers = (source: string, keeps = false) =>
      scanServerOnlyImports(
        "routes/index.tsx",
        source,
        createSourceFacts(ts, { keepsTypeOnlyImports: () => keeps }),
      ).map((f) => f.specifier)
    // A default binding loads its module whatever the named list holds, and so does `{}`.
    expect(specifiers('import pg, { type Pool } from "pg"\nexport const p = pg')).toEqual(["pg"])
    expect(specifiers('import {} from "pg"\nexport {} from "ioredis"')).toEqual(["pg", "ioredis"])
    const typeOnly = 'import { type Pool } from "pg"\nexport { type Stats } from "node:fs"'
    expect(specifiers(typeOnly)).toEqual([])
    // `verbatimModuleSyntax` emits each as `import {} from "pg"`, which loads the module.
    expect(specifiers(typeOnly, true)).toEqual(["pg", "node:fs"])
    expect(
      specifiers('import type { Pool } from "pg"\nexport type { Stats } from "node:fs"', true),
    ).toEqual([])
    const inline = 'import { type Theme } from "../frontend/theme"\n'
    expect(importSites(inline, "backend/report.ts", createSourceFacts(ts))).toEqual([])
    expect(importSites(inline, "backend/report.ts")).toEqual([
      { specifier: "../frontend/theme", line: 1 },
    ])
  })

  test("import edges scan a long module in linear time", () => {
    const long = Array.from({ length: 20_000 }, (_, i) => `export const value${i} = ${i}`).join(
      "\n",
    )
    const started = performance.now()
    expect(importSites(`${long}\nexport { last } from "./last.ts"`, "routes/x.tsx")).toEqual([
      { specifier: "./last.ts", line: 20_001 },
    ])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("a barrel's re-export carries the transitive server-only chain", () => {
    const files: Record<string, string> = {
      "lib/index.ts": 'export * from "./db-helpers.ts"\n',
      "lib/db-helpers.ts":
        'import postgres from "postgres"\nexport const list = () => postgres()\n',
    }
    const resolve = (from: string, specifier: string): string | undefined => {
      if (specifier === "../lib/index.ts") return "lib/index.ts"
      if (from === "lib/index.ts" && specifier === "./db-helpers.ts") return "lib/db-helpers.ts"
      return undefined
    }
    const chains = resolveServerOnlyChains(
      "routes/index.tsx",
      'import { list } from "../lib/index.ts"\nexport default () => list()\n',
      resolve,
      (path) => files[path],
    )
    expect(chains.map((finding) => finding.chain)).toEqual([
      ["routes/index.tsx", "../lib/index.ts", "./db-helpers.ts", "postgres"],
    ])
  })

  test("extracts static backend routes and raw-response advisories", () => {
    const source = 'server().get("/users", () => Response.json({ ok: true }))'
    expect(scanStaticRouteText("backend.ts", source)).toMatchObject([
      { method: "GET", path: "/users", line: 1 },
    ])
    expect(scanResponseRoutes("backend.ts", source)).toMatchObject([{ line: 1 }])
  })

  test("routes chained onto createWebApp are backend routes", () => {
    const source = 'export const site = createWebApp(options).get("/health", () => "ok")'
    expect(scanStaticRouteText("server.ts", source)).toEqual([
      expect.objectContaining({ method: "GET", path: "/health", line: 1 }),
    ])
  })
})
