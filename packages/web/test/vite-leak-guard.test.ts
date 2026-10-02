import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  detectNodeBuiltinsInClient,
  detectServerOnlyInClient,
  formatNodeBuiltinLeak,
} from "../src/build.ts"
import { importVite } from "../src/internal/vite-import.ts"
import { fromRollupBundle, type RollupBundleLike } from "../src/module-graph.ts"
import { viteBareBuiltinExternal, viteLeakGuard } from "../src/plugins/vite-leak-guard.ts"

/**
 * The Vite/Rollup production leak guards. Two layers of proof:
 *   1. `fromRollupBundle` maps a Rollup-shaped bundle into the neutral graph so the SAME guards fire.
 *   2. A REAL `vite build` with `viteLeakGuard()` fails on a real leak and passes on clean code - the
 *      part that matters, because the whole point is that a second production pipeline is safe.
 */

// --- 1. fromRollupBundle feeds the existing guards --------------------------------------------------

// A Rollup output bundle for a route that imports node:crypto, plus the per-module import map Rollup
// exposes via getModuleInfo. Absolute ids, like a real build.
const ROLLUP_BUNDLE: RollupBundleLike = {
  "index-abc.js": {
    type: "chunk",
    facadeModuleId: "/app/routes/index.tsx",
    moduleIds: ["/app/routes/index.tsx", "/app/src/data.ts"],
  },
}
const ROLLUP_IMPORTS: Record<string, readonly string[]> = {
  "/app/routes/index.tsx": ["/app/src/data.ts"],
  "/app/src/data.ts": ["node:crypto"],
}

test("fromRollupBundle → detectNodeBuiltinsInClient finds the leak with its chain", () => {
  const graph = fromRollupBundle(ROLLUP_BUNDLE, (id) => ROLLUP_IMPORTS[id] ?? [])
  const found = detectNodeBuiltinsInClient(graph)
  expect(found).toHaveLength(1)
  expect(found[0]?.builtin).toBe("node:crypto")
  expect(found[0]?.chunk).toBe("index-abc.js")
  // The chain walks from the entry through the resolved ids to the builtin.
  expect(found[0]?.chain).toEqual(["/app/routes/index.tsx", "/app/src/data.ts", "node:crypto"])
})

test("assets (no module graph) are skipped, not treated as empty chunks", () => {
  const graph = fromRollupBundle(
    { "style.css": { type: "asset" }, ...ROLLUP_BUNDLE },
    (id) => ROLLUP_IMPORTS[id] ?? [],
  )
  expect(Object.keys(graph.chunks)).toEqual(["index-abc.js"])
})

test("a shared chunk (facadeModuleId null) contributes no entry point", () => {
  const graph = fromRollupBundle(
    { "shared-x.js": { type: "chunk", facadeModuleId: null, moduleIds: ["/app/src/util.ts"] } },
    () => [],
  )
  expect(graph.chunks["shared-x.js"]?.entryPoint).toBeUndefined()
})

test("a clean bundle yields no findings", () => {
  const graph = fromRollupBundle(
    {
      "index-x.js": {
        type: "chunk",
        facadeModuleId: "/app/routes/index.tsx",
        moduleIds: ["/app/routes/index.tsx"],
      },
    },
    () => ["/app/src/util.ts"],
  )
  expect(detectNodeBuiltinsInClient(graph)).toHaveLength(0)
  expect(detectServerOnlyInClient(graph)).toHaveLength(0)
})

test("an empty bundle is a total no-op (never throws to fail a build for the wrong reason)", () => {
  const graph = fromRollupBundle({}, () => [])
  expect(graph.modules).toEqual({})
  expect(graph.chunks).toEqual({})
})

