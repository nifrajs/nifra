import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { buildClient, buildServer, serverFnStubPlugin, zoneGuardPlugin } from "../src/build.ts"
import { buildClientVite } from "../src/build-vite.ts"
import { createDevDiagnostics } from "../src/dev-diagnostics.ts"
import { createViteDevServer } from "../src/vite.ts"

/**
 * The leak matrix: every way server code or a credential can reach a browser, against every place that
 * must stop it - the Bun and Vite client builds, the Bun dev bundler, the Vite dev server and the
 * server build. A refusal is asserted by its message, never by a marker's absence: a broken import that
 * silently became `undefined` leaves no marker either. `null` means the pipeline must pass.
 *
 * Framework-specific route syntax (React, Preact, Solid, Svelte, Vue, MDX) has its rows in
 * `examples/leak-matrix/frameworks.test.ts`, and each deploy target's output in `leak-deploy.test.ts`;
 * `bun run check:leak-matrix` runs them all.
 */

type Pipeline = "bun-build" | "vite-build" | "bun-dev" | "vite-dev" | "server-build"
const PIPELINES: readonly Pipeline[] = [
  "bun-build",
  "vite-build",
  "bun-dev",
  "vite-dev",
  "server-build",
]

interface LeakPath {
  readonly name: string
  readonly files: Readonly<Record<string, string>>
  /** The message each pipeline must fail with; `null` = it must pass; absent = not applicable. */
  readonly expect: Partial<Record<Pipeline, string | null>>
  /** Vite plugins for both Vite pipelines. */
  readonly vitePlugins?: (app: string) => unknown[]
  /** Workspace packages outside the app, linked into its `node_modules`. */
  readonly workspace?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

const BACKEND_MARKER = "nifra-leak-matrix-backend-source"
const FN_MARKER = "nifra-leak-matrix-fn-body"
// Assembled at runtime so this file carries no credential-shaped literal.
const STRIPE = ["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("")

const PAGE = (imports: string, body = "null"): string =>
  `${imports}\nexport default function Page() { return ${body} }\n`
const DB = { "backend/db.ts": `export const rows = () => ["${BACKEND_MARKER}"]\n` }
const PG = {
  "node_modules/pg/package.json": '{ "name": "pg", "type": "module", "main": "index.js" }',
  "node_modules/pg/index.js": "export class Pool {}\n",
}

const ROWS: readonly LeakPath[] = [
  {
    name: "a page importing backend code",
    files: { ...DB, "routes/index.tsx": PAGE('import { rows } from "../backend/db.ts"', "rows()") },
    expect: {
      "bun-build": "backend/db.ts: it is backend code",
      "vite-build": "backend/db.ts: it is backend code",
      "bun-dev": "backend/db.ts may not reach the browser: it is backend code",
      "vite-dev": "backend/db.ts may not reach the browser (imported by routes/index.tsx)",
      "server-build": "frontend code may not import backend code",
    },
  },
  {
    name: "a page importing its own backend half",
    files: {
      "routes/index.backend.ts": `export const loader = () => "${BACKEND_MARKER}"\n`,
      "routes/index.tsx": PAGE('import { loader } from "./index.backend.ts"', "String(loader)"),
    },
    expect: {
      "bun-build": "routes/index.backend.ts: it is a route's backend half",
      "vite-build": "routes/index.backend.ts: it is a route's backend half",
      "bun-dev": "routes/index.backend.ts may not reach the browser: it is a route's backend half",
      "vite-dev": "routes/index.backend.ts may not reach the browser",
      "server-build": "frontend code may not import backend code",
    },
  },
  {
    name: "a side-effect import of backend code",
    files: { ...DB, "routes/index.tsx": PAGE('import "../backend/db.ts"') },
    expect: {
      "bun-build": "backend/db.ts: it is backend code",
      "vite-build": "backend/db.ts: it is backend code",
      "bun-dev": "backend/db.ts may not reach the browser: it is backend code",
      "vite-dev": "backend/db.ts may not reach the browser (imported by routes/index.tsx)",
      "server-build": "frontend code may not import backend code",
    },
  },
  {
    name: "backend code behind a dynamic import()",
    files: {
      ...DB,
      "routes/index.tsx": PAGE("", 'import("../backend/db.ts").then((m) => m.rows())'),
    },
    expect: {
      "bun-build": "backend/db.ts: it is backend code",
      "vite-build": "backend/db.ts: it is backend code",
      "bun-dev": "backend/db.ts may not reach the browser: it is backend code",
      "vite-dev": "backend/db.ts may not reach the browser (imported by routes/index.tsx)",
      "server-build": "frontend code may not import backend code",
    },
  },
  {
    name: "a barrel re-exporting backend code",
    files: {
      ...DB,
      "frontend/index.ts": 'export * from "../backend/db.ts"\n',
      "routes/index.tsx": PAGE('import { rows } from "../frontend/index.ts"', "rows()"),
    },
    expect: {
      "bun-build": "backend/db.ts: it is backend code",
      "vite-build": "backend/db.ts: it is backend code",
      "bun-dev": "backend/db.ts may not reach the browser: it is backend code",
      "vite-dev": "backend/db.ts may not reach the browser (imported by frontend/index.ts)",
      // No server-build row: Bun drops a fully shaken barrel from its metafile with the barrel's own
      // edges, so the server build cannot see this re-export. It ships no browser code; `nifra check`
      // (NF-C028) reads the edge from source.
    },
  },
  {
    name: "a shared helper importing a database driver",
    files: {
      ...PG,
      "shared/db.ts": 'import { Pool } from "pg"\nexport const pool = () => new Pool()\n',
      "routes/index.tsx": PAGE('import { pool } from "../shared/db.ts"', "String(pool)"),
    },
    expect: {
      "bun-build": 'package "pg" is server code',
      "vite-build": 'package "pg" is server code',
      "bun-dev": 'package "pg" is server code',
      "vite-dev": 'package "pg" is server code',
      // Shared code may use a library on the server; the browser builds refuse this one.
      "server-build": null,
    },
  },
  {
    name: "a workspace package that declares itself backend, linked through node_modules",
    workspace: {
      "srv-kit": {
        "package.json":
          '{ "name": "srv-kit", "type": "module", "main": "index.ts", "nifra": { "environment": "backend" } }',
        "index.ts": `export const secret = "${BACKEND_MARKER}"\n`,
      },
    },
    files: { "routes/index.tsx": PAGE('import { secret } from "srv-kit"', "secret") },
    expect: {
      "bun-build": "it is backend code",
      "vite-build": "it is backend code",
      "bun-dev": "it is backend code",
      "vite-dev": "may not reach the browser",
      "server-build": "frontend code may not import backend code",
    },
  },
  {
    name: "an alias to backend code (tsconfig paths for Bun, resolve.alias for Vite)",
    files: {
      ...DB,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@server/*": ["./backend/*"] } },
      }),
      "routes/index.tsx": PAGE('import { rows } from "@server/db.ts"', "rows()"),
    },
    vitePlugins: (app) => [
      {
        name: "test-alias",
        config: () => ({ resolve: { alias: { "@server": join(app, "backend") } } }),
      },
    ],
    expect: {
      "bun-build": "backend/db.ts: it is backend code",
      "vite-build": "backend/db.ts: it is backend code",
      "bun-dev": "backend/db.ts may not reach the browser: it is backend code",
      "vite-dev": "backend/db.ts may not reach the browser (imported by routes/index.tsx)",
    },
  },
  {
    name: "a package whose only entry imports a Node built-in",
    files: {
      "node_modules/fs-kit/package.json":
        '{ "name": "fs-kit", "type": "module", "exports": { ".": { "default": "./server.js" } } }',
      "node_modules/fs-kit/server.js":
        'import { readFileSync } from "node:fs"\nexport const read = (p) => readFileSync(p, "utf8")\n',
      "routes/index.tsx": PAGE('import { read } from "fs-kit"', "String(read)"),
    },
    expect: {
      "bun-build": "node:fs",
      "vite-build": "node:fs",
      "bun-dev": "Node and Bun built-ins run on the server only",
    },
  },
  {
    name: "a package with a browser condition resolves to its browser entry",
    files: {
      "node_modules/dual-kit/package.json":
        '{ "name": "dual-kit", "type": "module", "exports": { ".": { "browser": "./browser.js", "default": "./server.js" } } }',
      "node_modules/dual-kit/browser.js": "export const where = () => 'browser'\n",
      "node_modules/dual-kit/server.js":
        'import { hostname } from "node:os"\nexport const where = () => hostname()\n',
      "routes/index.tsx": PAGE('import { where } from "dual-kit"', "where()"),
    },
    expect: { "bun-build": null, "vite-build": null, "bun-dev": null, "vite-dev": null },
  },
  {
    name: "backend source imported as ?raw (Vite)",
    files: {
      ...DB,
      "routes/index.tsx": PAGE('import source from "../backend/db.ts?raw"', "source"),
    },
    expect: {
      "vite-build": "backend/db.ts: it is backend code",
      "vite-dev": "may not reach the browser",
    },
  },
  {
    name: "backend source imported as text (Bun)",
    files: {
      ...DB,
      "routes/index.tsx": PAGE(
        'import source from "../backend/db.ts" with { type: "text" }',
        "source",
      ),
    },
    expect: {
      "bun-build": "backend/db.ts: it is backend code",
      "bun-dev": "backend/db.ts may not reach the browser: it is backend code",
    },
  },
  {
    name: "a worker built from backend code",
    files: {
      "backend/job.ts": `self.postMessage("${BACKEND_MARKER}")\n`,
      "routes/index.tsx": PAGE(
        "",
        'String(new Worker(new URL("../backend/job.ts", import.meta.url), { type: "module" }))',
      ),
    },
    // Bun does not bundle workers, so nothing of the file is emitted (Phase 0).
    expect: { "vite-build": "backend/job.ts: it is backend code" },
  },
  {
    name: "a loader left in the page file",
    files: {
      "routes/index.tsx": PAGE(`export const loader = () => "${BACKEND_MARKER}"`),
    },
    expect: {
      "bun-build": 'exports "loader", which runs on the server only',
      "vite-build": 'exports "loader", which runs on the server only',
    },
  },
  {
    name: "boundary loaders left in the page file",
    files: {
      "routes/index.tsx": PAGE(
        `export const boundaryLoaders = { panel: { load: () => "${BACKEND_MARKER}" } }`,
      ),
    },
    expect: {
      "bun-build": 'exports "boundaryLoaders", which runs on the server only',
      "vite-build": 'exports "boundaryLoaders", which runs on the server only',
    },
  },
  {
    name: "a private environment variable read in shared code",
    files: {
      "shared/config.ts": "export const db = process.env.DATABASE_URL\n",
      "routes/index.tsx": PAGE('import { db } from "../shared/config.ts"', "db"),
    },
    expect: {
      "bun-build": "it reads private environment variable process.env.DATABASE_URL",
      "vite-build": "it reads private environment variable process.env.DATABASE_URL",
      "bun-dev": "it reads private environment variable process.env.DATABASE_URL",
      "vite-dev": "it reads private environment variable process.env.DATABASE_URL",
      "server-build": "it reads private environment variable process.env.DATABASE_URL",
    },
  },
  {
    name: "a credential typed into frontend code",
    files: {
      "frontend/pay.ts": `export const key = "${STRIPE}"\n`,
      "routes/index.tsx": PAGE('import { key } from "../frontend/pay.ts"', "key"),
    },
    expect: {
      "bun-build": "frontend/pay.ts:1 Stripe secret key [key-format]",
      "vite-build": "frontend/pay.ts:1 Stripe secret key [key-format]",
    },
  },
  {
    name: "a legacy .server module inside frontend/",
    files: {
      "frontend/db.server.ts": `export const rows = () => ["${BACKEND_MARKER}"]\n`,
      "routes/index.tsx": PAGE('import { rows } from "../frontend/db.server.ts"', "rows()"),
    },
    expect: {
      "bun-build": 'uses the retired ".server" suffix',
      "vite-build": 'uses the retired ".server" suffix',
      "bun-dev": 'uses the retired ".server" suffix',
      "vite-dev": 'uses the retired ".server" suffix',
      "server-build": 'uses the retired ".server" suffix',
    },
  },
  {
    name: "the retired server-only marker",
    files: { "routes/index.tsx": PAGE('import "@nifrajs/web/server-only"') },
    expect: {
      "bun-build": "@nifrajs/web/server-only",
      // Vite's resolver names the missing subpath; `nifra check` (NF-C005) names the replacement.
      "vite-build": '"./server-only" is not exported',
      "bun-dev": "@nifrajs/web/server-only",
    },
  },
  {
    name: "the backend-only marker in shared code",
    files: {
      "shared/key.ts": 'import "@nifrajs/web/backend-only"\nexport const key = 1\n',
      "routes/index.tsx": PAGE('import { key } from "../shared/key.ts"', "key"),
    },
    expect: {
      "bun-build": "@nifrajs/web/backend-only",
      "vite-build": "@nifrajs/web/backend-only",
      "bun-dev": 'it imports "@nifrajs/web/backend-only"',
      "server-build": "@nifrajs/web/backend-only",
    },
  },
  {
    name: "a file in no zone",
    files: {
      "lib/util.ts": `export const util = () => "${BACKEND_MARKER}"\n`,
      "routes/index.tsx": PAGE('import { util } from "../lib/util.ts"', "util()"),
    },
    expect: {
      "bun-build": '"lib/util.ts" is in no zone',
      "vite-build": '"lib/util.ts" is in no zone',
      "bun-dev": '"lib/util.ts" is in no zone',
      "vite-dev": "may not reach the browser",
      "server-build": '"lib/util.ts" is in no zone',
    },
  },
  {
    name: "a Node built-in imported by a page",
    files: {
      "routes/index.tsx": PAGE('import { readFileSync } from "node:fs"', "String(readFileSync)"),
    },
    expect: {
      "bun-build": "node:fs",
      "vite-build": "node:fs",
      "bun-dev": "Node and Bun built-ins run on the server only",
    },
  },
  {
    name: "a split app: page, backend half, shared code and a server function",
    files: {
      ...DB,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture's own template literal
      "shared/format.ts": "export const format = (n: number) => `#${n}`\n",
      "frontend/button.ts": 'export const label = "nifra-leak-matrix-frontend"\n',
      "backend/notes.fn.ts": `import { serverFn } from "@nifrajs/web/fn"\nexport const note = serverFn(async () => "${FN_MARKER}")\n`,
      "routes/index.backend.ts":
        'import { rows } from "../backend/db.ts"\nimport { format } from "../shared/format.ts"\nexport const loader = () => ({ label: format(rows().length) })\n',
      "routes/index.tsx": PAGE(
        'import { label } from "../frontend/button.ts"\nimport { format } from "../shared/format.ts"\nimport { note } from "../backend/notes.fn.ts"',
        "[label, format(1), String(note)]",
      ),
    },
    expect: {
      "bun-build": null,
      "vite-build": null,
      "bun-dev": null,
      "vite-dev": null,
      "server-build": null,
    },
  },
]

// ---------------------------------------------------------------------------------------------------

const TMP = `${import.meta.dir}/.tmp-leak-matrix-`
const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A fresh app for one row: `<tmp>/app`, with workspace packages beside it. */
function fixture(row: LeakPath): string {
  const root = mkdtempSync(TMP)
  roots.push(root)
  const app = join(root, "app")
  const put = (base: string, files: Readonly<Record<string, string>>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true })
      writeFileSync(join(base, path), text)
    }
  }
  put(app, {
    "frontend/client-stub.ts": "export function mountRouter() {}\n",
    "worker.ts":
      'import { manifest, clientEntry } from "./server-manifest"\nexport default { manifest, clientEntry }\n',
    ...row.files,
  })
  for (const [name, files] of Object.entries(row.workspace ?? {})) {
    put(join(root, "packages", name), files)
    mkdirSync(join(app, "node_modules"), { recursive: true })
    symlinkSync(join(root, "packages", name), join(app, "node_modules", name), "dir")
  }
  return app
}

const routeFiles = (app: string): string[] =>
  (readdirSync(join(app, "routes"), { recursive: true }) as string[])
    .filter((file) => /\.tsx$/.test(file))
    .map((file) => join(app, "routes", file))

/** Every file a browser could ask the dev server for: the app's own browser code. */
const browserFiles = (app: string): string[] =>
  ["routes", "frontend", "shared"].flatMap((dir) =>
    existsSync(join(app, dir))
      ? (readdirSync(join(app, dir), { recursive: true }) as string[])
          .map((file) => join(app, dir, file))
          .filter((file) => statSync(file).isFile() && !/\.backend\.ts$/.test(file))
      : [],
  )

/** Every text file under a directory, concatenated: what a build emitted. */
const emitted = (dir: string): string =>
  existsSync(dir)
    ? (readdirSync(dir, { recursive: true }) as string[])
        .map((file) => join(dir, file))
        .filter((file) => statSync(file).isFile())
        .map((file) => readFileSync(file, "utf8"))
        .join("\n")
    : ""

type Outcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly message: string }

const fail = (error: unknown): Outcome => ({
  ok: false,
  message: error instanceof Error ? error.message : String(error),
})

const RUN: Record<Pipeline, (app: string, row: LeakPath) => Promise<Outcome>> = {
  async "bun-build"(app) {
    const outDir = join(app, "dist")
    try {
      await buildClient({
        routesDir: join(app, "routes"),
        outDir,
        clientModule: join(app, "frontend/client-stub.ts"),
        publicDir: false,
        minify: false,
      })
      return { ok: true, output: emitted(outDir) }
    } catch (error) {
      // A refused build writes nothing.
      expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([])
      return fail(error)
    }
  },
  async "vite-build"(app, row) {
    const outDir = join(app, "dist")
    try {
      await buildClientVite({
        root: app,
        routesDir: join(app, "routes"),
        outDir,
        clientModule: join(app, "frontend/client-stub.ts"),
        publicDir: false,
        minify: false,
        ...(row.vitePlugins ? { vitePlugins: row.vitePlugins(app) } : {}),
      })
      return { ok: true, output: emitted(outDir) }
    } catch (error) {
      return fail(error)
    }
  },
  async "bun-dev"(app) {
    // `nifra dev --bun` hands Bun's dev bundler exactly these two plugins (see dev-bun-config.ts).
    const result = await Bun.build({
      entrypoints: routeFiles(app),
      target: "browser",
      throw: false,
      plugins: [zoneGuardPlugin({ appRoot: app }), serverFnStubPlugin()],
    } as Parameters<typeof Bun.build>[0])
    if (!result.success) return { ok: false, message: result.logs.map(String).join("\n") }
    const output = await Promise.all(result.outputs.map((out) => out.text()))
    return { ok: true, output: output.join("\n") }
  },
  async "vite-dev"(app, row) {
    const server = await createViteDevServer({
      root: app,
      routesDir: join(app, "routes"),
      clientModule: join(app, "frontend/client-stub.ts"),
      port: 0,
      createApp: () => ({ fetch: () => new Response("app") }),
      ...(row.vitePlugins ? { plugins: row.vitePlugins(app) } : {}),
    })
    try {
      const bodies: string[] = []
      // A browser walks the graph module by module: start from every browser file and follow each
      // import URL the served code names, as the browser would.
      const queue = browserFiles(app).map((file) => `/${relative(app, file)}`)
      const seen = new Set(queue)
      for (let i = 0; i < queue.length && i < 200; i++) {
        const url = queue[i] as string
        const response = await fetch(`http://127.0.0.1:${server.port}${url}`)
        const body = await response.text()
        if (response.status !== 200) return { ok: false, message: `${url}: ${body}` }
        bodies.push(body)
        for (const found of body.matchAll(/(?:from|import)\s*\(?\s*["'](\/[^"']+)["']/g)) {
          const next = found[1] as string
          if (next.startsWith("/@vite/") || next.startsWith("/@react-refresh") || seen.has(next)) {
            continue
          }
          seen.add(next)
          queue.push(next)
        }
      }
      return { ok: true, output: bodies.join("\n") }
    } finally {
      await server.stop()
    }
  },
  async "server-build"(app) {
    const outDir = join(app, "dist-server")
    try {
      await buildServer({
        routesDir: join(app, "routes"),
        serverEntry: join(app, "worker.ts"),
        outDir,
        clientEntry: "/assets/entry.js",
        target: "browser",
        minify: false,
      })
      return { ok: true, output: emitted(outDir) }
    } catch (error) {
      return fail(error)
    }
  },
}

const BROWSER_PIPELINES = new Set<Pipeline>(["bun-build", "vite-build", "bun-dev", "vite-dev"])

describe.each(ROWS.map((row) => [row.name, row] as const))("%s", (_name, row) => {
  for (const pipeline of PIPELINES) {
    const expected = row.expect[pipeline]
    if (expected === undefined) continue
    test(expected === null ? `${pipeline} passes` : `${pipeline} refuses`, async () => {
      const outcome = await RUN[pipeline](fixture(row), row)
      if (expected === null) {
        if (!outcome.ok) throw new Error(`expected ${pipeline} to pass:\n${outcome.message}`)
        if (BROWSER_PIPELINES.has(pipeline)) {
          // What did ship holds no backend source and no server-function body.
          expect(outcome.output).not.toContain(BACKEND_MARKER)
          expect(outcome.output).not.toContain(FN_MARKER)
        }
        return
      }
      if (outcome.ok) throw new Error(`expected ${pipeline} to refuse with: ${expected}`)
      expect(outcome.message).toContain(expected)
      // A refusal names what it refused, never the source it refused to send.
      expect(outcome.message).not.toContain(BACKEND_MARKER)
    }, 60_000)
  }
})

describe("dev error overlay", () => {
  const throwIn = (file: string): Error => {
    const error = new Error("boom")
    error.stack = `Error: boom\n    at loader (${file}:2:9)`
    return error
  }

  test("shows the code frame of browser code, never of backend code", () => {
    const app = fixture({
      name: "overlay",
      files: {
        "routes/index.tsx":
          "export default function Page() {\n  throw new Error('frontend-frame')\n}\n",
        "routes/index.backend.ts": `export const loader = () => {\n  throw new Error("${BACKEND_MARKER}")\n}\n`,
      },
      expect: {},
    })
    const diagnostics = createDevDiagnostics(app)
    const request = { method: "GET", url: "/" }
    const backend = diagnostics.capture(throwIn(join(app, "routes/index.backend.ts")), request)
    expect(backend).not.toContain(BACKEND_MARKER)
    const frontend = diagnostics.capture(throwIn(join(app, "routes/index.tsx")), request)
    expect(frontend).toContain("frontend-frame")
  })
})
