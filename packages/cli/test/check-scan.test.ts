import { describe, expect, test } from "bun:test"
import ts from "typescript"
import {
  importSites,
  resolveServerOnlyChains,
  scanFetchText,
  scanResponseRoutes,
  scanServerOnlyImports,
  scanStaticRouteText,
  stripComments,
} from "../src/check-scan.ts"
import { createSourceFacts } from "../src/internal/source-facts.ts"

describe("check-scan", () => {
  test("strips comments and template code without changing offsets", () => {
    const source = '// fetch("/comment")\nconst x = `fetch("/template")`\nfetch("/real")'
    const stripped = stripComments(source)
    expect(stripped.length).toBe(source.length)
    expect(stripped.slice(0, source.indexOf('fetch("/real")'))).not.toContain("/comment")
    expect(stripped).toContain('fetch("/real")')
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
})
