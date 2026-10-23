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

test("a className in a template literal, string, comment, regex or JSX text is not an attribute", () => {
  const source = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a fixture file's own template literal, written as source text
    'const html = `<div className="flex">${`<p className="p-4">`}</div>`',
    "const quoted = '<div className=\"flex\">'",
    '// <div className="flex">',
    '/* <div className="flex"> */',
    'const pattern = /<div className="flex">/g',
    "export const Page = () => (",
    "  <>",
    '    <p>Don\'t write className="flex" here</p>',
    '    <section data-x={html.length > 1 ? "a>b" : `c`} className="p-4">',
    '      {quoted && <span className="flex" />}',
    "    </section>",
    "  </>",
    ")",
    "",
  ].join("\n")
  const result = migrateTailwindSource(source, "src/page.tsx")
  expect(result.replacements).toBe(2)
  const lines = result.source.split("\n")
  for (const kept of source.split("\n").slice(0, 5)) expect(lines).toContain(kept)
  expect(lines).toContain('    <p>Don\'t write className="flex" here</p>')
  expect(result.source).toContain('data-x={html.length > 1 ? "a>b" : `c`} {...nifraStylex.props(')
  expect(result.source).toContain("{quoted && <span {...nifraStylex.props(")
})

test("a type parameter list is not an element, and a .ts module holds no JSX", () => {
  const generic = [
    "const first = <T,>(items: T[]) => items[0]",
    "const keep = <T extends object>(value: T) => value",
    "const ratio = (a: number, b: number) => a / b < 1",
    'export const Box = () => <div className="flex" />',
    "",
  ].join("\n")
  const tsx = migrateTailwindSource(generic, "src/box.tsx")
  expect(tsx.replacements).toBe(1)
  expect(tsx.source).toContain("<div {...nifraStylex.props(")
  const plain = 'const x = <Tag>value\nconst y = "<div className=\\"flex\\">"\n'
  expect(migrateTailwindSource(plain, "src/cast.ts").changed).toBe(false)
})

test("the generated block goes after a directive with a comment above it, never before it", () => {
  const source = [
    "// Button - shared UI",
    '"use client"',
    'import { useState } from "react"',
    "",
    "export function Button() {",
    "  const [n] = useState(0)",
    '  return <button className="p-4">{n}</button>',
    "}",
    "",
  ].join("\n")
  const result = migrateTailwindSource(source, "frontend/Button.tsx")
  expect(result.changed).toBe(true)
  expect(
    result.source.startsWith(
      '// Button - shared UI\n"use client"\nimport { useState } from "react"\n\nimport * as nifraStylex from "@stylexjs/stylex"\n',
    ),
  ).toBe(true)
})

test("a trailing comment on the last import does not push the generated block past the code", () => {
  const source = [
    'import { h } from "preact" // jsx factory',
    "import {",
    "  a, // first",
    '} from "./a" with { type: "json" } /* why */',
    'export const badge = <span className="p-4">new</span>',
    "",
  ].join("\n")
  const result = migrateTailwindSource(source, "frontend/Card.tsx")
  expect(result.changed).toBe(true)
  expect(
    result.source.startsWith(
      'import { h } from "preact" // jsx factory\nimport {\n  a, // first\n} from "./a" with { type: "json" } /* why */\nimport * as nifraStylex from "@stylexjs/stylex"\n\nconst nifraStyles = nifraStylex.create(',
    ),
  ).toBe(true)
  expect(result.source.indexOf("const nifraStyles")).toBeLessThan(
    result.source.indexOf("export const badge"),
  )
})
