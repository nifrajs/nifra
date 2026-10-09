import { afterAll, describe, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createServerOnlyChains } from "../src/check-scan.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const parent = createFixtureRoot("tmp-server-only-")
afterAll(() => removeFixtureRoot(parent))

/** A fake project: `files` by path, `../x` specifiers resolve to `x.ts`, and every read is counted. */
function graph(files: Record<string, string>) {
  let reads = 0
  const resolve = (_from: string, specifier: string): string | undefined => {
    const path = `${specifier.replace(/^(?:\.\.?\/)+/, "")}.ts`
    return files[path] === undefined ? undefined : path
  }
  const read = (path: string): string | undefined => {
    reads += 1
    return files[path]
  }
  return { chains: createServerOnlyChains({ resolve, read }), reads: () => reads }
}

describe("server-only chains", () => {
  test("a sink past 200 modules or 8 hops is still found", () => {
    const wide: Record<string, string> = {}
    const exports: string[] = []
    for (let i = 0; i < 250; i++) {
      wide[`lib/m${i}.ts`] = i === 249 ? 'import "node:fs"\n' : "export {}\n"
      exports.push(`export * from "../lib/m${i}"`)
    }
    wide["lib/barrel.ts"] = exports.join("\n")
    const barrel = graph(wide).chains("routes/index.tsx", 'import "../lib/barrel"\n')
    expect(barrel.map((finding) => finding.chain)).toEqual([
      ["routes/index.tsx", "../lib/barrel", "../lib/m249", "node:fs"],
    ])

    const deep: Record<string, string> = {}
    for (let i = 0; i < 12; i++)
      deep[`lib/d${i}.ts`] = i === 11 ? 'import "node:fs"\n' : `import "../lib/d${i + 1}"\n`
    const chain = graph(deep).chains("routes/index.tsx", 'import "../lib/d0"\n')[0]?.chain
    expect(chain).toHaveLength(14)
    expect(chain?.at(-1)).toBe("node:fs")
  })

  test("each module is read once however many routes share it", () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 250; i++)
      files[`lib/m${i}.ts`] = i < 249 ? `import "../lib/m${i + 1}"\n` : "export {}\n"
    const project = graph(files)
    for (let route = 0; route < 400; route++)
      expect(project.chains(`routes/r${route}.tsx`, `import "../lib/m${route % 250}"\n`)).toEqual(
        [],
      )
    expect(project.reads()).toBe(250)
  })
})

describe("server-only names match the browser build's", () => {
  test("server SDKs, bare server builtins, require() and backend workspace packages are sinks", async () => {
    const root = createFixtureProject(parent, "app-")
    const files: Record<string, string> = {
      "nifra.config.ts": "export const adapter = {}\n",
      "node_modules/@shop/db/package.json": JSON.stringify({
        name: "@shop/db",
        nifra: { environment: "backend" },
      }),
      "node_modules/@shop/ui/package.json": JSON.stringify({ name: "@shop/ui" }),
      "routes/a.tsx": 'import Stripe from "stripe"\nexport default () => Stripe\n',
      "routes/b.tsx": 'import { readFileSync } from "fs"\nexport default () => readFileSync\n',
      "routes/c.tsx": 'import { db } from "@shop/db"\nexport default () => db\n',
      "routes/d.tsx": 'import jwt from "jsonwebtoken"\nexport default () => jwt\n',
      "routes/e.tsx": 'const pg = require("pg")\nexport default () => pg\n',
      "routes/f.ts": 'import pgx = require("pg")\nexport default () => pgx\n',
      "routes/ok.tsx": [
        'import { EventEmitter } from "events"',
        'import { join } from "path"',
        'import { Button } from "@shop/ui"',
        '// const pg = require("pg")',
        'import type Pg = require("pg")',
        "export default () => [EventEmitter, join, Button]",
        "",
      ].join("\n"),
    }
    for (const [path, content] of Object.entries(files)) writeAppFile(root, path, content)
    const result = await collectCheckResult(root, { lintsOnly: true })
    const found = new Set(
      [...result.diagnostics, ...(result.structuredDiagnostics ?? [])]
        .filter((d) => d.code === "NF-C004")
        .map((d) => `${d.file}:${d.line}`),
    )
    expect([...found].sort()).toEqual([
      "routes/a.tsx:1",
      "routes/b.tsx:1",
      "routes/c.tsx:1",
      "routes/d.tsx:1",
      "routes/e.tsx:1",
      "routes/f.ts:1",
    ])
  })
})
