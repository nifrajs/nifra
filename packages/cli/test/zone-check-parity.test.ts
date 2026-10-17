import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs"
import { basename, join } from "node:path"
import { buildClient } from "@nifrajs/web/build"
import * as ts from "typescript"
import { collectCheckResult } from "../src/check.ts"
import { appDirs, clientModuleRoot } from "../src/client-module.ts"
import { createSpecifierResolver } from "../src/internal/project-specifiers.ts"
import { migrateLayout } from "../src/migrate-layout.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

// `nifra check` must refuse what the build refuses: the same files, reached through the same
// aliases and the same `clientModule`. Fixtures live in the workspace so the build resolves @nifrajs.
const parent = createFixtureRoot("tmp-zone-parity-")
afterAll(() => removeFixtureRoot(parent))

function app(files: Record<string, string>): string {
  const root = createFixtureProject(parent, "app-")
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["./*"] } } }),
    ...files,
  }
  for (const [path, content] of Object.entries(all)) writeAppFile(root, path, content)
  return root
}

/** Every module the browser build refuses, by project path; `[]` when the build passes. */
async function buildRefuses(root: string, clientModule: string): Promise<string[]> {
  try {
    await buildClient({
      routesDir: join(root, "routes"),
      outDir: join(root, "dist"),
      clientModule: join(root, clientModule),
      publicDir: false,
      minify: false,
    })
    return []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A file outside the app is named by its absolute path, which starts `C:` on Windows.
    const refused = [...message.matchAll(/^ {2}- ((?:[A-Za-z]:)?[^:\n]+): /gm)].map(
      (match) => match[1] ?? "",
    )
    expect(refused.length).toBeGreaterThan(0)
    return refused.sort()
  }
}

async function zoneFindings(root: string) {
  return (await collectCheckResult(root, { lintsOnly: true })).diagnostics
    .filter((d) => d.code === "NF-C028")
    .map((d) => ({ at: `${d.file}:${d.line}`, message: d.message }))
}

describe("NF-C028 refuses what the build refuses", () => {
  test("through a tsconfig alias and the app's clientModule, transitively", async () => {
    const root = app({
      "nifra.config.ts": 'export const clientModule = "./lib/client.tsx"\n',
      "lib/client.tsx":
        'import { fmt } from "~/lib/fmt"\nexport function mountRouter() {\n  return fmt(1)\n}\n',
      "lib/fmt.ts":
        'import { pad } from "~/lib/pad"\nexport const fmt = (n: number) => pad(String(n))\n',
      "lib/pad.ts": "export const pad = (s: string) => s.padStart(2)\n",
      "routes/index.tsx": 'import { fmt } from "~/lib/fmt"\nexport default () => fmt(1)\n',
      "routes/index.backend.ts":
        'import { session } from "~/server/session"\nexport const loader = () => session\n',
      "server/session.ts": "export const session = 1\n",
    })
    const refused = await buildRefuses(root, "lib/client.tsx")
    expect(refused).toEqual(["lib/client.tsx", "lib/fmt.ts", "lib/pad.ts"])

    const found = await zoneFindings(root)
    const named = new Set(found.map((f) => /"([^"]+)" is in no zone/.exec(f.message)?.[1]))
    // The browser half matches the build; the server build refuses the unzoned backend import too.
    expect([...named].sort()).toEqual([...refused, "server/session.ts"])
    expect(found.map((f) => f.at)).toEqual([
      "lib/client.tsx:1",
      "lib/fmt.ts:1",
      "nifra.config.ts:1",
      "routes/index.backend.ts:1",
      "routes/index.tsx:1",
    ])
    expect(found[2]?.message).toStartWith(
      'clientModule "./lib/client.tsx" puts lib/client.tsx in the browser bundle: "lib/client.tsx" is in no zone',
    )
  })

  test("both pass once the same files are zoned", async () => {
    const root = app({
      "nifra.config.ts": 'export const clientModule = "./frontend/client.tsx"\n',
      "frontend/client.tsx":
        'import { fmt } from "~/shared/fmt"\nexport function mountRouter() {\n  return fmt(1)\n}\n',
      "shared/fmt.ts":
        'import { pad } from "~/shared/pad"\nexport const fmt = (n: number) => pad(String(n))\n',
      "shared/pad.ts": "export const pad = (s: string) => s.padStart(2)\n",
      "routes/index.tsx": 'import { fmt } from "~/shared/fmt"\nexport default () => fmt(1)\n',
      "routes/index.backend.ts":
        'import { session } from "~/backend/session"\nexport const loader = () => session\n',
      "backend/session.ts": "export const session = 1\n",
    })
    expect(await buildRefuses(root, "frontend/client.tsx")).toEqual([])
    expect(await zoneFindings(root)).toEqual([])
  })

  test("a clientModule in backend code is refused at the config line", async () => {
    const root = app({
      "nifra.config.ts":
        '// the browser entry\nexport const clientModule = "./backend/client.tsx"\n',
      "backend/client.tsx": "export function mountRouter() {}\n",
      "routes/index.tsx": "export default () => 1\n",
    })
    expect(await buildRefuses(root, "backend/client.tsx")).toEqual(["backend/client.tsx"])
    const found = await zoneFindings(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.at).toBe("nifra.config.ts:2")
    expect(found[0]?.message).toStartWith(
      'clientModule "./backend/client.tsx" puts backend/client.tsx in the browser bundle: it is backend code',
    )
  })
})

