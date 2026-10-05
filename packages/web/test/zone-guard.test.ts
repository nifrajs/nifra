import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { buildClient, zoneGuardPlugin } from "../src/build.ts"
import {
  accountEmittedFiles,
  bunModuleSource,
  verifyClientGraph,
} from "../src/internal/zone-graph.ts"
import type { ClientModuleGraph } from "../src/module-graph.ts"
import { createZoneClassifier } from "../src/zones.ts"

// The browser build refuses anything the zones keep on the server, names the import chain, and writes
// nothing when it refuses. Temp apps live inside the workspace so `@nifrajs/*` imports resolve.
const TMP = `${import.meta.dir}/.tmp-zone-guard-`
let root: string

const write = (path: string, text: string): string => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

const build = () =>
  buildClient({
    routesDir: join(root, "routes"),
    outDir: join(root, "dist"),
    clientModule: join(root, "frontend/client-stub.ts"),
    publicDir: false,
    minify: false,
  })

/** The build's rejection message; fails the test when the build passes. */
async function refusal(): Promise<string> {
  try {
    await build()
  } catch (error) {
    expect(existsSync(join(root, "dist")) ? readdirSync(join(root, "dist")) : []).toEqual([])
    return (error as Error).message
  }
  throw new Error("the build passed")
}

