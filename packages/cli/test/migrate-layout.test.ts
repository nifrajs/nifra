import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createZoneClassifier } from "@nifrajs/web/zones"
import * as ts from "typescript"
import { middlewareSource, migrateLayout, splitRouteSource } from "../src/migrate-layout.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const ROOT = createFixtureRoot("tmp-migrate-layout-")
afterAll(() => removeFixtureRoot(ROOT))

const split = (source: string, file = "routes/index.tsx") =>
  splitRouteSource(ts, source, file, "./index.backend.ts", { sharedFile: "index.shared.ts" })

function app(files: Record<string, string>): string {
  const dir = createFixtureProject(ROOT, "app-")
  for (const [path, content] of Object.entries(files)) writeAppFile(dir, path, content)
  return dir
}
const read = (dir: string, path: string): string => readFileSync(join(dir, path), "utf8")

describe("splitRouteSource", () => {
  test("server exports and the code only they use move; the page keeps an import type", () => {
    const result = split(
      [
        'import type { LoaderData } from "@nifrajs/client"',
        'import { db } from "../db.ts"',
        'import { Card } from "../components/card.tsx"',
        "",
        "const query = () => db.all()",
        "",
        "export async function loader() {",
        "  return { rows: query() }",
        "}",
        "",
        "export const meta = { title: 'Home' }",
        "",
        "export default function Page({ data }: { data: LoaderData<typeof loader> }) {",
        "  return <Card rows={data.rows} />",
        "}",
        "",
      ].join("\n"),
    )
    expect(result.moved).toEqual(["loader"])
    expect(result.issues).toEqual([])
    expect(result.backend).toContain('import { db } from "../db.ts"')
    expect(result.backend).toContain("const query = () => db.all()")
    expect(result.backend).toContain("export async function loader()")
    expect(result.backend).not.toContain("Card")
    expect(result.frontend).toContain(
      'import { Card } from "../components/card.tsx"\nimport type { loader } from "./index.backend.ts"\n',
    )
    expect(result.frontend).not.toContain("db")
    expect(result.frontend).toContain("export const meta")
    expect(result.frontend).toContain("<Card rows={data.rows} />")
  })

  test("a file with no server export is left exactly as written", () => {
    const source = "export default function Page() {\n  return null\n}\n"
    expect(split(source)).toEqual({ frontend: source, backend: undefined, moved: [], issues: [] })
  })

  test("code both halves use is copied into each and reported", () => {
    const result = split(
      [
        "const format = (n: number) => n.toFixed(2)",
        "export async function loader() { return { price: format(1) } }",
        "export default function Page() { return format(2) }",
        "",
      ].join("\n"),
    )
    expect(result.backend).toContain("const format")
    expect(result.frontend).toContain("const format")
    expect(result.issues).toEqual([
      '"format" is needed by both halves and was copied into each, since it is not constant data; consider moving it to shared/',
    ])
  })

  test("constant data both halves read moves beside the route once, with the types it needs", () => {
    const result = split(
      [
        'import type { Profile } from "../types"',
        'import { Card } from "../components/card"',
        "",
        "interface Entry { readonly profile: Profile }",
        "const BASE = { tier: 'free' } as const",
        "/** Every entry, by slug. */",
        "const ENTRIES: Record<string, Entry> = {",
        "  a: { profile: { ...BASE, name: 'A' } },",
        "  b: { profile: { ...BASE, name: `B${1 + 1}` } },",
        "}",
        "export const SLUGS = Object.keys(ENTRIES)",
        "",
        "export async function getStaticPaths() {",
        "  return { paths: SLUGS.map((slug) => ({ params: { slug } })), fallback: false }",
        "}",
        "export async function loader({ params }: { params: { slug: string } }) {",
        "  return ENTRIES[params.slug] ?? null",
        "}",
        "export default function Page() { return <Card count={SLUGS.length} /> }",
        "",
      ].join("\n"),
    )
    expect(result.issues).toEqual([])
    expect(result.shared).toBe(
      [
        'import type { Profile } from "../types"',
        "",
        "export interface Entry { readonly profile: Profile }",
        "export const BASE = { tier: 'free' } as const",
        "/** Every entry, by slug. */",
        "export const ENTRIES: Record<string, Entry> = {",
        "  a: { profile: { ...BASE, name: 'A' } },",
        "  b: { profile: { ...BASE, name: `B${1 + 1}` } },",
        "}",
        "export const SLUGS = Object.keys(ENTRIES)",
        "",
      ].join("\n"),
    )
    expect(result.backend).toContain('import { ENTRIES, SLUGS } from "./index.shared"')
    expect(result.backend).not.toContain("const ENTRIES")
    expect(result.backend).not.toContain("BASE")
    expect(result.frontend).toContain('import { SLUGS } from "./index.shared"')
    expect(result.frontend).toContain('export { SLUGS } from "./index.shared"')
    expect(result.frontend).not.toContain("Object.keys")
    expect(result.frontend).not.toContain("const ENTRIES")
  })

  test("data that changes, runs code or reads an import is copied, with the reason", () => {
    const result = split(
      [
        'import { rates } from "../lib/rates"',
        "let counter = 0",
        "const PRICES = { base: rates.base }",
        "const STAMP = Date.now()",
        "const STAMPS = [STAMP]",
        "export async function loader() { return { counter, PRICES, STAMPS } }",
        "export default function Page() { return [counter, PRICES, STAMPS] }",
        "",
      ].join("\n"),
    )
    expect(result.shared).toBeUndefined()
    const copied = (names: string, why: string): string =>
      `"${names}" is needed by both halves and was copied into each, since ${why}; consider moving it to shared/`
    expect([...result.issues].sort()).toEqual(
      [
        copied("counter", "it is not constant data"),
        copied("PRICES", 'it reads the import "rates"'),
        copied("STAMP", "it is not constant data"),
        copied("STAMPS", 'it reads "STAMP", which is not constant data'),
      ].sort(),
    )
    expect(result.backend).toContain('import { rates } from "../lib/rates"')
    expect(result.frontend).toContain('import { rates } from "../lib/rates"')
  })

  test("the imports a split writes quote the way the file does", () => {
    const result = split(
      [
        "import { db } from '../db'",
        "const SLUGS = ['a']",
        "export const loader = () => db(SLUGS)",
        "export default function Page({ data }: { data: Awaited<ReturnType<typeof loader>> }) {",
        "  return [SLUGS, data]",
        "}",
        "",
      ].join("\n"),
    )
    expect(result.frontend).toContain("import { SLUGS } from './index.shared'")
    expect(result.frontend).toContain("import type { loader } from './index.backend.ts'")
    expect(result.backend).toContain("import { SLUGS } from './index.shared'")
  })

  test("without a free name beside the route, shared data is copied as before", () => {
    const source = [
      "const SLUGS = ['a', 'b']",
      "export async function getStaticPaths() { return { paths: SLUGS, fallback: false } }",
      "export default function Page() { return SLUGS.length }",
      "",
    ].join("\n")
    const result = splitRouteSource(ts, source, "routes/index.tsx", "./index.backend.ts")
    expect(result.shared).toBeUndefined()
    expect(result.issues).toEqual([
      '"SLUGS" is needed by both halves and was copied into each; consider moving it to shared/',
    ])
  })

  test("a name the page exports by list keeps its import, in whichever half exports it", () => {
    const result = split(
      [
        'import { SLUGS, LABELS } from "../data/slugs"',
        'import type { Slug } from "../data/slugs"',
        "export { SLUGS }",
        "export { LABELS as NAMES }",
        "export type { Slug }",
        "export async function getStaticPaths() {",
        "  return { paths: SLUGS.map((slug) => ({ params: { slug } })), fallback: false }",
        "}",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
    )
    expect(result.issues).toEqual([])
    expect(result.frontend).toContain('import { SLUGS, LABELS } from "../data/slugs"')
    expect(result.frontend).toContain('import type { Slug } from "../data/slugs"')
    expect(result.frontend).toContain(
      "export { SLUGS }\nexport { LABELS as NAMES }\nexport type { Slug }",
    )
    expect(result.backend).toContain('import { SLUGS } from "../data/slugs"')
    expect(result.backend).not.toContain("LABELS")

    const mixed = split(
      [
        'import { SLUGS } from "../data/slugs"',
        'import { db } from "../db"',
        "async function loader() { return db }",
        "export { loader, SLUGS }",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
    )
    expect(mixed.frontend).toContain('import { SLUGS } from "../data/slugs"')
    expect(mixed.frontend).toContain("export { SLUGS }")
    expect(mixed.frontend).not.toContain("db")
    expect(mixed.backend).toContain("export { loader }")
    expect(mixed.backend).not.toContain("SLUGS")
  })

  test("a half that reads an import only in types imports it as a type", () => {
    const result = split(
      [
        'import { Card, type CardProps } from "../components/card"',
        'import Chart from "../components/chart"',
        'import { format, type Row } from "../lib/rows"',
        "export async function loader(): Promise<CardProps & { chart?: typeof Chart }> {",
        "  return { title: format([]) }",
        "}",
        "export default function Page({ rows }: { rows: Row[] } & Partial<CardProps>) {",
        "  return <Card rows={rows} />",
        "}",
        "",
      ].join("\n"),
    )
    expect(result.backend).toContain('import type { CardProps } from "../components/card"')
    expect(result.backend).toContain('import type Chart from "../components/chart"')
    expect(result.backend).toContain('import { format } from "../lib/rows"')
    // The page's own import stays as written; one the split narrowed to types becomes a type import.
    expect(result.frontend).toContain('import { Card, type CardProps } from "../components/card"')
    expect(result.frontend).toContain('import type { Row } from "../lib/rows"')
    expect(result.frontend).not.toContain("Chart")
  })

  test("a page that reads a moved name at runtime is reported, not guessed", () => {
    const result = split(
      [
        "export const revalidate = 10",
        "export default function Page() { return revalidate }",
        "",
      ].join("\n"),
    )
    expect(result.moved).toEqual(["revalidate"])
    expect(result.issues).toEqual([
      'the frontend uses "revalidate" at runtime, but it runs on the server only',
    ])
  })

  test("an export list is divided between the halves", () => {
    const result = split(
      [
        "async function loader() { return 1 }",
        "const meta = { title: 'x' }",
        "export { loader, meta }",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
    )
    expect(result.backend).toContain("export { loader }")
    expect(result.frontend).toContain("export { meta }")
    expect(result.frontend).not.toContain("async function loader")
  })

  test("a JSX pragma stays first in the page and never reaches the backend half", () => {
    const result = split(
      [
        "/** @jsxImportSource preact */",
        'import type { LoaderArgs } from "@nifrajs/client"',
        "export async function loader(_: LoaderArgs) { return 1 }",
        "export default function Page() { return <p /> }",
        "",
      ].join("\n"),
    )
    expect(result.frontend.split("\n")[0]).toBe("/** @jsxImportSource preact */")
    expect(result.backend).not.toContain("@jsx")
    expect(result.backend?.startsWith('import type { LoaderArgs } from "@nifrajs/client"')).toBe(
      true,
    )
  })

  test("the page keeps the import its classic JSX compiles to", () => {
    const pragma = split(
      [
        "/** @jsx h */",
        "/** @jsxFrag Fragment */",
        'import { Fragment, h } from "preact"',
        'import { t } from "@nifrajs/schema"',
        "export const loaderOutput = t.object({ title: t.string() })",
        'export const loader = async () => ({ title: "x" })',
        "export default function Page() { return <><main /></> }",
        "",
      ].join("\n"),
    )
    expect(pragma.frontend).toContain('import { Fragment, h } from "preact"')
    expect(pragma.frontend).not.toContain("@nifrajs/schema")
    expect(pragma.backend).not.toContain("preact")

    const defaultFactory = split(
      [
        'import React from "react"',
        "export const loader = async () => 1",
        "export default function Page() { return <main /> }",
        "",
      ].join("\n"),
    )
    expect(defaultFactory.frontend).toContain('import React from "react"')
    expect(defaultFactory.backend).not.toContain("react")
  })
})

describe("middlewareSource", () => {
  test("a default-exported expression becomes the `middleware` export", () => {
    expect(middlewareSource(ts, "export default (ctx) => ctx.next()\n", "_middleware.ts")).toBe(
      "export const middleware = (ctx) => ctx.next()\n",
    )
  })

  test("a named default function keeps its name and is re-exported", () => {
    const out = middlewareSource(
      ts,
      "export default async function guard(ctx) {\n  return ctx.next()\n}\n",
      "_middleware.ts",
    )
    expect(out).toContain("async function guard(ctx)")
    expect(out).toContain("export { guard as middleware }")
    expect(out).not.toContain("export default")
  })
})

describe("migrateLayout", () => {
  const files = {
    "backend.ts":
      'import { server } from "@nifrajs/core"\nimport { db } from "./lib/db.ts"\nexport const backend = server().get("/x", () => db)\n',
    "framework.ts": 'export { reactAdapter as adapter } from "@nifrajs/web-react"\n',
    "nifra.config.ts":
      'export { adapter } from "./framework"\nexport const clientModule = "@nifrajs/web-react/client"\n',
    "lib/db.ts": "export const db = 1\n",
    "lib/format.ts": "export const format = (n: number) => String(n)\n",
    "components/card.tsx":
      'import { format } from "../lib/format.ts"\nexport const Card = () => format(1)\n',
    "build.ts":
      'const out = import.meta.dir + "/lib/db.ts"\nconst seed = "lib/db.ts"\nconsole.log(out, seed)\n',
    "routes/index.tsx": [
      'import { Card } from "../components/card.tsx"',
      'import { format } from "../lib/format.ts"',
      'import { catalog } from "../../outside/catalog.ts"',
      "export async function loader() { return { n: format(catalog) } }",
      "export default function Page() { return <Card /> }",
      "",
    ].join("\n"),
    "routes/admin/_middleware.ts": "export default (ctx) => ctx.next()\n",
  }

  test("a dry run plans every move and writes nothing", async () => {
    const dir = app(files)
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.write).toBe(false)
    expect(result.moves).toEqual([
      { from: "backend.ts", to: "backend/app.ts" },
      { from: "components/card.tsx", to: "frontend/components/card.tsx" },
      { from: "framework.ts", to: "backend/framework.ts" },
      { from: "lib/db.ts", to: "backend/lib/db.ts" },
      { from: "lib/format.ts", to: "shared/lib/format.ts" },
    ])
    expect(result.splits.map((s) => s.file).sort()).toEqual([
      "routes/admin/_middleware.ts",
      "routes/index.tsx",
    ])
    expect(existsSync(join(dir, "backend.ts"))).toBe(true)
    expect(existsSync(join(dir, "routes/index.backend.ts"))).toBe(false)
  })

  test("a root backend keeps the /api mount it had before 5.0; a stated apiPrefix is kept", async () => {
    const dir = app(files)
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.tooling).toContainEqual({
      file: "backend/framework.ts",
      change: 'export const apiPrefix = "/api", the mount 4.x made by default',
    })
    expect(read(dir, "backend/framework.ts")).toContain('export const apiPrefix = "/api"\n')
    expect(read(dir, "nifra.config.ts")).not.toContain("apiPrefix")

    const stated = app({
      ...files,
      "framework.ts": `${files["framework.ts"]}export const apiPrefix = ""\n`,
    })
    const kept = await migrateLayout(stated, { typescript: ts, write: true })
    expect(kept.tooling.filter((edit) => edit.change.includes("apiPrefix"))).toEqual([])
    expect(read(stated, "backend/framework.ts")).toContain('export const apiPrefix = ""\n')
  })

  test("a folder whose reached files go to one zone moves whole; a mixed one stays and is reported", async () => {
    const dir = app({
      "nifra.config.ts":
        'export const adapter = {}\nexport const clientModule = "@nifrajs/web-react/client"\n',
      "routes/index.tsx": [
        'import { Button } from "../src/ui/button.tsx"',
        'import { a } from "../src/mixed/a.ts"',
        'import { b } from "../src/mixed/b.ts"',
        "export async function loader() { return { b } }",
        "export default () => Button(a)",
        "",
      ].join("\n"),
      "src/ui/button.tsx": "export const Button = (n: number) => n\n",
      "src/ui/card.tsx": "export const Card = () => null\n",
      "src/ui/icons/star.svg": "<svg/>\n",
      "src/ui/disk.ts":
        'import { readFileSync } from "node:fs"\nexport const disk = readFileSync\n',
      "src/ui/vendor/package.json": '{ "name": "vendor" }\n',
      "src/ui/vendor/index.ts": "export const vendor = 1\n",
      "src/mixed/a.ts": "export const a = 1\n",
      "src/mixed/b.ts": "export const b = 2\n",
      "src/mixed/c.ts": "export const c = 3\n",
    })
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.moves.map((move) => `${move.from} -> ${move.to}`)).toEqual([
      "src/mixed/a.ts -> frontend/src/mixed/a.ts",
      "src/mixed/b.ts -> backend/src/mixed/b.ts",
      "src/ui/button.tsx -> frontend/src/ui/button.tsx",
      "src/ui/card.tsx -> frontend/src/ui/card.tsx",
      "src/ui/icons/star.svg -> frontend/src/ui/icons/star.svg",
    ])
    // A server built-in never moves toward the browser, so it still splits src/ui/.
    expect(result.issues.map((issue) => issue.file)).toEqual([
      "src/mixed/a.ts",
      "src/ui/button.tsx",
    ])
    expect(result.issues[1]?.reason).toContain('"src/ui/disk.ts" stays in src/ui/')
  })

  test("--zones lists the folders modules would leave in package.json, and moves none of them", async () => {
    const dir = app({
      "package.json": `${JSON.stringify({ name: "app", nifra: { zones: { backend: ["jobs"] } } }, null, 2)}\n`,
      "nifra.config.ts":
        'export const adapter = {}\nexport const clientModule = "@nifrajs/web-react/client"\n',
      "routes/index.tsx": [
        'import { Button } from "../lib/ui/button.tsx"',
        'import { format } from "../lib/format.ts"',
        'import { query } from "../lib/db/query.ts"',
        'import { tick } from "../tools.ts"',
        "export async function loader() { return { rows: query(format(tick())) } }",
        "export default () => Button(format(1))",
        "",
      ].join("\n"),
      "lib/ui/button.tsx":
        'import labels from "./labels.json"\nexport const Button = (s: string) => `${labels.ok} ${s}`\n',
      "lib/ui/labels.json": '{ "ok": "Fine" }\n',
      "lib/ui/card.tsx": "export const Card = () => null\n",
      "lib/db/query.ts": "export const query = (s: string) => [s]\n",
      "lib/format.ts": "export const format = (n: number) => String(n)\n",
      "lib/format.test.ts": 'import { format } from "./format.ts"\nformat(1)\n',
      "tools.ts": "export const tick = () => 1\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, zones: true, write: true })
    expect(result.moves).toEqual([])
    expect(result.issues).toEqual([])
    expect(result.splits.map((split) => split.backend)).toEqual(["routes/index.backend.ts"])
    expect(result.tooling.filter((edit) => edit.file === "package.json")).toEqual([
      { file: "package.json", change: '"nifra.zones" lists "lib/db" as backend' },
      { file: "package.json", change: '"nifra.zones" lists "lib/format.ts" as shared' },
      { file: "package.json", change: '"nifra.zones" lists "lib/ui" as frontend' },
      { file: "package.json", change: '"nifra.zones" lists "tools.ts" as backend' },
    ])
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).nifra.zones).toEqual({
      backend: ["jobs", "lib/db", "tools.ts"],
      frontend: ["lib/ui"],
      shared: ["lib/format.ts"],
    })
    // The files stay, and every tool that zones a file now agrees with the plan.
    const zones = createZoneClassifier({ appRoot: dir })
    for (const [file, zone] of [
      ["lib/ui/card.tsx", "frontend"],
      ["lib/ui/labels.json", "frontend"],
      ["lib/db/query.ts", "backend"],
      ["lib/format.ts", "shared"],
      ["tools.ts", "backend"],
    ] as const) {
      expect(existsSync(join(dir, file))).toBe(true)
      expect(zones.classify(join(dir, file)).zone).toBe(zone)
    }
    expect(readFileSync(join(dir, "routes/index.backend.ts"), "utf8")).toContain(
      '"../lib/db/query.ts"',
    )

    const again = await migrateLayout(dir, { typescript: ts, zones: true })
    expect(again.moves).toEqual([])
    expect(again.tooling.filter((edit) => edit.file === "package.json")).toEqual([])
  })

  test("--zones lists a file on its own where its folder holds another side", async () => {
    const dir = app({
      "package.json": '{ "name": "app" }\n',
      "nifra.config.ts":
        'export const adapter = {}\nexport const clientModule = "@nifrajs/web-react/client"\n',
      "routes/index.tsx": 'import { a } from "../src/a.ts"\nexport default () => a\n',
      "src/a.ts": "export const a = 1\n",
      "src/disk.ts": 'import { readFileSync } from "node:fs"\nexport const disk = readFileSync\n',
      "src/pkg/package.json": '{ "name": "pkg" }\n',
      "src/pkg/ui/b.ts": "export const b = 2\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, zones: true })
    expect(result.tooling.filter((edit) => edit.file === "package.json")).toEqual([
      { file: "package.json", change: '"nifra.zones" lists "src/a.ts" as frontend' },
    ])
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe('{ "name": "app" }\n')
  })

  test("a backend half the run did not write is a follow-up, not an issue", async () => {
    const dir = app({
      ...files,
      "routes/index.tsx": "export default () => null\n",
      "routes/index.backend.ts": "export async function loader() { return { n: 1 } }\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.followUps).toEqual([
      {
        file: "routes/index.backend.ts",
        reason:
          "exports a loader but no loaderOutput, so data it returns fails the request; draft it from the loader's return type",
        command: "nifra schemas --write",
      },
    ])
    expect(result.issues.filter((issue) => issue.file.startsWith("routes/"))).toEqual([])
  })

  test("--write applies it: halves, zones, rewritten imports, folded middleware", async () => {
    const dir = app(files)
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(existsSync(join(dir, "backend.ts"))).toBe(false)
    expect(existsSync(join(dir, "framework.ts"))).toBe(false)
    expect(existsSync(join(dir, "routes/admin/_middleware.ts"))).toBe(false)
    expect(read(dir, "backend/app.ts")).toContain('from "./lib/db.ts"')
    expect(read(dir, "nifra.config.ts")).toContain('from "./backend/framework"')
    expect(read(dir, "frontend/components/card.tsx")).toContain('from "../../shared/lib/format.ts"')
    expect(read(dir, "routes/index.tsx")).toContain('from "../frontend/components/card.tsx"')
    const backendHalf = read(dir, "routes/index.backend.ts")
    expect(backendHalf).toContain('from "../shared/lib/format.ts"')
    // outside the app the target stays put; the import is re-based only if its importer moved
    expect(backendHalf).toContain('from "../../outside/catalog.ts"')
    expect(read(dir, "routes/admin/_layout.backend.ts")).toContain(
      "export const middleware = (ctx) => ctx.next()",
    )
    // a path built from the module's own folder follows its target; a bare string is reported
    expect(read(dir, "build.ts")).toContain('import.meta.dir + "/backend/lib/db.ts"')
    expect(read(dir, "build.ts")).toContain('const seed = "lib/db.ts"')
    expect(result.rewritten).toContain("build.ts")
    expect(result.issues).toContainEqual({
      file: "build.ts",
      reason: 'mentions "lib/db.ts" by path; it moved to "backend/lib/db.ts"',
    })
  })

  test("aliases and the config's module paths are followed, rewritten, or reported", async () => {
    const dir = app({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "~/*": ["./*"], "@app/*": ["./src/*"] } },
      }),
      "package.json": JSON.stringify({ name: "alias-app", imports: { "#db/*": "./db/*.ts" } }),
      "nifra.config.ts": [
        'export const clientModule = "./client.tsx"',
        "export const componentPipeline = {",
        '  adapter: "react",',
        '  entries: { client: "./entry-client.tsx", ssr: "./entry-server.tsx" },',
        "} as const",
        "",
      ].join("\n"),
      "client.tsx":
        'import { theme } from "~/lib/theme"\nexport function mountRouter() {\n  return theme\n}\n',
      "entry-client.tsx": "export const hydrate = 1\n",
      "entry-server.tsx": "export const render = 1\n",
      "lib/theme.ts": 'export const theme = "dark"\n',
      "lib/fmt.ts": "export const fmt = (n: number) => String(n)\n",
      "src/money.ts": "export const money = 1\n",
      "db/pool.ts": "export const pool = 1\n",
      "routes/index.tsx": [
        'import { fmt } from "~/lib/fmt"',
        'import { money } from "@app/money"',
        'import { pool } from "#db/pool"',
        'import ts from "typescript"',
        'import { nothing } from "not-a-real-package-xyz"',
        "export async function loader() { return { n: pool } }",
        "export default function Page() { return fmt(money) + String(ts) + nothing }",
        "",
      ].join("\n"),
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves).toEqual([
      { from: "client.tsx", to: "frontend/client.tsx" },
      { from: "db/pool.ts", to: "backend/db/pool.ts" },
      { from: "entry-client.tsx", to: "frontend/entry-client.tsx" },
      { from: "entry-server.tsx", to: "backend/entry-server.tsx" },
      { from: "lib/fmt.ts", to: "frontend/lib/fmt.ts" },
      { from: "lib/theme.ts", to: "frontend/lib/theme.ts" },
      { from: "src/money.ts", to: "frontend/src/money.ts" },
    ])
    expect(read(dir, "routes/index.tsx")).toContain('from "~/frontend/lib/fmt"')
    expect(read(dir, "frontend/client.tsx")).toContain('from "~/frontend/lib/theme"')
    const config = read(dir, "nifra.config.ts")
    expect(config).toContain('export const clientModule = "./frontend/client.tsx"')
    expect(config).toContain(
      'entries: { client: "./frontend/entry-client.tsx", ssr: "./backend/entry-server.tsx" }',
    )
    expect(result.rewritten).toContain("nifra.config.ts")
    // No target of `@app/*` or `#db/*` covers the new place: a relative path names it.
    expect(read(dir, "routes/index.tsx")).toContain('from "../frontend/src/money"')
    expect(read(dir, "routes/index.backend.ts")).toContain('from "../backend/db/pool"')
    const reasons = result.issues.map((issue) => `${issue.file}: ${issue.reason}`)
    expect(reasons).toContain(
      'routes/index.tsx: "not-a-real-package-xyz" names no installed package and no file through the app\'s tsconfig paths or package.json imports, so the migration cannot tell where it belongs; check it by hand',
    )
    // An installed package and every alias the migration rewrote are not issues.
    expect(
      reasons.filter((reason) => /typescript|alias|reaches|clientModule/.test(reason)),
    ).toEqual([])
  })

  test("an alias no target covers after the move becomes a relative path that reaches it", async () => {
    const files = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"], "@home": ["./routes/index.tsx"] } },
      }),
      "src/lib/fetcher.ts": 'export const fetcher = "api"\n',
      "src/lib/icons/index.ts": 'export const icon = "*"\n',
      "src/lib/logo.svg": "<svg/>\n",
      "src/data/x.ts": 'import { fetcher } from "@/lib/fetcher"\nexport const x = fetcher\n',
      "src/lib/stays.ts": 'export const stays = "unreached"\n',
      "src/pages/Home.tsx": [
        'import { fetcher } from "@/lib/fetcher"',
        'import { icon } from "@/lib/icons"',
        'import logo from "@/lib/logo.svg?url"',
        'import type { stays } from "@/lib/stays"',
        "export default () => fetcher + icon + logo",
        "export type S = typeof stays",
        "",
      ].join("\n"),
      "src/pages/Home.test.tsx": [
        'import { vi } from "vitest"',
        'vi.mock("@/lib/fetcher", () => ({ fetcher: "mock" }))',
        'import Home from "@/pages/Home"',
        "export const rendered = Home()",
        "",
      ].join("\n"),
      "src/home.test.ts": 'import { loader } from "@home"\nexport const data = loader()\n',
      "routes/index.tsx": [
        'import Home from "@/pages/Home"',
        'import { x } from "@/data/x"',
        "export async function loader() { return { x } }",
        "export default Home",
        "",
      ].join("\n"),
    }
    const dir = app(files)
    const dry = await migrateLayout(dir, { typescript: ts })
    expect(read(dir, "src/pages/Home.tsx")).toBe(files["src/pages/Home.tsx"])
    expect(dry.moves.map((move) => `${move.from} -> ${move.to}`)).toEqual([
      "src/data/x.ts -> backend/src/data/x.ts",
      "src/lib/fetcher.ts -> shared/src/lib/fetcher.ts",
      "src/lib/icons/index.ts -> frontend/src/lib/icons/index.ts",
      "src/lib/logo.svg -> frontend/src/lib/logo.svg",
      "src/pages/Home.test.tsx -> frontend/src/pages/Home.test.tsx",
      "src/pages/Home.tsx -> frontend/src/pages/Home.tsx",
    ])
    expect(dry.issues.filter((issue) => /alias|reaches/.test(issue.reason))).toEqual([])

    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.issues).toEqual(dry.issues)
    const home = read(dir, "frontend/src/pages/Home.tsx")
    expect(home).toContain('from "../../../shared/src/lib/fetcher"')
    expect(home).toContain('from "../lib/icons"')
    expect(home).toContain('from "../lib/logo.svg?url"')
    // Its target stays in src/, where the alias still reaches it from the new place.
    expect(home).toContain('from "@/lib/stays"')
    expect(read(dir, "backend/src/data/x.ts")).toContain('from "../../../shared/src/lib/fetcher"')
    expect(read(dir, "routes/index.tsx")).toContain('from "../frontend/src/pages/Home"')
    expect(read(dir, "routes/index.backend.ts")).toContain('from "../backend/src/data/x"')
    // The test followed its subject; its mock and import name the new places.
    const test = read(dir, "frontend/src/pages/Home.test.tsx")
    expect(test).toContain('vi.mock("../../../shared/src/lib/fetcher"')
    expect(test).toContain('from "./Home"')
    // An alias that cannot name the route's backend half reaches its loader by a relative path.
    expect(read(dir, "src/home.test.ts")).toContain(
      'import { loader } from "../routes/index.backend"',
    )
    // Nothing is left to move or rewrite.
    const again = await migrateLayout(dir, { typescript: ts })
    expect(again.moves).toEqual([])
    expect(again.rewritten).toEqual([])
  })

  test("a page the server imports is rendered there, so what only pages use still goes to frontend/", async () => {
    const dir = app({
      "routes/index.tsx":
        'import { Card } from "../components/card.tsx"\nexport default () => <Card />\n',
      "components/card.tsx": "export const Card = () => null\n",
      "server-manifest.ts":
        '// GENERATED by @nifrajs/web generateServerManifest\nimport * as m0 from "./routes/index"\nexport const modules = { "index.tsx": m0 }\n',
    })
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.moves).toEqual([
      { from: "components/card.tsx", to: "frontend/components/card.tsx" },
    ])
  })

  test("paths found at run time: a split folder, scripts and config are reported", async () => {
    const dir = app({
      "backend.ts": [
        'import { migrate } from "./db/migrate.ts"',
        'import release from "./release.json"',
        "export const version = release.version",
        "await migrate()",
        "",
      ].join("\n"),
      "db/migrate.ts": [
        'import { readdirSync } from "node:fs"',
        'import { up } from "../migrations/0002_backfill.ts"',
        'export const migrate = () => [readdirSync(import.meta.dir + "/../migrations"), up()]',
        "",
      ].join("\n"),
      "migrations/0001_init.sql": "create table t (id int);\n",
      "migrations/0002_backfill.ts": "export const up = () => 1\n",
      "release.json": '{ "version": "1.0.0" }\n',
      "scripts/release.sh": "#!/bin/sh\nbun db/migrate.ts\n",
      "package.json": '{ "scripts": { "version": "jq .version release.json" } }\n',
      "routes/index.tsx": "export default () => null\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(read(dir, "backend/db/migrate.ts")).toContain('import.meta.dir + "/../../migrations"')
    expect(result.moves.map((m) => m.to)).toEqual([
      "backend/app.ts",
      "backend/db/migrate.ts",
      "backend/migrations/0002_backfill.ts",
    ])
    // Data stays where other tools read it; backend/app.ts now reaches it as `../release.json`.
    expect(read(dir, "backend/app.ts")).toContain('import release from "../release.json"')
    expect(result.issues).toEqual([
      {
        file: "release.json",
        reason:
          'is data backend code imports, and a build only loads files in a zone; it stays here because other tools may read it by path. Move it to "backend/release.json" by hand, or into a folder listed under "nifra": { "zones": { "backend": [...] } } in package.json',
      },
      {
        file: "scripts/release.sh",
        reason: 'mentions "db/migrate.ts" by path; it moved to "backend/db/migrate.ts"',
      },
      {
        file: "migrations/0002_backfill.ts",
        reason:
          'moves to "backend/migrations/0002_backfill.ts" but "migrations/0001_init.sql" stays in migrations/; code or tooling that lists migrations/ no longer finds what moved - move the folder together by hand',
      },
    ])
  })

  test("a moved module's paths from its own location are re-pointed; one it cannot follow is reported", async () => {
    const dir = app({
      "backend.ts": 'import { posts } from "./lib/content.ts"\nexport const all = posts\n',
      "lib/content.ts": [
        'import { join, resolve } from "node:path"',
        'import { fileURLToPath } from "node:url"',
        'import { util } from "./util.ts"',
        "export const posts = [",
        '  join(import.meta.dir, "..", "content", "posts"),',
        '  resolve(__dirname, "../content/"),',
        "  `${import.meta.dirname}/data.json`,",
        '  new URL("./util.ts", import.meta.url),',
        "  fileURLToPath(import.meta.url),",
        "  util,",
        "]",
        "",
      ].join("\n"),
      "lib/util.ts": "export const util = 1\n",
      "lib/data.json": "{}\n",
      "routes/index.tsx": "export default () => null\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(read(dir, "backend/lib/content.ts")).toBe(
      [
        'import { join, resolve } from "node:path"',
        'import { fileURLToPath } from "node:url"',
        'import { util } from "./util.ts"',
        "export const posts = [",
        '  join(import.meta.dir, "..", "..", "content", "posts"),',
        '  resolve(__dirname, "../../content/"),',
        "  `${import.meta.dirname}/../../lib/data.json`,",
        '  new URL("./util.ts", import.meta.url),',
        "  fileURLToPath(import.meta.url),",
        "  util,",
        "]",
        "",
      ].join("\n"),
    )
    expect(result.issues).toEqual([
      {
        file: "backend/lib/content.ts",
        reason:
          'builds a path from its own location (import.meta.url) that the migration could not re-point, and it moved from "lib/content.ts"; check that path by hand',
      },
      {
        file: "lib/content.ts",
        reason:
          'moves to "backend/lib/content.ts" with 1 other file(s) but "lib/data.json" stays in lib/; code or tooling that lists lib/ no longer finds what moved - move the folder together by hand',
      },
    ])
  })

  test("a moved module's import that leaves the app is re-based", async () => {
    const dir = app({
      "routes/index.tsx": 'import { Card } from "../ui/card.tsx"\nexport default () => <Card />\n',
      "ui/card.tsx":
        'import { tokens } from "../../outside/tokens.ts"\nexport const Card = () => tokens\n',
    })
    await migrateLayout(dir, { typescript: ts, write: true })
    expect(read(dir, "frontend/ui/card.tsx")).toContain('from "../../../outside/tokens.ts"')
  })

  test("SFC routes split their module script", async () => {
    const dir = app({
      "routes/index.svelte": [
        "<script module>",
        "  export async function loader() { return { n: 1 } }",
        "  export const meta = { title: 'x' }",
        "</script>",
        "",
        "<script>",
        "  let { data } = $props()",
        "</script>",
        "<p>{data.n}</p>",
        "",
      ].join("\n"),
      "routes/about.vue": [
        '<script lang="ts">',
        "export async function loader() { return { n: 2 } }",
        "</script>",
        '<script setup lang="ts">',
        "defineProps(['data'])",
        "</script>",
        "<template><p>{{ data.n }}</p></template>",
        "",
      ].join("\n"),
    })
    await migrateLayout(dir, { typescript: ts, write: true })
    const svelte = read(dir, "routes/index.svelte")
    expect(svelte).toContain("export const meta")
    expect(svelte).toContain("let { data } = $props()")
    expect(svelte).not.toContain("async function loader")
    expect(read(dir, "routes/index.backend.ts")).toContain("export async function loader()")
    expect(read(dir, "routes/about.vue")).not.toContain("async function loader")
    expect(read(dir, "routes/about.backend.ts")).toContain("return { n: 2 }")
  })

  test("an SFC script block ends at its closing tag however that tag is spaced", async () => {
    const dir = app({
      "routes/index.svelte": [
        "<script module>",
        "  export async function loader() { return { n: 1 } }",
        "</script >",
        "<p>hi</p>",
        "",
      ].join("\n"),
    })
    await migrateLayout(dir, { typescript: ts, write: true })
    expect(read(dir, "routes/index.svelte")).not.toContain("async function loader")
    expect(read(dir, "routes/index.backend.ts")).toContain("export async function loader()")
  })

  test("retired names: .server modules move under backend/, the marker and type are renamed", async () => {
    const dir = app({
      "routes/index.tsx": [
        'import { rows } from "../lib/db.server.ts"',
        'import { audit } from "./audit.server.ts"',
        'import type { ServerOnly } from "@nifrajs/web"',
        "export async function loader() { audit(); return { n: rows().length } }",
        "export const loaderOutput = { n: 0 }",
        "export type Rows = ServerOnly<number[]>",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
      "lib/db.server.ts":
        'import "@nifrajs/web/server-only"\nimport type { ServerOnly as Secret } from "@nifrajs/web"\nexport const rows = (): Secret<number[]> => []\n',
      "routes/audit.server.ts": "export const audit = () => {}\n",
      "frontend/legacy.server.ts": "export const legacy = 1\n",
      "vite.config.ts":
        'import { viteServerOnlyEmpty } from "@nifrajs/web/plugins/vite-server-only"\nexport default { plugins: [viteServerOnlyEmpty()] }\n',
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves).toEqual([
      { from: "frontend/legacy.server.ts", to: "backend/legacy.ts" },
      { from: "lib/db.server.ts", to: "backend/lib/db.ts" },
      { from: "routes/audit.server.ts", to: "backend/audit.ts" },
    ])
    const db = read(dir, "backend/lib/db.ts")
    expect(db).toContain('import "@nifrajs/web/backend-only"')
    expect(db).toContain("import type { BackendOnly as Secret }")
    expect(db).toContain("Secret<number[]>")
    const backendHalf = read(dir, "routes/index.backend.ts")
    expect(backendHalf).toContain('from "../backend/lib/db.ts"')
    expect(backendHalf).toContain('from "../backend/audit.ts"')
    expect(read(dir, "routes/index.tsx")).toContain("BackendOnly<number[]>")
    expect(read(dir, "routes/index.tsx")).not.toContain("ServerOnly")
    expect(result.issues.map((issue) => issue.file)).toEqual(["vite.config.ts"])
  })

  test("a .server module the browser still imports, or whose new home is taken, is reported", async () => {
    const dir = app({
      "routes/index.tsx":
        'import { label } from "../lib/label.server.ts"\nexport default function Page() { return label }\n',
      "lib/label.server.ts": 'export const label = "x"\n',
      "lib/db.server.ts": "export const db = 1\n",
      "backend/lib/db.ts": 'import { db } from "../../lib/db.server.ts"\nexport const rows = db\n',
    })
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.issues).toContainEqual({
      file: "lib/label.server.ts",
      reason:
        'a route frontend still imports it at runtime, where it ran empty as a ".server" module; move that use into the route\'s backend half before it moves to backend/lib/label.ts',
    })
    expect(result.issues).toContainEqual({
      file: "lib/db.server.ts",
      reason: 'would move to "backend/lib/db.ts", which already exists; move it by hand',
    })
    expect(result.moves.map((move) => move.from)).not.toContain("lib/db.server.ts")
  })

  test("a loader that returns data without an output schema gets a draft from its return type", async () => {
    const files = {
      "routes/index.tsx": [
        'import { db } from "../lib/db"',
        "export async function loader() { return { n: db.count(), token: db.token } }",
        "export async function action() { return null }",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
      "lib/db.ts": 'export const db = { count: () => 1, token: "x" }\n',
      "routes/typed.tsx": [
        'import { t } from "@nifrajs/schema"',
        "export const loader = () => ({ n: 1 })",
        "export const loaderOutput = t.object({ n: t.number() })",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
      // `t` names something else, so no draft is written and the half is reported.
      "routes/taken.tsx": [
        "const t = 1",
        "export async function loader() { return { t } }",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
    }
    const dir = app(files)
    // The draft reads the types of the layout as planned: db.ts has not moved on disk yet.
    const dry = await migrateLayout(dir, { typescript: ts })
    expect(
      dry.schemas.map(({ file, schema, status, omitted }) => ({ file, schema, status, omitted })),
    ).toEqual([
      {
        file: "routes/index.backend.ts",
        schema: "loaderOutput",
        status: "missing",
        omitted: ["token"],
      },
      {
        file: "routes/taken.backend.ts",
        schema: "loaderOutput",
        status: "missing",
        omitted: undefined,
      },
    ])
    expect(dry.issues).toEqual([
      {
        file: "routes/taken.backend.ts",
        reason:
          "exports a loader but no loaderOutput, so data it returns fails the request. Declare what the browser may see: export const loaderOutput = t.object({ ... }); no draft was written: `t` already names something else in this file, so it was left as is",
      },
    ])
    expect(read(dir, "routes/index.tsx")).toBe(files["routes/index.tsx"])

    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.schemas.map((entry) => entry.status)).toEqual(["generated", "missing"])
    const half = read(dir, "routes/index.backend.ts")
    expect(half).toContain('import { t } from "@nifrajs/schema"')
    expect(half).toContain(
      "export const loaderOutput = t.object({\n  n: t.number(),\n  // left out: token - a credential-like name",
    )
    expect(half).toMatch(
      /\/\/ nifra:generated [0-9a-f]{8} - drafted from the loader's return type; review/,
    )
    expect(half).not.toContain("actionOutput")
    // A hand-written schema moves with its loader and is never redrafted.
    const typed = read(dir, "routes/typed.backend.ts")
    expect(typed).toContain("export const loaderOutput = t.object({ n: t.number() })")
    expect(typed).not.toContain("nifra:generated")
  })

  test("test-runner mocks follow the module they name", async () => {
    const dir = app({
      "backend.ts": 'import { db } from "./lib/db.ts"\nexport const backend = db\n',
      "lib/db.ts": "export const db = 1\n",
      "test/db.test.ts": [
        'import { mock } from "bun:test"',
        'mock.module("../lib/db.ts", () => ({ db: 2 }))',
        'vi.mock("../lib/db")',
        'jest.requireActual("../lib/db.ts")',
        'other.mock("../lib/db.ts")',
        "",
      ].join("\n"),
      "routes/index.tsx": "export default () => null\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves.map((m) => m.to)).toContain("backend/lib/db.ts")
    expect(read(dir, "test/db.test.ts")).toBe(
      [
        'import { mock } from "bun:test"',
        'mock.module("../backend/lib/db.ts", () => ({ db: 2 }))',
        'vi.mock("../backend/lib/db")',
        'jest.requireActual("../backend/lib/db.ts")',
        'other.mock("../lib/db.ts")',
        "",
      ].join("\n"),
    )
  })

  test("tsconfig include follows moved code into the zone folders, layout and comments kept", async () => {
    const files = {
      "backend.ts": 'import { db } from "./lib/db.ts"\nexport const backend = db\n',
      "lib/db.ts": "export const db = 1\n",
      "components/card.tsx": "export const Card = () => null\n",
      "routes/index.tsx": 'import { Card } from "../components/card.tsx"\nexport default Card\n',
    }
    const multiline = app({
      ...files,
      "tsconfig.json": [
        "{",
        "  // app sources",
        '  "include": [',
        '    "routes",',
        '    "lib",',
        '    "components", // UI',
        "  ],",
        "}",
        "",
      ].join("\n"),
    })
    const result = await migrateLayout(multiline, { typescript: ts, write: true })
    // backend.ts sat outside the include, so the whole backend folder would take in its new place.
    expect(result.tooling).toContainEqual({
      file: "tsconfig.json",
      change: "include += backend/lib, frontend",
    })
    expect(read(multiline, "tsconfig.json")).toBe(
      [
        "{",
        "  // app sources",
        '  "include": [',
        '    "routes",',
        '    "lib",',
        '    "components", // UI',
        '    "backend/lib",',
        '    "frontend",',
        "  ],",
        "}",
        "",
      ].join("\n"),
    )

    const noTrailingComma = app({
      ...files,
      "tsconfig.json":
        '{\n  "include": [\n    "routes",\n    "lib",\n    "components" // UI\n  ]\n}\n',
    })
    await migrateLayout(noTrailingComma, { typescript: ts, write: true })
    expect(read(noTrailingComma, "tsconfig.json")).toBe(
      '{\n  "include": [\n    "routes",\n    "lib",\n    "components", // UI\n    "backend/lib",\n    "frontend"\n  ]\n}\n',
    )

    const inline = app({
      ...files,
      "tsconfig.json": '{ "include": ["routes", "lib", "components"] }\n',
    })
    await migrateLayout(inline, { typescript: ts, write: true })
    expect(read(inline, "tsconfig.json")).toBe(
      '{ "include": ["routes", "lib", "components", "backend/lib", "frontend"] }\n',
    )

    // Already covered by a glob, or no include at all: tsc's own rules hold, so nothing changes.
    const covered = app({ ...files, "tsconfig.json": '{ "include": ["**/*.ts", "**/*.tsx"] }\n' })
    expect(
      (await migrateLayout(covered, { typescript: ts })).tooling.filter(
        (edit) => edit.file === "tsconfig.json",
      ),
    ).toEqual([])
    const open = app({ ...files, "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n' })
    expect(
      (await migrateLayout(open, { typescript: ts })).tooling.filter(
        (edit) => edit.file === "tsconfig.json",
      ),
    ).toEqual([])
  })

  test("tailwind content globs that lose a moved file are reported", async () => {
    const dir = app({
      "components/card.tsx": "export const Card = () => null\n",
      "routes/index.tsx": 'import { Card } from "../components/card.tsx"\nexport default Card\n',
      "tailwind.config.ts":
        'export default { content: ["./routes/**/*.tsx", "./components/**/*.tsx"] }\n',
    })
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.issues).toContainEqual({
      file: "tailwind.config.ts",
      reason:
        'its content globs matched 1 file(s) that move, but none of their new paths (such as "components/card.tsx" -> "frontend/components/card.tsx"), so Tailwind would stop seeing their classes. Add globs for "./frontend/**/*" (with the extensions you use)',
    })
  })

  test("only the folders the move emptied are removed", async () => {
    const dir = app({
      "components/card.tsx": "export const Card = () => null\n",
      "routes/index.tsx": 'import { Card } from "../components/card.tsx"\nexport default Card\n',
    })
    mkdirSync(join(dir, "assets", "uploads"), { recursive: true })
    mkdirSync(join(dir, "routes", "drafts"))
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves).toContainEqual({
      from: "components/card.tsx",
      to: "frontend/components/card.tsx",
    })
    expect(existsSync(join(dir, "components"))).toBe(false)
    expect(existsSync(join(dir, "assets", "uploads"))).toBe(true)
    expect(existsSync(join(dir, "routes", "drafts"))).toBe(true)
  })

  test("a machine without git still migrates and ignores .nifra/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nifra-migrate-nogit-"))
    writeFileSync(join(dir, "package.json"), "{}\n")
    mkdirSync(join(dir, "routes"))
    writeFileSync(join(dir, "routes", "index.tsx"), "export default () => null\n")
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error('Executable not found in $PATH: "git"')
    })
    try {
      await migrateLayout(dir, { typescript: ts, write: true })
      expect(spawn).toHaveBeenCalled()
      expect(read(dir, ".gitignore")).toBe(".nifra/\n")
    } finally {
      spawn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("folders the app already zones in package.json stay where they are", async () => {
    const dir = app({
      "package.json": JSON.stringify({ nifra: { zones: { backend: ["migrations"] } } }),
      "backend.ts":
        'import { up } from "./migrations/0002_backfill.ts"\nexport const backend = up\n',
      "migrations/0001_init.sql": "create table t (id int);\n",
      "migrations/0002_backfill.ts": "export const up = () => 1\n",
      "routes/index.tsx": "export default () => null\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves.map((m) => m.to)).toEqual(["backend/app.ts"])
    expect(result.issues).toEqual([])
    expect(read(dir, "backend/app.ts")).toContain('from "../migrations/0002_backfill.ts"')
  })

  test(".nifra/ is added to .gitignore unless it is already ignored", async () => {
    // Outside any git checkout, so the app's own .gitignore is the only answer.
    const make = (files: Record<string, string>): string => {
      const dir = mkdtempSync(join(tmpdir(), "nifra-migrate-gitignore-"))
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), content)
      }
      return dir
    }
    const page = { "routes/index.tsx": "export default () => null\n" }
    const bare = make({ ...page, ".gitignore": "node_modules" })
    const ignored = make({ ...page, ".gitignore": "dist\n/.nifra\n" })
    const none = make(page)
    try {
      const result = await migrateLayout(bare, { typescript: ts, write: true })
      expect(result.tooling).toContainEqual({
        file: ".gitignore",
        change: "ignore .nifra/ (dev and build state)",
      })
      expect(read(bare, ".gitignore")).toBe("node_modules\n.nifra/\n")
      expect((await migrateLayout(ignored, { typescript: ts, write: true })).tooling).toEqual([])
      expect(read(ignored, ".gitignore")).toBe("dist\n/.nifra\n")
      await migrateLayout(none, { typescript: ts, write: true })
      expect(read(none, ".gitignore")).toBe(".nifra/\n")
      // A dry run reports the change and writes nothing.
      const dry = make(page)
      expect((await migrateLayout(dry, { typescript: ts })).tooling).toHaveLength(1)
      expect(existsSync(join(dry, ".gitignore"))).toBe(false)
      rmSync(dry, { recursive: true, force: true })
    } finally {
      for (const dir of [bare, ignored, none]) rmSync(dir, { recursive: true, force: true })
    }
  })

  const semicolonRoute = [
    'import { db } from "../lib/db";',
    'import { format } from "../lib/format";',
    "",
    "export const loader = async () => {",
    "  return { n: format(db) };",
    "};",
    "",
    "export default function Page() {",
    "  return <p>{format(1)}</p>;",
    "}",
    "",
  ].join("\n")
  const semicolonApp = {
    "lib/db.ts": "export const db = 1;\n",
    "lib/format.ts": "export const format = (n: number): string => String(n);\n",
    "routes/index.tsx": semicolonRoute,
  }

  test("rebuilt imports keep the statement terminator the file was written with", async () => {
    const dir = app(semicolonApp)
    await migrateLayout(dir, { typescript: ts, write: true })
    expect(read(dir, "routes/index.tsx")).toStartWith(
      'import { format } from "../shared/lib/format";\n',
    )
    const backendHalf = read(dir, "routes/index.backend.ts")
    expect(backendHalf).toContain('import { db } from "../backend/lib/db";\n')
    expect(backendHalf).toContain('import { format } from "../shared/lib/format";\n')
    expect(split('import { a } from "./a"\nexport const loader = () => a\n').backend).toContain(
      'import { a } from "./a"\n',
    )
    expect(middlewareSource(ts, "export default (ctx) => ctx.next();\n", "_middleware.ts")).toBe(
      "export const middleware = (ctx) => ctx.next();\n",
    )
  })

  test("an importer of a moved export reads it from the backend half; the rest stays", async () => {
    const dir = app({
      ...semicolonApp,
      "routes/__tests__/index.test.ts": [
        'import Page, { loader as load } from "../index";',
        'export { loader } from "../index";',
        'import type { loader as L } from "../index.tsx";',
        'import * as page from "../index";',
        "",
        "void [Page, load, page.loader] as unknown as L;",
        "",
      ].join("\n"),
      "scripts/warm.ts": 'const route = await import("../routes/index")\nawait route.loader()\n',
      "scripts/prerender.ts":
        'const { loader: load } = await import("../routes/index")\nawait (await import("../routes/index")).loader()\nexport { load }\n',
      "scripts/render.ts":
        'const route = await import("../routes/index")\nawait route.loader()\nexport const page = route.default\n',
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(read(dir, "routes/__tests__/index.test.ts")).toBe(
      [
        'import Page from "../index";',
        'import { loader as load } from "../index.backend";',
        'export { loader } from "../index.backend";',
        'import type { loader as L } from "../index.backend.ts";',
        'import * as page from "../index";',
        "",
        "void [Page, load, page.loader] as unknown as L;",
        "",
      ].join("\n"),
    )
    expect(result.rewritten).toContain("routes/__tests__/index.test.ts")
    expect(result.issues).toContainEqual({
      file: "routes/__tests__/index.test.ts",
      reason:
        'reads "loader" through a namespace import of "../index", but they moved to "routes/index.backend.ts"; import them from there by hand',
    })
    // A loaded module read only for moved exports loads the backend half instead.
    expect(read(dir, "scripts/warm.ts")).toBe(
      'const route = await import("../routes/index.backend")\nawait route.loader()\n',
    )
    expect(read(dir, "scripts/prerender.ts")).toBe(
      'const { loader: load } = await import("../routes/index.backend")\nawait (await import("../routes/index.backend")).loader()\nexport { load }\n',
    )
    expect(result.issues).toContainEqual({
      file: "scripts/render.ts",
      reason:
        'loads "../routes/index" with import() and mentions "loader", which moved to "routes/index.backend.ts"; load the backend half for them by hand',
    })
    expect(result.issues.filter((issue) => issue.file.startsWith("scripts/"))).toHaveLength(1)
  })

  test("an app one folder down: the dry run from the package names --dir, and code beside it is reported", async () => {
    const pkg = app({
      "package.json": '{ "name": "site" }\n',
      ...Object.fromEntries(
        Object.entries(semicolonApp).map(([path, text]) => [`src/${path}`, text]),
      ),
      "test/index.test.ts":
        'import { loader } from "../src/routes/index";\nimport { db } from "../src/lib/db";\nvoid [loader, db];\n',
    })
    await expect(migrateLayout(pkg, { typescript: ts })).rejects.toThrow(
      "src/routes/ exists: run `nifra migrate layout --dir src` to migrate the app there",
    )
    const result = await migrateLayout(join(pkg, "src"), { typescript: ts, write: true })
    expect(result.issues).toContainEqual({
      file: "../test/index.test.ts",
      reason:
        'imports "loader" from "../src/routes/index"; import it from "../src/routes/index.backend" - it is outside src/, so the migration does not rewrite it',
    })
    expect(result.issues).toContainEqual({
      file: "../test/index.test.ts",
      reason:
        'imports "../src/lib/db", which moves to "backend/lib/db.ts" - it is outside src/, so the migration does not rewrite it',
    })
    expect(read(pkg, "test/index.test.ts")).toContain('from "../src/routes/index"')
    expect(result.schemas.map((entry) => `${entry.file} ${entry.status}`)).toEqual([
      "routes/index.backend.ts generated",
    ])
  })
})

describe("migrateLayout on an API-only app", () => {
  const PACKAGE = '{\n  "name": "orders-api",\n  "scripts": { "start": "bun backend.ts" }\n}\n'
  const backendOnly = (extra: Record<string, string> = {}) =>
    app({
      "package.json": PACKAGE,
      "tsconfig.json": '{ "include": ["*.ts", "lib"] }\n',
      "backend.ts":
        'import { server } from "@nifrajs/core"\nimport { db } from "./lib/db"\nexport const backend = server().get("/orders", () => db.all())\n',
      "lib/db.ts": "export const db = { all: () => [] }\n",
      "scripts/seed.ts": 'import { backend } from "../backend"\nvoid backend\n',
      ...extra,
    })

  test("a path named only in comments is a follow-up; in code or a string it is an issue", async () => {
    const quiet = '{\n  "name": "orders-api"\n}\n'
    const dir = backendOnly({
      "package.json": quiet,
      "lib/notes.ts": [
        "/** Mirrors the routes in backend.ts. */",
        "export const notes = 1 // backend.ts registers them",
        "/* see backend.ts */",
        "",
      ].join("\n"),
    })
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.followUps).toEqual([
      {
        file: "lib/notes.ts",
        reason: 'a comment names "backend.ts", which moved to "backend/app.ts"',
      },
    ])
    // The same run twice reads the same.
    expect(await migrateLayout(dir, { typescript: ts })).toEqual(result)

    const mixed = backendOnly({
      "package.json": quiet,
      "lib/build.ts": [
        "// builds backend.ts",
        'export const entry = "./backend.ts"',
        "export const doc = `served by backend.ts`",
        "",
      ].join("\n"),
    })
    const both = await migrateLayout(mixed, { typescript: ts })
    expect(both.ok).toBe(false)
    expect(both.followUps).toEqual([])
    expect(both.issues).toEqual([
      {
        file: "lib/build.ts",
        reason: 'mentions "backend.ts" by path; it moved to "backend/app.ts"',
      },
    ])
  })

  test("only the backend entry moves; nothing is split or zoned, and the dry run shows the kind it declares", async () => {
    const dir = backendOnly()
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.mode).toBe("api")
    expect(result.splits).toEqual([])
    expect(result.moves).toEqual([{ from: "backend.ts", to: "backend/app.ts" }])
    expect(result.rewritten).toEqual(["scripts/seed.ts"])
    expect(result.tooling).toContainEqual({ file: "tsconfig.json", change: "include += backend" })
    expect(result.tooling).toContainEqual({
      file: "package.json",
      change: '"nifra": { "kind": "api" }',
    })
    expect(result.issues).toEqual([
      {
        file: "package.json",
        reason: 'mentions "backend.ts" by path; it moved to "backend/app.ts"',
      },
    ])
    expect(read(dir, "package.json")).toBe(PACKAGE)
  })

  test("--write moves it, follows its imports both ways and declares the kind in place", async () => {
    const dir = backendOnly()
    await migrateLayout(dir, { typescript: ts, write: true })
    expect(existsSync(join(dir, "backend.ts"))).toBe(false)
    expect(read(dir, "backend/app.ts")).toContain('from "../lib/db"')
    expect(read(dir, "lib/db.ts")).toBe("export const db = { all: () => [] }\n")
    expect(read(dir, "scripts/seed.ts")).toContain('from "../backend/app"')
    expect(read(dir, "package.json")).toBe(
      '{\n  "name": "orders-api",\n  "scripts": { "start": "bun backend.ts" },\n  "nifra": { "kind": "api" }\n}\n',
    )
    expect(read(dir, "tsconfig.json")).toBe('{ "include": ["*.ts", "lib", "backend"] }\n')
  })

  test("a declared kind keeps routes/ unsplit and adds nothing to package.json", async () => {
    const declared = '{ "name": "x", "nifra": { "kind": "api" } }\n'
    const dir = app({
      "package.json": declared,
      "backend.ts": "export const backend = { routes: () => [] }\n",
      "routes/index.tsx":
        "export async function loader() { return {} }\nexport default () => null\n",
    })
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.mode).toBe("api")
    expect(result.splits).toEqual([])
    expect(result.moves).toEqual([{ from: "backend.ts", to: "backend/app.ts" }])
    expect(result.tooling.map((edit) => edit.file)).not.toContain("package.json")
  })

  test("the kind goes into an existing nifra object, on the object's own line style", async () => {
    const dir = backendOnly({ "package.json": '{"name":"x","nifra":{"zones":{}}}' })
    await migrateLayout(dir, { typescript: ts, write: true })
    expect(read(dir, "package.json")).toBe('{"name":"x","nifra":{"zones":{}, "kind": "api"}}')
  })

  test("web config without routes/, or a kind that clashes with it, is refused with the choice to make", async () => {
    const config = 'export const adapter = {}\nexport const clientModule = "x"\n'
    const unrouted = app({ "nifra.config.ts": config, "backend.ts": "export const backend = 1\n" })
    await expect(migrateLayout(unrouted, { typescript: ts })).rejects.toThrow(
      'but it has web config (nifra.config.ts). A web app is file-routed under routes/; if this one serves no pages, remove the web config and declare "nifra": { "kind": "api" } in package.json',
    )
    const clash = app({
      "package.json": '{ "nifra": { "kind": "api" } }',
      "nifra.config.ts": config,
      "routes/index.tsx": "export default () => null\n",
    })
    await expect(migrateLayout(clash, { typescript: ts })).rejects.toThrow(
      'package.json declares "nifra": { "kind": "api" }, but',
    )
    await expect(migrateLayout(app({ "lib/x.ts": "" }), { typescript: ts })).rejects.toThrow(
      "there is nothing to migrate",
    )
  })
})

describe("migrateLayout entries, tests and workspace siblings", () => {
  test("a config path joined onto its own folder is an entry and follows its module", async () => {
    const dir = app({
      "nifra.config.ts": [
        'import { resolve } from "node:path"',
        'import * as path from "node:path"',
        'import { fileURLToPath } from "node:url"',
        'export const clientModule = resolve(import.meta.dir, "src/browser-main.tsx")',
        "export const componentPipeline = {",
        '  adapter: "react",',
        "  entries: {",
        '    client: path.join(import.meta.dirname, "src", "hydrate.tsx"),',
        '    ssr: fileURLToPath(new URL("./src/render.tsx", import.meta.url)),',
        "  },",
        "} as const",
        "",
      ].join("\n"),
      "src/browser-main.tsx":
        'import { theme } from "./theme"\nexport function mountRouter() {\n  return theme\n}\n',
      "src/theme.ts": 'export const theme = "dark"\n',
      "src/hydrate.tsx": "export const hydrate = 1\n",
      "src/render.tsx": "export const render = 1\n",
      "routes/index.tsx": "export default () => null\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves.map((move) => `${move.from} -> ${move.to}`)).toEqual([
      "src/browser-main.tsx -> frontend/src/browser-main.tsx",
      "src/hydrate.tsx -> frontend/src/hydrate.tsx",
      "src/render.tsx -> backend/src/render.tsx",
      "src/theme.ts -> frontend/src/theme.ts",
    ])
    const config = read(dir, "nifra.config.ts")
    expect(config).toContain('resolve(import.meta.dir, "frontend/src/browser-main.tsx")')
    expect(config).toContain('path.join(import.meta.dirname, "frontend", "src", "hydrate.tsx")')
    expect(config).toContain('new URL("./backend/src/render.tsx", import.meta.url)')
    expect(result.rewritten).toContain("nifra.config.ts")
    expect(result.issues.filter((issue) => issue.file === "nifra.config.ts")).toEqual([])
  })

  test("a test moves with the subject beside it, and stays when its subjects part", async () => {
    const files = {
      "src/lib/fmt.ts": "export const fmt = (n: number) => String(n)\n",
      "src/lib/fmt.test.ts":
        'import { fmt } from "./fmt"\nimport { helper } from "../../test/helper"\nexport const t = fmt(helper)\n',
      "src/lib/__snapshots__/fmt.test.ts.snap": 'exports[`fmt 1`] = `"1"`;\n',
      "src/lib/pad.ts": "export const pad = 1\n",
      "src/lib/__tests__/pad.test.ts": 'import { pad } from "../pad"\nexport const t = pad\n',
      "src/both.ts": "export const both = 1\n",
      "src/both.tsx": "export const Both = () => null\n",
      "src/both.test.ts": 'import { both } from "./both"\nexport const t = both\n',
      "test/helper.ts": 'import { pad } from "../src/lib/pad"\nexport const helper = pad\n',
      // A runner's own config names the test; the app's excludes it.
      "tsconfig.json": JSON.stringify({
        include: ["src", "routes"],
        exclude: ["src/lib/fmt.test.ts"],
      }),
      "tsconfig.bun.json": JSON.stringify({
        include: ["./src/lib/fmt.test.ts", "src/**/*.bun.ts"],
      }),
      "routes/index.tsx": [
        'import { fmt } from "../src/lib/fmt"',
        'import { pad } from "../src/lib/pad"',
        'import { Both } from "../src/both.tsx"',
        'import { both } from "../src/both.ts"',
        "export async function loader() { return { both } }",
        "export default () => fmt(pad) + Both()",
        "",
      ].join("\n"),
    }
    const dir = app(files)
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves.map((move) => `${move.from} -> ${move.to}`)).toEqual([
      "src/both.ts -> backend/src/both.ts",
      "src/both.tsx -> frontend/src/both.tsx",
      "src/lib/__snapshots__/fmt.test.ts.snap -> frontend/src/lib/__snapshots__/fmt.test.ts.snap",
      "src/lib/__tests__/pad.test.ts -> frontend/src/lib/__tests__/pad.test.ts",
      "src/lib/fmt.test.ts -> frontend/src/lib/fmt.test.ts",
      "src/lib/fmt.ts -> frontend/src/lib/fmt.ts",
      "src/lib/pad.ts -> frontend/src/lib/pad.ts",
    ])
    expect(read(dir, "frontend/src/lib/__snapshots__/fmt.test.ts.snap")).toBe(
      files["src/lib/__snapshots__/fmt.test.ts.snap"],
    )
    const fmtTest = read(dir, "frontend/src/lib/fmt.test.ts")
    expect(fmtTest).toContain('from "./fmt"')
    expect(fmtTest).toContain('from "../../../test/helper"')
    expect(read(dir, "frontend/src/lib/__tests__/pad.test.ts")).toContain('from "../pad"')
    // A helper only tests use stays where it is, still reaching what moved.
    expect(read(dir, "test/helper.ts")).toContain('from "../frontend/src/lib/pad"')
    expect(read(dir, "src/both.test.ts")).toContain('from "../backend/src/both"')
    expect(JSON.parse(read(dir, "tsconfig.json")).exclude).toEqual(["frontend/src/lib/fmt.test.ts"])
    expect(JSON.parse(read(dir, "tsconfig.bun.json")).include).toEqual([
      "./frontend/src/lib/fmt.test.ts",
      "src/**/*.bun.ts",
    ])
    expect(result.issues.filter((issue) => issue.file.startsWith("tsconfig"))).toEqual([])
    expect(result.issues).toContainEqual({
      file: "src/both.test.ts",
      reason:
        'tests "src/both.ts" and "src/both.tsx", which end up in different folders, so it stays here; move it by hand',
    })
    const again = await migrateLayout(dir, { typescript: ts })
    expect(again.moves).toEqual([])
    expect(again.issues.filter((issue) => issue.file.endsWith(".test.ts"))).toEqual([])
  })

  test("each tsconfig keeps checking what it checked and leaving out what it left out", async () => {
    const dir = app({
      "tsconfig.json": JSON.stringify({ include: ["src"], exclude: ["src/data"] }),
      "tsconfig.data.json": JSON.stringify({
        extends: "./tsconfig.json",
        include: ["src/data"],
        exclude: ["node_modules"],
      }),
      "tsconfig.check.json": JSON.stringify({
        extends: "./tsconfig.json",
        include: ["src/**/*.ts"],
      }),
      "src/ui/card.tsx": "export const Card = (props: object) => props\n",
      "src/lib/money.ts": "export const money = 1\n",
      "src/lib/db.ts": "export const db = () => []\n",
      "src/data/inventory.ts": "export const inventory = 1\n",
      "src/data/inventory.test.ts":
        'import { inventory } from "./inventory"\nexport const t = inventory\n',
      "routes/index.tsx": [
        'import { Card } from "../src/ui/card"',
        'import { money } from "../src/lib/money"',
        'import { inventory } from "../src/data/inventory"',
        'import { db } from "../src/lib/db"',
        "export async function loader() { return { rows: db(), money, inventory } }",
        "export default () => Card({ money, inventory })",
        "",
      ].join("\n"),
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.moves.map((move) => `${move.from} -> ${move.to}`)).toEqual([
      "src/data/inventory.test.ts -> shared/src/data/inventory.test.ts",
      "src/data/inventory.ts -> shared/src/data/inventory.ts",
      "src/lib/db.ts -> backend/src/lib/db.ts",
      "src/lib/money.ts -> shared/src/lib/money.ts",
      "src/ui/card.tsx -> frontend/src/ui/card.tsx",
    ])
    // The whole zone folder where that takes in nothing new; else the folder's twin, and the
    // excluded folder's twin beside it.
    expect(JSON.parse(read(dir, "tsconfig.json"))).toEqual({
      include: ["src", "backend", "frontend", "shared/src"],
      exclude: ["src/data", "shared/src/data"],
    })
    expect(JSON.parse(read(dir, "tsconfig.data.json")).include).toEqual([
      "src/data",
      "shared/src/data",
    ])
    // An inherited exclude already moved with the base config.
    expect(JSON.parse(read(dir, "tsconfig.check.json"))).toEqual({
      extends: "./tsconfig.json",
      include: ["src/**/*.ts", "backend", "shared"],
    })
    expect(result.tooling).toContainEqual({
      file: "tsconfig.json",
      change: "exclude += shared/src/data",
    })
    expect(result.issues.filter((issue) => issue.file.startsWith("tsconfig"))).toEqual([])
  })

  test("shared route data is written beside the route, stays there, and a second run keeps it", async () => {
    const route = [
      'import { Card } from "../../components/card"',
      "const GUIDES = { a: 'A', b: 'B' } as const",
      "export const GUIDE_KEYS = Object.keys(GUIDES)",
      "export { GUIDES }",
      "export async function getStaticPaths() {",
      "  return { paths: GUIDE_KEYS.map((slug) => ({ params: { slug } })), fallback: false }",
      "}",
      "export async function loader({ params }: { params: { slug: 'a' | 'b' } }) {",
      "  return { name: GUIDES[params.slug] }",
      "}",
      "export default function Page() { return <Card n={GUIDE_KEYS.length} /> }",
      "",
    ].join("\n")
    const dir = app({
      "routes/guides/[slug].tsx": route,
      "routes/taken.tsx": route.replace("../../components", "../components"),
      "routes/taken.shared.ts": "export const other = 1\n",
      "components/card.tsx": "export const Card = (props: { n: number }) => props.n\n",
    })
    const result = await migrateLayout(dir, { typescript: ts, write: true })
    expect(result.splits).toContainEqual({
      file: "routes/guides/[slug].tsx",
      backend: "routes/guides/[slug].backend.ts",
      moved: ["getStaticPaths", "loader"],
      shared: "routes/guides/[slug].shared.ts",
    })
    expect(read(dir, "routes/guides/[slug].shared.ts")).toBe(
      "export const GUIDES = { a: 'A', b: 'B' } as const\nexport const GUIDE_KEYS = Object.keys(GUIDES)\n",
    )
    const page = read(dir, "routes/guides/[slug].tsx")
    expect(page).toContain('import { GUIDES, GUIDE_KEYS } from "./[slug].shared"')
    expect(page).toContain('export { GUIDE_KEYS } from "./[slug].shared"')
    expect(page).toContain("export { GUIDES }")
    expect(page).not.toContain("Object.keys")
    expect(read(dir, "routes/guides/[slug].backend.ts")).toContain(
      'import { GUIDES, GUIDE_KEYS } from "./[slug].shared"',
    )
    // The name is taken, so the data is copied into each half and reported.
    expect(read(dir, "routes/taken.shared.ts")).toBe("export const other = 1\n")
    expect(read(dir, "routes/taken.backend.ts")).toContain("const GUIDE_KEYS = Object.keys(GUIDES)")
    expect(result.issues).toContainEqual({
      file: "routes/taken.tsx",
      reason:
        '"GUIDE_KEYS" is needed by both halves and was copied into each; consider moving it to shared/',
    })
    const again = await migrateLayout(dir, { typescript: ts })
    expect(again.splits).toEqual([])
    expect(again.moves).toEqual([])
    expect(again.issues.map((issue) => issue.file)).not.toContain("routes/guides/[slug].tsx")
    expect(again.issues.map((issue) => issue.file)).not.toContain("routes/guides/[slug].shared.ts")
  })

  test("a workspace sibling that names a moved app file is reported, never edited", async () => {
    const ws = createFixtureProject(ROOT, "ws-")
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "ws", workspaces: ["apps/*", "!apps/ignored"] }),
      "apps/web/package.json": JSON.stringify({ name: "@ws/web" }),
      "apps/web/src/lib/origins.ts": "export const hosts = 1\n",
      "apps/web/src/lib/x.ts": "export const x = 1\n",
      "apps/web/routes/index.tsx": [
        'import { hosts } from "../src/lib/origins"',
        'import { x } from "../src/lib/x"',
        "export default () => hosts + x",
        "",
      ].join("\n"),
      "apps/api/package.json": JSON.stringify({ name: "@ws/api" }),
      "apps/api/src/lib/origins.ts": "export const own = 1\n",
      "apps/api/src/boot.test.ts": [
        'const REPO = new URL("../../../", import.meta.url).pathname',
        "const script = 'const m = await import(\"./src/lib/origins.ts\"); console.log(m)'",
        'Bun.spawnSync(["bun", "-e", script], { cwd: `${REPO}apps/web` })',
        "",
      ].join("\n"),
      "apps/api/src/uses.ts": 'import { x } from "../../web/src/lib/x"\nexport const y = x\n',
      "apps/api/src/other.ts":
        'import "../../web/README.md"\nexport const p = "packages/foo/src/lib/x.ts"\n',
      "apps/api/src/own.ts": 'export const p = "src/lib/origins.ts"\n',
      "apps/ignored/package.json": JSON.stringify({ name: "@ws/ignored" }),
      "apps/ignored/src/a.ts": 'import { x } from "../../web/src/lib/x"\nexport const a = x\n',
    }
    for (const [path, content] of Object.entries(files)) writeAppFile(ws, path, content)
    const result = await migrateLayout(join(ws, "apps/web"), { typescript: ts, write: true })
    expect(result.issues.filter((issue) => issue.file.startsWith("../"))).toEqual([
      {
        file: "../api/src/boot.test.ts",
        reason:
          'names "src/lib/origins.ts" on line 2, and it moves to "frontend/src/lib/origins.ts" - it is outside the app, so the migration does not rewrite it',
      },
      {
        file: "../api/src/uses.ts",
        reason:
          'names "src/lib/x.ts" on line 1, and it moves to "frontend/src/lib/x.ts" - it is outside the app, so the migration does not rewrite it',
      },
    ])
    for (const path of Object.keys(files).filter((path) => !path.startsWith("apps/web/")))
      expect(read(ws, path)).toBe(files[path] ?? "")
  })

  test("a sibling's every line naming a moved path is listed, and a comment-only mention is a follow-up", async () => {
    const ws = createFixtureProject(ROOT, "ws-")
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "ws", workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "@ws/web" }),
      "apps/web/src/lib/bark.ts": "export const bark = 1\n",
      "apps/web/routes/index.tsx":
        'import { bark } from "../src/lib/bark"\nexport default () => bark\n',
      "apps/jobs/package.json": JSON.stringify({ name: "@ws/jobs" }),
      "apps/jobs/src/sync.ts": [
        "// bark.ts sits in web at src/lib/bark.ts",
        "export const a = 1",
        'export const barkFile = new URL("../../web/src/lib/bark.ts", import.meta.url)',
        "",
      ].join("\n"),
      "apps/jobs/src/notes.ts": "// Copied from ../web/src/lib/bark.ts.\nexport const c = 1\n",
    }
    for (const [path, content] of Object.entries(files)) writeAppFile(ws, path, content)
    const result = await migrateLayout(join(ws, "apps/web"), { typescript: ts })
    expect(result.issues.filter((issue) => issue.file.startsWith("../"))).toEqual([
      {
        file: "../jobs/src/sync.ts",
        reason:
          'names "src/lib/bark.ts" on line 3 (and in a comment on line 1), and it moves to "frontend/src/lib/bark.ts" - it is outside the app, so the migration does not rewrite it',
      },
    ])
    expect(result.followUps.filter((step) => step.file.startsWith("../"))).toEqual([
      {
        file: "../jobs/src/notes.ts",
        reason:
          'a comment on line 1 names "src/lib/bark.ts", which moved to "frontend/src/lib/bark.ts"',
      },
    ])
  })
})