describe("NF-C004 follows aliases and the clientModule", () => {
  test("a backend import through a tsconfig alias or a package.json import is a chain", async () => {
    const root = app({
      "package.json": JSON.stringify({ name: "app", imports: { "#db": "./backend/db.ts" } }),
      "nifra.config.ts": 'export const clientModule = "./lib/client.tsx"\n',
      "lib/client.tsx": 'import { query } from "#db"\nexport function mountRouter() {}\n',
      "backend/db.ts": "export const query = () => 1\n",
      "frontend/data.ts": 'import { query } from "~/backend/db"\nexport const rows = query\n',
      "routes/index.tsx": 'import { rows } from "~/frontend/data"\nexport default () => rows()\n',
    })
    const chains = (await collectCheckResult(root, { lintsOnly: true })).diagnostics
      .filter((d) => d.rule === "server-only-import")
      .map((d) => d.chain)
    expect(chains).toEqual([
      ["frontend/data.ts", "~/backend/db"],
      ["lib/client.tsx", "#db"],
      ["routes/index.tsx", "~/frontend/data", "~/backend/db"],
    ])
  })
})

describe("a package that gives each entry its own side", () => {
  /** An app linked to `split-kit`, whose root and `./react` entry share one file. */
  function kitApp(files: Record<string, string>): string {
    const kit = createFixtureProject(parent, "split-kit-")
    writeAppFile(
      kit,
      "package.json",
      JSON.stringify({
        name: "split-kit",
        type: "module",
        exports: { ".": "./index.ts", "./react": "./index.ts", "./extra": "./extra.ts" },
        nifra: { environment: { ".": "backend", "./react": "frontend" } },
      }),
    )
    writeAppFile(kit, "index.ts", "export const secret = 1\nexport const view = 2\n")
    writeAppFile(kit, "extra.ts", "export const extra = 3\n")
    const root = app(files)
    mkdirSync(join(root, "node_modules"), { recursive: true })
    symlinkSync(kit, join(root, "node_modules/split-kit"), "dir")
    return root
  }

  test("check and build refuse the same entries", async () => {
    const root = kitApp({
      "frontend/client.tsx": "export function mountRouter() {}\n",
      "routes/index.tsx": 'import { secret } from "split-kit"\nexport default () => secret\n',
      "routes/extra.tsx": 'import { extra } from "split-kit/extra"\nexport default () => extra\n',
      "backend/mail.ts": 'import { view } from "split-kit/react"\nexport const mail = view\n',
    })
    const findings = (await zoneFindings(root)).map(({ at, message }) => `${at} ${message}`)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toContain(
      "backend/mail.ts:1 backend/mail.ts (backend code) imports split-kit/react (frontend code): backend code may not import frontend code",
    )
    expect(findings[1]).toContain(
      'routes/extra.tsx:1 routes/extra.tsx imports split-kit/extra: "split-kit/extra" names the "./extra" entry of package "split-kit"',
    )
    const chains = (await collectCheckResult(root, { lintsOnly: true })).diagnostics
      .filter((d) => d.rule === "server-only-import")
      .map((d) => d.chain)
    expect(chains).toEqual([["routes/index.tsx", "split-kit"]])
    const refused = await buildRefuses(root, "frontend/client.tsx")
    expect(refused.map((file) => basename(file))).toEqual(["extra.ts", "index.ts"])
  })

  test("both pass when each side imports its own entry", async () => {
    const root = kitApp({
      "frontend/client.tsx": "export function mountRouter() {}\n",
      "routes/index.tsx": 'import { view } from "split-kit/react"\nexport default () => view\n',
      "backend/data.ts": 'import { secret } from "split-kit"\nexport const data = secret\n',
    })
    expect(await zoneFindings(root)).toEqual([])
    expect(
      (await collectCheckResult(root, { lintsOnly: true })).diagnostics.filter(
        (d) => d.rule === "server-only-import",
      ),
    ).toEqual([])
    expect(await buildRefuses(root, "frontend/client.tsx")).toEqual([])
  })
})