test("Bun and Rollup adapters produce the same finding for the same leak (byte-identical message)", () => {
  // The parity that justifies one detection implementation across two bundlers: the SAME leak yields the
  // SAME formatted error whichever adapter fed the graph.
  const rollupGraph = fromRollupBundle(ROLLUP_BUNDLE, (id) => ROLLUP_IMPORTS[id] ?? [])
  const rollupMessage = formatNodeBuiltinLeak(detectNodeBuiltinsInClient(rollupGraph))
  expect(rollupMessage).toContain("node:crypto reached the client bundle via")
  expect(rollupMessage).toContain("Node built-in(s) in the client bundle")
})

// --- 2. A real vite build, end to end --------------------------------------------------------------

const TMP_BASE = `${import.meta.dir}/.tmp-vite-guard-`
const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/** Run `vite build` (write:false) over `files` with the guard plugin; return {ok, error}. */
async function buildWithGuard(
  files: Record<string, string>,
  buildOptions: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string }> {
  const root = mkdtempSync(TMP_BASE)
  tmpDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, content)
  }
  // Via the shared importer, so this test cannot be the unguarded import that poisons vite.
  const vite = await importVite<{
    build(config: Record<string, unknown>): Promise<unknown>
  }>()
  const config = {
    root,
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry: join(root, "frontend/entry.ts"), formats: ["es"], fileName: "entry" },
      rollupOptions: { external: [/^node:/], plugins: [viteLeakGuard({ appRoot: root })] },
      ...buildOptions,
    },
  }
  // rolldown-vite's native (napi) bindings can race across repeated in-process builds and throw a
  // transient "Failed to increase error reference count" INSTEAD of the real build outcome. That is a
  // rolldown binding flake, not a guard result: a genuine leak error and a clean pass are both
  // deterministic and never carry that message, so retrying it a few times masks nothing real.
  for (let attempt = 0; ; attempt++) {
    try {
      await vite.build(config)
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (attempt < 4 && error.includes("Failed to increase error reference count")) continue
      return { ok: false, error }
    }
  }
}

