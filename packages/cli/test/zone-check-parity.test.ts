import { afterAll, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { buildClient } from "@nifrajs/web/build"
import { collectCheckResult } from "../src/check.ts"
import { appDirs, clientModuleRoot } from "../src/client-module.ts"
import { createSpecifierResolver } from "../src/internal/project-specifiers.ts"
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
    const refused = [...message.matchAll(/^ {2}- ([^:\n]+): /gm)].map((match) => match[1] ?? "")
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
})