describe("clientModuleRoot", () => {
  test("reads the config the loader reads, and names the file the build loads", () => {
    const root = app({
      "web/nifra.config.ts": "export const clientModule = pick()\n",
      "web/backend/framework.ts": 'export const clientModule = "./lib/client.tsx"\n',
      "web/lib/client.tsx": "export function mountRouter() {}\n",
      "api/backend/framework.ts":
        "/* entry */\nexport const clientModule: string = '~/api/lib/client'\n",
      "api/lib/client.tsx": "export function mountRouter() {}\n",
      "pkg/backend/framework.ts": 'export const clientModule = "@nifrajs/web-react/client"\n',
    })
    const resolve = createSpecifierResolver()
    expect(appDirs(["web/nifra.config.ts", "api/backend/framework.ts", "nifra.config.ts"])).toEqual(
      ["web", "api", ""],
    )
    // `nifra.config.ts` exists, so `backend/framework.ts` is never read, even when the first names
    // no literal path.
    expect(clientModuleRoot(root, "web", resolve)).toBeUndefined()
    expect(clientModuleRoot(root, "api", resolve)).toEqual({
      config: "api/backend/framework.ts",
      line: 2,
      specifier: "~/api/lib/client",
      file: join(realpathSync(root), "api/lib/client.tsx"),
    })
    expect(clientModuleRoot(root, "pkg", resolve)).toBeUndefined()
    expect(clientModuleRoot(root, "missing", resolve)).toBeUndefined()
  })

  test("with the compiler, a path joined onto the config's folder names its file too", () => {
    const root = app({
      "web/nifra.config.ts": [
        'import { resolve as from } from "node:path"',
        "",
        'export const clientModule = from(import.meta.dir, "src/browser-main.tsx")',
        "",
      ].join("\n"),
      "web/src/browser-main.tsx": "export function mountRouter() {}\n",
      "own/nifra.config.ts": [
        "const resolve = (...parts: string[]) => parts.join('/')",
        'export const clientModule = resolve(import.meta.dir, "src/browser-main.tsx")',
        "",
      ].join("\n"),
      "own/src/browser-main.tsx": "export function mountRouter() {}\n",
      "lit/nifra.config.ts": 'export const clientModule = "./src/browser-main.tsx" as const\n',
      "lit/src/browser-main.tsx": "export function mountRouter() {}\n",
    })
    const resolve = createSpecifierResolver()
    expect(clientModuleRoot(root, "web", resolve, ts)).toEqual({
      config: "web/nifra.config.ts",
      line: 3,
      specifier: "src/browser-main.tsx",
      file: join(realpathSync(root), "web/src/browser-main.tsx"),
    })
    // Without the compiler only a literal reads; a `resolve` that is not node:path's never does.
    expect(clientModuleRoot(root, "web", resolve)).toBeUndefined()
    expect(clientModuleRoot(root, "own", resolve, ts)).toBeUndefined()
    expect(clientModuleRoot(root, "lit", resolve, ts)?.file).toBe(
      join(realpathSync(root), "lit/src/browser-main.tsx"),
    )
  })
})

