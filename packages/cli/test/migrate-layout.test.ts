import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
  splitRouteSource(ts, source, file, "./index.backend.ts")

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

  test("a helper both halves use is copied into each and reported", () => {
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
      '"format" is needed by both halves and was copied into each; consider moving it to shared/',
    ])
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
    "build.ts": 'const out = import.meta.dir + "/lib/db.ts"\nconsole.log(out)\n',
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
    // a path in a string is not an import: reported, not rewritten
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
    // No target of `@app/*` or `#db/*` covers the new place: left as written and reported.
    expect(read(dir, "routes/index.tsx")).toContain('from "@app/money"')
    expect(read(dir, "routes/index.backend.ts")).toContain('from "#db/pool"')
    const reasons = result.issues.map((issue) => `${issue.file}: ${issue.reason}`)
    expect(reasons).toContain(
      'routes/index.tsx: "not-a-real-package-xyz" names no installed package and no file through the app\'s tsconfig paths or package.json imports, so the migration cannot tell where it belongs; check it by hand',
    )
    expect(reasons).toContain(
      'routes/index.backend.ts: the path alias "#db/pool" names "db/pool.ts", which moves to "backend/db/pool.ts", and no target of that alias covers the new location; point it there by hand',
    )
    expect(reasons).toContain(
      'routes/index.tsx: the path alias "@app/money" names "src/money.ts", which moves to "frontend/src/money.ts", and no target of that alias covers the new location; point it there by hand',
    )
    // An installed package and the aliases that still resolve are not issues.
    expect(reasons.filter((reason) => /typescript|~\/|clientModule/.test(reason))).toEqual([])
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

  test("a loader or action that returns data without an output schema is reported", async () => {
    const dir = app({
      "routes/index.tsx": [
        "export async function loader() { return { n: 1 } }",
        "export async function action() { return null }",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
      "routes/typed.tsx": [
        'import { t } from "@nifrajs/schema"',
        "export const loader = () => ({ n: 1 })",
        "export const loaderOutput = t.object({ n: t.number() })",
        "export default function Page() { return null }",
        "",
      ].join("\n"),
    })
    const result = await migrateLayout(dir, { typescript: ts })
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([
      {
        file: "routes/index.backend.ts",
        reason:
          "exports a loader but no loaderOutput, so data it returns fails the request. Declare what the browser may see: export const loaderOutput = t.object({ ... })",
      },
    ])
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

  test("tsconfig include gains the zone folders moved code lands in, layout and comments kept", async () => {
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
    expect(result.tooling).toContainEqual({
      file: "tsconfig.json",
      change: "include += backend, frontend",
    })
    expect(read(multiline, "tsconfig.json")).toBe(
      [
        "{",
        "  // app sources",
        '  "include": [',
        '    "routes",',
        '    "lib",',
        '    "components", // UI',
        '    "backend",',
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
      '{\n  "include": [\n    "routes",\n    "lib",\n    "components", // UI\n    "backend",\n    "frontend"\n  ]\n}\n',
    )

    const inline = app({
      ...files,
      "tsconfig.json": '{ "include": ["routes", "lib", "components"] }\n',
    })
    await migrateLayout(inline, { typescript: ts, write: true })
    expect(read(inline, "tsconfig.json")).toBe(
      '{ "include": ["routes", "lib", "components", "backend", "frontend"] }\n',
    )

    // Already covered by a glob, or no include at all: tsc's own rules hold, so nothing changes.
    const covered = app({ ...files, "tsconfig.json": '{ "include": ["**/*.ts", "**/*.tsx"] }\n' })
    expect((await migrateLayout(covered, { typescript: ts })).tooling).toEqual([])
    const open = app({ ...files, "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n' })
    expect((await migrateLayout(open, { typescript: ts })).tooling).toEqual([])
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