test("real vite build FAILS when a node: builtin reaches the client, with the shared message", async () => {
  const result = await buildWithGuard({
    "frontend/leak.ts":
      'import { randomUUID } from "node:crypto"\nexport const id = randomUUID()\n',
    "frontend/entry.ts": 'import { id } from "./leak.ts"\ndocument.title = id\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("Node built-in(s) in the client bundle")
  expect(result.error).toContain("node:crypto reached the client bundle via")
}, 60_000)

test("real vite build FAILS when a backend-only marked module reaches the client", async () => {
  // The marker resolves to @nifrajs/web/backend-only; the guard flags any module importing it that lands
  // in a client chunk. Uses a relative stub for the marker so the fixture needs no node_modules wiring -
  // the guard matches on the resolved basename `backend-only.ts`, which this satisfies.
  const result = await buildWithGuard({
    "shared/backend-only.ts": "export {}\n",
    "shared/secrets.ts": 'import "./backend-only.ts"\nexport const KEY = "super-secret"\n',
    "frontend/entry.ts": 'import { KEY } from "../shared/secrets.ts"\ndocument.title = KEY\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("backend-only module(s) in the client bundle")
}, 60_000)

test("real vite build FAILS when backend code reaches the client, naming the chain", async () => {
  const result = await buildWithGuard({
    "backend/db.ts": 'export const query = () => "SELECT secret"\n',
    "shared/data.ts": 'import { query } from "../backend/db.ts"\nexport const rows = query\n',
    "frontend/entry.ts": 'import { rows } from "../shared/data.ts"\ndocument.title = rows()\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("backend/db.ts: it is backend code")
  expect(result.error).toContain("via frontend/entry.ts → shared/data.ts → backend/db.ts")
}, 60_000)

test("real vite build FAILS on backend code tree-shaking dropped from every chunk", async () => {
  // Loaded but unused: no byte ships, yet the import itself crosses the boundary.
  const result = await buildWithGuard({
    "backend/db.ts": 'export const query = () => "SELECT secret"\n',
    "frontend/entry.ts": 'import { query } from "../backend/db.ts"\ndocument.title = "x"\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("backend/db.ts: it is backend code")
}, 60_000)

test("real vite build FAILS on a file in no zone", async () => {
  const result = await buildWithGuard({
    "lib/util.ts": "export const x = 1\n",
    "frontend/entry.ts": 'import { x } from "../lib/util.ts"\ndocument.title = String(x)\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('"lib/util.ts" is in no zone')
}, 60_000)

test("real vite build PASSES for a clean client (no false positive)", async () => {
  const result = await buildWithGuard({
    "shared/util.ts": 'export const greet = (n) => "hi " + n\n',
    "frontend/entry.ts":
      'import { greet } from "../shared/util.ts"\ndocument.title = greet("world")\n',
  })
  expect(result.error).toBeUndefined()
  expect(result.ok).toBe(true)
}, 60_000)

test("real vite build scans the source maps it emits", async () => {
  const files = {
    "frontend/entry.ts": "document.title = 'hi'\n",
  }
  expect(await buildWithGuard(files, { sourcemap: true })).toEqual({ ok: true })
  // A dependency's comment is gone from the minified chunk but kept in the map's sourcesContent, and
  // only first-party source is scanned before bundling - so the map is where it is caught.
  const leaky = await buildWithGuard(
    {
      "node_modules/chatty-lib/package.json": '{ "name": "chatty-lib", "main": "index.js" }\n',
      "node_modules/chatty-lib/index.js":
        "// postgres://admin:Zq8vR2nLx4Tw@db.internal:5432/app\nexport const hi = () => document.referrer\n",
      "frontend/entry.ts": "import { hi } from 'chatty-lib'\ndocument.title = hi()\n",
    },
    { sourcemap: true, minify: true },
  )
  expect(leaky.ok).toBe(false)
  expect(leaky.error).toContain("entry.js.map:1 URL with a password")
}, 60_000)

test("real vite build FAILS on a node: builtin reached only via dynamic import()", async () => {
  // A `node:` module pulled in by `import()` still ships to the browser; the guard reads
  // dynamicallyImportedIds too, so it must catch this the same as a static import.
  const result = await buildWithGuard({
    "frontend/entry.ts":
      'export async function load() {\n  const m = await import("node:fs")\n  return m.readFileSync\n}\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("node:fs reached the client bundle")
}, 60_000)

/** `buildWithGuard`, with nifra's bare built-in plugin in front - the Vite production pipeline's setup. */
async function buildLikePipeline(
  files: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const root = mkdtempSync(TMP_BASE)
  tmpDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, content)
  }
  const vite = await importVite<{ build(config: Record<string, unknown>): Promise<unknown> }>()
  const config = {
    root,
    logLevel: "silent",
    plugins: [viteBareBuiltinExternal()],
    build: {
      write: false,
      lib: { entry: join(root, "frontend/entry.ts"), formats: ["es"], fileName: "entry" },
      rollupOptions: { external: [/^node:/], plugins: [viteLeakGuard({ appRoot: root })] },
    },
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await vite.build(config)
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (attempt < 4 && error.includes("Failed to increase error reference count")) continue
      return { ok: false, error }
    }
  }
}

test("real vite build FAILS on a bare built-in, named as the Bun build names it", async () => {
  const result = await buildLikePipeline({
    "frontend/entry.ts": 'export const load = () => import("fs/promises")\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("node:fs/promises reached the client bundle")
}, 60_000)

test("real vite build PASSES when a built-in name resolves to an installed package", async () => {
  const result = await buildLikePipeline({
    "node_modules/events/package.json": '{ "name": "events", "main": "index.js" }\n',
    "node_modules/events/index.js": "export class EventEmitter {}\n",
    "frontend/entry.ts":
      'import { EventEmitter } from "events"\nexport const e = new EventEmitter()\n',
  })
  expect(result.error).toBeUndefined()
  expect(result.ok).toBe(true)
}, 60_000)