describe("NF-C028 and an anchored clientModule", () => {
  test("check reads the entry as browser code, as the build does", async () => {
    const root = app({
      "nifra.config.ts": [
        'import { resolve } from "node:path"',
        'export const clientModule = resolve(import.meta.dir, "src/client.tsx")',
        "",
      ].join("\n"),
      "src/client.tsx":
        'import { session } from "../backend/session"\nexport function mountRouter() {\n  return session\n}\n',
      "backend/session.ts": "export const session = 1\n",
      "routes/index.tsx": "export default () => null\n",
    })
    const found = await zoneFindings(root)
    expect(found.map((f) => f.at)).toEqual(["nifra.config.ts:2"])
    expect(found[0]?.message).toContain("puts src/client.tsx in the browser bundle")
    expect(await buildRefuses(root, "src/client.tsx")).toContain("src/client.tsx")
  })
})

describe("nifra migrate layout", () => {
  test("moves an aliased app into zones that both check and build accept", async () => {
    const root = app({
      "nifra.config.ts": 'export const clientModule = "./lib/client.tsx"\n',
      "lib/client.tsx":
        'import { fmt } from "~/lib/fmt"\nexport function mountRouter() {\n  return fmt(1)\n}\n',
      "lib/fmt.ts":
        'import { pad } from "~/lib/pad"\nexport const fmt = (n: number) => pad(String(n))\n',
      "lib/pad.ts": "export const pad = (s: string) => s.padStart(2)\n",
      "server/session.ts": "export const session = 1\n",
      "routes/index.tsx": [
        'import { fmt } from "~/lib/fmt"',
        'import { session } from "~/server/session"',
        "export const loader = () => ({ n: session })",
        "export default () => fmt(1)",
        "",
      ].join("\n"),
    })
    expect(await buildRefuses(root, "lib/client.tsx")).not.toEqual([])
    const result = await migrateLayout(root, { typescript: ts, write: true })
    expect(result.moves.map((move) => `${move.from} -> ${move.to}`)).toEqual([
      "lib/client.tsx -> frontend/lib/client.tsx",
      "lib/fmt.ts -> frontend/lib/fmt.ts",
      "lib/pad.ts -> frontend/lib/pad.ts",
      "server/session.ts -> backend/server/session.ts",
    ])
    expect(await buildRefuses(root, "frontend/lib/client.tsx")).toEqual([])
    expect(await zoneFindings(root)).toEqual([])
  })

  test("an alias narrower than the zones is rewritten so check and build accept the result", async () => {
    const root = app({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "nifra.config.ts": 'export const clientModule = "./src/client.tsx"\n',
      "src/client.tsx":
        'import { api } from "@/lib/api"\nexport function mountRouter() {\n  return api\n}\n',
      "src/lib/api.ts":
        'import { type Row } from "@/data/rows"\nexport const api: Row = { id: 1 }\n',
      "src/data/rows.ts":
        'import { api } from "@/lib/api"\nexport type Row = { id: number }\nexport const rows = [api]\n',
      "routes/index.tsx": [
        'import { api } from "@/lib/api"',
        'import { rows } from "@/data/rows"',
        "export const loader = () => ({ rows })",
        "export default () => api.id",
        "",
      ].join("\n"),
    })
    const result = await migrateLayout(root, { typescript: ts, write: true })
    expect(result.moves.map((move) => `${move.from} -> ${move.to}`)).toEqual([
      "src/client.tsx -> frontend/src/client.tsx",
      "src/data/rows.ts -> backend/src/data/rows.ts",
      "src/lib/api.ts -> shared/src/lib/api.ts",
    ])
    expect(result.issues.filter((issue) => /alias|reaches/.test(issue.reason))).toEqual([])
    expect(await buildRefuses(root, "frontend/src/client.tsx")).toEqual([])
    // The shared module's type-only import of backend code is erased, so it is no zone edge.
    expect(await zoneFindings(root)).toEqual([])
  })

  test("a split route's shared data and its backend's type-only reads pass check and build", async () => {
    const root = app({
      "nifra.config.ts": 'export const clientModule = "./lib/client.tsx"\n',
      "lib/client.tsx": "export function mountRouter() {\n  return 1\n}\n",
      "components/card.tsx":
        "export type CardProps = { n: number }\nexport const Card = (props: CardProps) => props.n\n",
      "routes/guides/[slug].tsx": [
        'import { Card, type CardProps } from "~/components/card"',
        "const GUIDES = { a: 'A', b: 'B' } as const",
        "export const GUIDE_KEYS = Object.keys(GUIDES)",
        "export async function getStaticPaths() {",
        "  return { paths: GUIDE_KEYS.map((slug) => ({ params: { slug } })), fallback: false }",
        "}",
        "export async function loader(): Promise<CardProps> {",
        "  return { n: GUIDE_KEYS.length }",
        "}",
        "export default function Page() { return Card({ n: GUIDE_KEYS.length }) }",
        "",
      ].join("\n"),
    })
    const result = await migrateLayout(root, { typescript: ts, write: true })
    expect(result.splits.map((split) => split.shared)).toEqual(["routes/guides/[slug].shared.ts"])
    expect(readFileSync(join(root, "routes/guides/[slug].backend.ts"), "utf8")).toContain(
      'import type { CardProps } from "~/frontend/components/card"',
    )
    expect(await zoneFindings(root)).toEqual([])
    expect(await buildRefuses(root, "frontend/lib/client.tsx")).toEqual([])
  })
})

