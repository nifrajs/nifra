import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
})