beforeEach(() => {
  root = mkdtempSync(TMP)
  write("frontend/client-stub.ts", "export function mountRouter() {}\n")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("buildClient refuses", () => {
  test("backend code a route imports, with the chain", async () => {
    write("backend/db.ts", 'export const query = () => "SELECT secret"\n')
    write("shared/data.ts", 'import { query } from "../backend/db.ts"\nexport const rows = query\n')
    write(
      "routes/index.tsx",
      'import { rows } from "../shared/data.ts"\nexport default () => rows()\n',
    )
    const message = await refusal()
    expect(message).toContain("backend/db.ts: it is backend code")
    expect(message).toContain("via routes/index.tsx → ../shared/data.ts → ../backend/db.ts")
  })

  test("a route's own backend half", async () => {
    write("routes/index.backend.ts", "export const loader = () => ({ secret: 1 })\n")
    write(
      "routes/index.tsx",
      'import { loader } from "./index.backend.ts"\nexport default () => String(loader)\n',
    )
    expect(await refusal()).toContain(
      "routes/index.backend.ts: it is a route's backend half, which runs on the server only",
    )
  })

  test("backend code behind a lazy import()", async () => {
    write("backend/report.ts", "export const report = 1\n")
    write(
      "routes/index.tsx",
      'export const later = () => import("../backend/report.ts")\nexport default () => null\n',
    )
    const message = await refusal()
    expect(message).toContain("backend/report.ts: it is backend code")
    expect(message).toContain("via routes/index.tsx → ../backend/report.ts")
  })

  test("a file in no zone", async () => {
    write("lib/helpers.ts", "export const help = 1\n")
    write(
      "routes/index.tsx",
      'import { help } from "../lib/helpers.ts"\nexport default () => help\n',
    )
    expect(await refusal()).toContain('"lib/helpers.ts" is in no zone')
  })

  test("a legacy .server module instead of emptying it", async () => {
    write("frontend/db.server.ts", "export const db = 1\n")
    write(
      "routes/index.tsx",
      'import { db } from "../frontend/db.server.ts"\nexport default () => db\n',
    )
    expect(await refusal()).toContain('retired ".server" suffix')
  })

  test("a server package and a database driver entry", async () => {
    write("node_modules/pg/package.json", '{ "name": "pg", "main": "index.js" }\n')
    write("node_modules/pg/index.js", "export const Pool = class {}\n")
    write("node_modules/drizzle-orm/package.json", '{ "name": "drizzle-orm" }\n')
    write("node_modules/drizzle-orm/index.js", "export const sql = 1\n")
    write("node_modules/drizzle-orm/node-postgres/index.js", "export const drizzle = 1\n")
    write(
      "routes/index.tsx",
      'import { Pool } from "pg"\nimport { sql } from "drizzle-orm"\nimport { drizzle } from "drizzle-orm/node-postgres"\nexport default () => [Pool, sql, drizzle]\n',
    )
    const message = await refusal()
    expect(message).toContain('package "pg" is server code')
    expect(message).toContain('"drizzle-orm/node-postgres" is a database driver entry')
    expect(message).not.toContain("drizzle-orm/index.js")
  })

  test("a workspace package that declares itself backend", async () => {
    const pkg = mkdtempSync(`${import.meta.dir}/.tmp-zone-guard-pkg-`)
    try {
      writeFileSync(
        join(pkg, "package.json"),
        '{ "name": "@ws/db", "main": "index.ts", "nifra": { "environment": "backend" } }\n',
      )
      writeFileSync(join(pkg, "index.ts"), "export const db = 1\n")
      mkdirSync(join(root, "node_modules/@ws"), { recursive: true })
      symlinkSync(pkg, join(root, "node_modules/@ws/db"))
      write("routes/index.tsx", 'import { db } from "@ws/db"\nexport default () => db\n')
      expect(await refusal()).toContain("index.ts: it is backend code")
    } finally {
      rmSync(pkg, { recursive: true, force: true })
    }
  })

  test("a backend asset", async () => {
    write("backend/private.png", "\x89PNG")
    write(
      "routes/index.tsx",
      'import url from "../backend/private.png"\nexport default () => url\n',
    )
    expect(await refusal()).toContain("backend/private.png: it is backend code")
  })

  test("browser code reading a private environment variable, shared/ included", async () => {
    write("shared/config.ts", "export const db = Bun.env.DATABASE_URL\n")
    write(
      "routes/index.tsx",
      [
        'import { db } from "../shared/config.ts"',
        "export default () => [db, process.env.PUBLIC_API, process.env.NODE_ENV]",
        "",
      ].join("\n"),
    )
    expect(await refusal()).toContain(
      "shared/config.ts: it reads private environment variable Bun.env.DATABASE_URL",
    )
  })

  test("a backend-only export in a route's frontend file", async () => {
    write("routes/index.tsx", "export const loader = () => 1\nexport default () => null\n")
    expect(await refusal()).toContain(
      '"routes/index.tsx" exports "loader", which runs on the server only. Move it to "routes/index.backend.ts"',
    )
  })
})

describe("buildClient builds", () => {
  test("zoned browser code, a backend half it never imports, and a server function stub", async () => {
    write("frontend/Button.tsx", "export const Button = () => 'button'\n")
    write("shared/format.ts", "export const format = (n: number) => n.toFixed(2)\n")
    write("backend/db.ts", 'export const secret = "do-not-ship"\n')
    write(
      "backend/notes.fn.ts",
      'import { serverFn } from "@nifrajs/web/fn"\nimport { secret } from "./db.ts"\nexport const getNote = serverFn(async () => secret)\n',
    )
    write(
      "routes/index.backend.ts",
      'import { secret } from "../backend/db.ts"\nexport const loader = () => secret\n',
    )
    write(
      "routes/index.tsx",
      'import { Button } from "../frontend/Button.tsx"\nimport { format } from "../shared/format.ts"\nimport { getNote } from "../backend/notes.fn.ts"\nexport default () => [Button(), format(1), getNote]\n',
    )
    const manifest = await build()
    expect(manifest.routes.index?.length).toBe(1)
    const text = await Promise.all(
      readdirSync(join(root, "dist"))
        .filter((file) => file.endsWith(".js"))
        .map((file) => Bun.file(join(root, "dist", file)).text()),
    )
    expect(text.join("\n")).not.toContain("do-not-ship")
  })
})

describe("zoneGuardPlugin in throw mode (dev)", () => {
  const bundle = (entry: string) =>
    Bun.build({
      entrypoints: [entry],
      target: "browser",
      throw: false,
      plugins: [zoneGuardPlugin({ appRoot: root })],
    } as Parameters<typeof Bun.build>[0])

  test("stops on a backend file", async () => {
    write("backend/db.ts", "export const q = 1\n")
    const result = await bundle(
      write("routes/index.tsx", 'import { q } from "../backend/db.ts"\nexport default q\n'),
    )
    expect(result.success).toBe(false)
    expect(result.logs.map(String).join("\n")).toContain(
      "backend/db.ts may not reach the browser: it is backend code",
    )
  })

  test("stops on a Node built-in and on the backend-only marker, naming the importer", async () => {
    const node = await bundle(write("routes/a.tsx", 'import "node:fs"\nexport default 1\n'))
    expect(node.logs.map(String).join("\n")).toContain("(imported by routes/a.tsx)")
    write("shared/key.ts", 'import "@nifrajs/web/backend-only"\nexport const key = 1\n')
    const marker = await bundle(
      write("routes/b.tsx", 'import { key } from "../shared/key.ts"\nexport default key\n'),
    )
    expect(marker.logs.map(String).join("\n")).toContain(
      'shared/key.ts may not reach the browser: it imports "@nifrajs/web/backend-only"',
    )
  })

  test("stops on a private environment read", async () => {
    const result = await bundle(
      write("routes/env.tsx", "export default () => import.meta.env.SESSION_SECRET\n"),
    )
    expect(result.logs.map(String).join("\n")).toContain(
      "routes/env.tsx may not reach the browser: it reads private environment variable import.meta.env.SESSION_SECRET",
    )
  })

  // A path `onResolve` filter that matches the dev probe page's `<script src>` makes Bun's dev server
  // key that page's import by its raw specifier, and the client never boots - even when the handler
  // declines. The browser-level proof is packages/cli/test/bun-dev-browser-boot.
  test("no path resolve filter matches a source file, so the dev entry script stays Bun's", () => {
    const filters: RegExp[] = []
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the guard's setup calls only onResolve and onLoad, both present
    zoneGuardPlugin({ appRoot: root }).setup({
      onResolve: ({ filter }: { filter: RegExp }) => filters.push(filter),
      onLoad: () => undefined,
    } as never)
    const matches = (specifier: string): boolean => filters.some((filter) => filter.test(specifier))
    for (const specifier of [
      "./entry.tsx",
      "../routes/index.tsx",
      "/abs/app/frontend/x.module.css",
      "./query.ts?raw",
      "../backend/db.ts#frag",
    ]) {
      expect(matches(specifier), specifier).toBe(false)
    }
    for (const specifier of [
      "./logo.png",
      "../backend/query.sql",
      "../backend/key.pem?v=1",
      "./a.ts/b.wasm",
    ]) {
      expect(matches(specifier), specifier).toBe(true)
    }
  })
})

describe("graph evidence", () => {
  const classifier = () => createZoneClassifier({ appRoot: root })
  const graph = (overrides: Partial<ClientModuleGraph> = {}): ClientModuleGraph => ({
    modules: { "routes/index.tsx": { imports: [] } },
    chunks: { "./index-a.js": { entryPoint: "routes/index.tsx", modules: ["routes/index.tsx"] } },
    ...overrides,
  })
  const verify = (g: ClientModuleGraph) =>
    verifyClientGraph(g, { classifier: classifier(), sourceOf: bunModuleSource(root) })

  test("an external import other than an own chunk or a URL is a gap", () => {
    const verdict = verify(
      graph({
        modules: {
          "routes/index.tsx": {
            imports: [
              { path: "pg", original: "pg", external: true },
              {
                path: "https://cdn.example/x.js",
                original: "https://cdn.example/x.js",
                external: true,
              },
            ],
          },
        },
      }),
    )
    expect(verdict.gaps).toEqual([
      'routes/index.tsx imports "pg", which the bundle left external: browser output may import only its own chunks',
    ])
  })

  test("once outputs report their imports, those decide: a dropped module edge is not a gap", () => {
    const verdict = verify(
      graph({
        modules: {
          "routes/index.tsx": { imports: [{ path: "./cookie.ts", external: true }] },
          "routes/about.tsx": { imports: [] },
        },
        chunks: {
          "./index-a.js": {
            entryPoint: "routes/index.tsx",
            modules: ["routes/index.tsx"],
            imports: ["chunk-b.js", "node:fs", "https://cdn.example/x.js"],
          },
          "./chunk-b.js": { modules: ["routes/about.tsx"], imports: ["./backend/db.ts"] },
        },
      }),
    )
    expect(verdict.gaps).toEqual([
      'chunk-b.js imports "./backend/db.ts", which is not one of the build\'s own outputs: browser output may import only its own chunks',
    ])
  })

  test("the Bun build reads chunk imports from the code: a tree-shaken re-export is no gap", async () => {
    write(
      "node_modules/barrel/package.json",
      JSON.stringify({ name: "barrel", type: "module", sideEffects: false, main: "index.js" }),
    )
    write(
      "node_modules/barrel/index.js",
      'export { used } from "./used.js"\nexport { unused } from "./unused.js"\n',
    )
    write("node_modules/barrel/used.js", "export const used = 1\n")
    write("node_modules/barrel/unused.js", "export const unused = 2\n")
    write("frontend/lazy.ts", "export const lazy = 1\n")
    write(
      "routes/index.tsx",
      'import { used } from "barrel"\nexport default function Page() { return [used, import("../frontend/lazy.ts")] }\n',
    )
    await expect(build()).resolves.toBeDefined()
  })

  test("a chunk holding a module the graph does not describe is a gap", () => {
    const verdict = verify(
      graph({
        chunks: {
          "./index-a.js": {
            entryPoint: "routes/index.tsx",
            modules: ["routes/index.tsx", "backend/ghost.ts"],
          },
        },
      }),
    )
    expect(verdict.gaps[0]).toContain("contains backend/ghost.ts")
  })

  test("every emitted file traces back to the graph, and maps name browser code only", () => {
    write("routes/index.tsx", "export default 1\n")
    write("backend/db.ts", "export const q = 1\n")
    const g = graph({
      modules: { "routes/index.tsx": { imports: [] }, "frontend/logo.png": { imports: [] } },
    })
    write("frontend/logo.png", "png")
    const inline = Buffer.from(JSON.stringify({ sources: ["../backend/db.ts"] })).toString("base64")
    const problems = accountEmittedFiles(
      [
        { name: "./index-a.js", kind: "code", text: "x" },
        { name: "./stray-b.js", kind: "code", text: "x" },
        { name: "./logo-12345678.png", kind: "asset" },
        { name: "./other-12345678.png", kind: "asset" },
        {
          name: "./index-a.js.map",
          kind: "map",
          text: JSON.stringify({ sources: ["../backend/db.ts"] }),
        },
        {
          name: "./index-a.js",
          kind: "code",
          text: `x\n//# sourceMappingURL=data:application/json;base64,${inline}`,
        },
      ],
      g,
      { classifier: classifier(), sourceOf: bunModuleSource(root), outDir: join(root, "dist") },
    )
    expect(problems).toEqual([
      "./stray-b.js is in the output but not in the module graph",
      "./other-12345678.png was emitted, but no module in the graph accounts for it",
      "./index-a.js.map names backend/db.ts: it is backend code",
      "./index-a.js's inline source map names backend/db.ts: it is backend code",
    ])
  })
})