describe("a module both sides import may be declared shared where it lives", () => {
  // A build-time script under backend/ evaluating an import-free table the pages also use.
  const files = (rates: string, extra: Record<string, string> = {}): Record<string, string> => ({
    "nifra.config.ts": 'export const clientModule = "./frontend/client.tsx"\n',
    "frontend/client.tsx": "export function mountRouter() {}\n",
    "frontend/lib/rates.ts": rates,
    "frontend/lib/format.ts": "export const percent = (n: number) => String(n)\n",
    "routes/index.tsx":
      'import { rates } from "~/frontend/lib/rates"\nexport default () => rates.length\n',
    "backend/check-rates.ts":
      'import { rates } from "~/frontend/lib/rates"\nexport const ok = rates.every((r) => r > 0)\n',
    ...extra,
  })
  const IMPORT_FREE = "export const rates = [5, 12, 18]\n"

  test("NF-C028 says the module can be shared in place, and how", async () => {
    const [finding] = await zoneFindings(app(files(IMPORT_FREE)))
    expect(finding?.at).toBe("backend/check-rates.ts:1")
    expect(finding?.message).toEndWith(
      '. frontend/lib/rates.ts imports only shared code and packages, so it can be shared where it is: rename it rates.shared.ts, or list "frontend/lib/rates.ts" under "nifra": { "zones": { "shared": [...] } } in package.json',
    )
  })

  test("NF-C028 names what stops a module from being shared", async () => {
    const importing = 'import { percent } from "./format"\nexport const rates = [percent(5)]\n'
    const [finding] = await zoneFindings(app(files(importing)))
    expect(finding?.message).toEndWith(
      ". frontend/lib/rates.ts cannot be shared as it is: it imports frontend/lib/format.ts (frontend code); move what both sides need into shared/",
    )
    const reading = "export const rates = [Number(process.env.RATE_SECRET)]\n"
    const [envFinding] = await zoneFindings(app(files(reading)))
    expect(envFinding?.message).toContain(
      "cannot be shared as it is: it reads process.env.RATE_SECRET",
    )
  })

  test("a shared zones entry inside frontend/ passes check and build, and changes no import", async () => {
    const root = app(
      files(IMPORT_FREE, {
        "package.json": JSON.stringify({ nifra: { zones: { shared: ["frontend/lib/rates.ts"] } } }),
      }),
    )
    expect(await zoneFindings(root)).toEqual([])
    expect(await buildRefuses(root, "frontend/client.tsx")).toEqual([])
  })

  test("a .shared suffix inside frontend/ is the same declaration", async () => {
    const root = app({
      ...files(IMPORT_FREE),
      "frontend/lib/rates.shared.ts": IMPORT_FREE,
      "routes/index.tsx":
        'import { rates } from "~/frontend/lib/rates.shared"\nexport default () => rates.length\n',
      "backend/check-rates.ts":
        'import { rates } from "~/frontend/lib/rates.shared"\nexport const ok = rates.length > 0\n',
    })
    expect(await zoneFindings(root)).toEqual([])
  })

  test("declared shared, the module is held to the shared rules: verified, not trusted", async () => {
    const root = app(
      files('import { percent } from "./format"\nexport const rates = [percent(5)]\n', {
        "package.json": JSON.stringify({ nifra: { zones: { shared: ["frontend/lib/rates.ts"] } } }),
      }),
    )
    const found = await zoneFindings(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.at).toBe("frontend/lib/rates.ts:1")
    expect(found[0]?.message).toContain(
      "shared code runs on both sides, so it may import only shared code",
    )
  })
})
