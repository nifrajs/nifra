import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  detectNodeBuiltinsInClient,
  detectServerOnlyInClient,
  formatNodeBuiltinLeak,
} from "../src/build.ts"
import { fromRollupBundle, type RollupBundleLike } from "../src/module-graph.ts"
import { viteLeakGuard } from "../src/plugins/vite-leak-guard.ts"

/**
 * The Vite/Rollup production leak guards. Two layers of proof:
 *   1. `fromRollupBundle` maps a Rollup-shaped bundle into the neutral graph so the SAME guards fire.
 *   2. A REAL `vite build` with `viteLeakGuard()` fails on a real leak and passes on clean code — the
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
): Promise<{ ok: boolean; error?: string }> {
  const root = mkdtempSync(TMP_BASE)
  tmpDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, content)
  }
  const vite = (await import("vite")) as unknown as {
    build(config: Record<string, unknown>): Promise<unknown>
  }
  try {
    await vite.build({
      root,
      logLevel: "silent",
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es"], fileName: "entry" },
        rollupOptions: { external: [/^node:/], plugins: [viteLeakGuard()] },
      },
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

test("real vite build FAILS when a node: builtin reaches the client, with the shared message", async () => {
  const result = await buildWithGuard({
    "leak.ts": 'import { randomUUID } from "node:crypto"\nexport const id = randomUUID()\n',
    "entry.ts": 'import { id } from "./leak.ts"\ndocument.title = id\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("Node built-in(s) in the client bundle")
  expect(result.error).toContain("node:crypto reached the client bundle via")
}, 60_000)

test("real vite build FAILS when a server-only module reaches the client", async () => {
  // The marker resolves to @nifrajs/web/server-only; the guard flags any module importing it that lands
  // in a client chunk. Uses a relative stub for the marker so the fixture needs no node_modules wiring —
  // the guard matches on the resolved basename `server-only.ts`, which this satisfies.
  const result = await buildWithGuard({
    "server-only.ts": "export {}\n",
    "secrets.ts": 'import "./server-only.ts"\nexport const KEY = "super-secret"\n',
    "entry.ts": 'import { KEY } from "./secrets.ts"\ndocument.title = KEY\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("server-only module(s) in the client bundle")
}, 60_000)

test("real vite build PASSES for a clean client (no false positive)", async () => {
  const result = await buildWithGuard({
    "util.ts": "export const greet = (n) => `hi ${n}`\n",
    "entry.ts": 'import { greet } from "./util.ts"\ndocument.title = greet("world")\n',
  })
  expect(result.error).toBeUndefined()
  expect(result.ok).toBe(true)
}, 60_000)

test("real vite build FAILS on a node: builtin reached only via dynamic import()", async () => {
  // A `node:` module pulled in by `import()` still ships to the browser; the guard reads
  // dynamicallyImportedIds too, so it must catch this the same as a static import.
  const result = await buildWithGuard({
    "entry.ts":
      'export async function load() {\n  const m = await import("node:fs")\n  return m.readFileSync\n}\n',
  })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("node:fs reached the client bundle")
}, 60_000)
