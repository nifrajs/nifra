import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { migrateTailwindSource, migrateTailwindToStylex } from "../src/stylex-migrate.ts"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories) removeFixtureRoot(directory)
  temporaryDirectories.length = 0
})

test("rewrites static Tailwind className attributes into StyleX props and styles", () => {
  const source = [
    'import React from "react"',
    "",
    'export function Card() { return <div className="flex items-center gap-4 bg-blue-500 p-4 text-white hover:bg-blue-600 md:p-6" /> }',
    "",
  ].join("\n")

  const result = migrateTailwindSource(source, "src/card.tsx")

  expect(result.changed).toBe(true)
  expect(result.replacements).toBe(1)
  expect(result.issues).toEqual([])
  expect(result.source).toContain('import * as nifraStylex from "@stylexjs/stylex"')
  expect(result.source).toContain("const nifraStyles = nifraStylex.create(")
  expect(result.source).toContain("{...nifraStylex.props(")
  expect(result.source).toContain('"@media (min-width: 768px)"')
  expect(result.source).toContain('":hover"')
  expect(result.source).not.toContain('className="')
})

test("keeps a className untouched when any utility needs manual review", () => {
  const source = '<div className="p-4 [&>*]:mt-2 bg-brand-500" />\n'
  const result = migrateTailwindSource(source, "src/card.tsx")

  expect(result.changed).toBe(false)
  expect(result.source).toBe(source)
  expect(result.issues.map((issue) => issue.token)).toEqual(["[&>*]:mt-2", "bg-brand-500"])
})

test("reports dynamic className expressions instead of guessing", () => {
  const source = '<div className={active ? "p-4" : "p-6"} />\n'
  const result = migrateTailwindSource(source, "src/card.tsx")

  expect(result.changed).toBe(false)
  expect(result.source).toBe(source)
  expect(result.issues[0]?.reason).toContain("dynamic className expressions")
})

test("scans safely, writes only with --write semantics, and skips generated directories", async () => {
  const root = createFixtureRoot("stylex-migrate-")
  temporaryDirectories.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true })
  writeFileSync(join(root, "src/card.tsx"), '<div className="p-4" />\n')
  writeFileSync(join(root, "node_modules/pkg/index.tsx"), '<div className="p-6" />\n')

  const dryRun = await migrateTailwindToStylex(root)
  expect(dryRun.scanned).toBe(1)
  expect(dryRun.changed).toEqual(["src/card.tsx"])
  expect(dryRun.written).toEqual([])
  expect(readFileSync(join(root, "src/card.tsx"), "utf8")).toContain('className="p-4"')

  const written = await migrateTailwindToStylex(root, { write: true })
  expect(written.written).toEqual(["src/card.tsx"])
  expect(readFileSync(join(root, "src/card.tsx"), "utf8")).toContain("nifraStylex.props")
})
