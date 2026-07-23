import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient, detectNodeBuiltinsInClient } from "../src/build.ts"
import { fromBunMetafile } from "../src/module-graph.ts"

/** Fixtures stay metafile-shaped; routing them through the adapter covers that mapping too. */
const detectNodeBuiltins = (meta: Parameters<typeof fromBunMetafile>[0]) =>
  detectNodeBuiltinsInClient(fromBunMetafile(meta))

// #4: a `node:` builtin pulled into the CLIENT bundle builds fine (Bun substitutes a browser polyfill)
// then breaks/leaks at runtime. buildClient now fails the build with a named, actionable error.
// detectNodeBuiltinsInClient is the pure core; it works off Bun's metafile graph (NOT the emitted
// text), so it survives minification and can't false-positive on a `"node:..."` string literal.

// A metafile where a USER route imports `node:crypto`, which lands in a client chunk (Bun's polyfill
// also drags in node:buffer transitively — but only the user-imported builtin should be reported).
const META_WITH_NODE = {
  inputs: {
    "routes/index.tsx": { imports: [{ path: "node:crypto", original: "node:crypto" }] },
    "node:crypto": { imports: [{ path: "node:buffer", original: "node:buffer" }] },
    "node:buffer": { imports: [] },
  },
  outputs: {
    "dist/index-abc123.js": {
      entryPoint: "routes/index.tsx",
      inputs: { "routes/index.tsx": {}, "node:crypto": {}, "node:buffer": {} },
    },
  },
} as const

test("flags only the user-imported builtin (not Bun's transitive polyfill chain) + its chunk", () => {
  const found = detectNodeBuiltins(META_WITH_NODE)
  // node:crypto is what the route imported; node:buffer is only pulled in by the crypto polyfill, so
  // it must NOT be reported (it would bury the real cause). The chain is the route → builtin path.
  expect(found).toEqual([
    {
      builtin: "node:crypto",
      chunk: "index-abc123.js",
      chain: ["routes/index.tsx", "node:crypto"],
    },
  ])
})

test("clean metafile (no node: builtins) → no findings", () => {
  const found = detectNodeBuiltins({
    inputs: { "routes/index.tsx": { imports: [{ path: "./util.ts", original: "./util.ts" }] } },
    outputs: { "dist/index-x.js": { inputs: { "routes/index.tsx": {} } } },
  })
  expect(found).toHaveLength(0)
})

test("undefined/empty metafile → no findings (never throws on a missing graph)", () => {
  expect(detectNodeBuiltins(undefined)).toHaveLength(0)
  expect(detectNodeBuiltins({ outputs: {} })).toHaveLength(0)
})

test("an `external` node: import (resolved path only, no `original`) is still flagged", () => {
  const found = detectNodeBuiltins({
    inputs: { "routes/page.tsx": { imports: [{ path: "node:fs" }] } },
    outputs: {
      "dist/page-y.js": {
        entryPoint: "routes/page.tsx",
        inputs: { "routes/page.tsx": {}, "node:fs": {} },
      },
    },
  })
  expect(found).toEqual([
    { builtin: "node:fs", chunk: "page-y.js", chain: ["routes/page.tsx", "node:fs"] },
  ])
})

// #5 (import-chain trace): the finding now includes the SHORTEST user-module import chain from the
// route entry to the offending builtin — so the dev sees `route → ../data.ts → ../db/client.ts →
// postgres → node:tls` instead of just the chunk name. Modeled on a realistic transitive leak.
const META_DEEP_CHAIN = {
  inputs: {
    "routes/article/[slug].tsx": {
      imports: [{ path: "src/data.ts", original: "../data.ts" }],
    },
    "src/data.ts": { imports: [{ path: "src/db/client.ts", original: "../db/client.ts" }] },
    "src/db/client.ts": {
      imports: [{ path: "node_modules/postgres/index.js", original: "postgres" }],
    },
    "node_modules/postgres/index.js": {
      imports: [{ path: "node:tls", original: "node:tls" }],
    },
    "node:tls": { imports: [] },
  },
  outputs: {
    "dist/_slug_-abc.js": {
      entryPoint: "routes/article/[slug].tsx",
      inputs: {
        "routes/article/[slug].tsx": {},
        "src/data.ts": {},
        "src/db/client.ts": {},
        "node_modules/postgres/index.js": {},
        "node:tls": {},
      },
    },
  },
}

test("includes the shortest import chain entry → … → builtin (as-written specifiers)", () => {
  const found = detectNodeBuiltins(META_DEEP_CHAIN)
  expect(found).toEqual([
    {
      builtin: "node:tls",
      chunk: "_slug_-abc.js",
      // Root is the route entry KEY; each hop is the *as-written* specifier; tail is the builtin.
      chain: ["routes/article/[slug].tsx", "../data.ts", "../db/client.ts", "postgres", "node:tls"],
    },
  ])
})

test("chain BFS picks the SHORTEST path when a builtin is reachable two ways", () => {
  // The route reaches node:crypto both directly AND via a longer util chain; the chain must be the
  // shortest (direct) one, not an arbitrary longer route through the graph.
  const found = detectNodeBuiltins({
    inputs: {
      "routes/index.tsx": {
        imports: [
          { path: "src/long/a.ts", original: "./long/a.ts" },
          { path: "node:crypto", original: "node:crypto" },
        ],
      },
      "src/long/a.ts": { imports: [{ path: "src/long/b.ts", original: "./b.ts" }] },
      "src/long/b.ts": { imports: [{ path: "node:crypto", original: "node:crypto" }] },
      "node:crypto": { imports: [] },
    },
    outputs: {
      "dist/index-z.js": {
        entryPoint: "routes/index.tsx",
        inputs: {
          "routes/index.tsx": {},
          "src/long/a.ts": {},
          "src/long/b.ts": {},
          "node:crypto": {},
        },
      },
    },
  })
  // Direct import wins: entry → node:crypto (length 2), not entry → ./long/a.ts → ./b.ts → node:crypto.
  expect(found[0]?.chain).toEqual(["routes/index.tsx", "node:crypto"])
})

test("chain BFS does NOT walk through Bun's polyfill subtree (precise, user modules only)", () => {
  // node:crypto's polyfill imports node:buffer; the chain to node:crypto must stop at node:crypto and
  // never traverse INTO the polyfill (which would lengthen/derail the path with non-user modules).
  const found = detectNodeBuiltins(META_WITH_NODE)
  expect(found[0]?.chain).toEqual(["routes/index.tsx", "node:crypto"])
  // The polyfill's own builtin (node:buffer) is not even reported (it's not user-imported).
  expect(found.map((f) => f.builtin)).toEqual(["node:crypto"])
})

// End-to-end through the real `buildClient` — the temp app lives INSIDE the workspace so the generated
// bootstrap's `@nifrajs/web`/`@nifrajs/web/client` imports resolve via node_modules hoisting.
const WORKSPACE_TMP_BASE = `${import.meta.dir}/.tmp-node-guard-`
let projectRoot: string
let routesDir: string
let clientModule: string

beforeEach(() => {
  projectRoot = mkdtempSync(WORKSPACE_TMP_BASE)
  routesDir = join(projectRoot, "routes")
  mkdirSync(routesDir, { recursive: true })
  clientModule = join(projectRoot, "client-stub.ts")
  writeFileSync(clientModule, "export function mountRouter() {}\n")
})
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

test("buildClient throws a named error when a route imports node:crypto", async () => {
  writeFileSync(
    join(routesDir, "index.tsx"),
    'import { randomUUID } from "node:crypto"\n' +
      "export default function Index() { return null }\n" +
      "export const id = randomUUID()\n",
  )
  const promise = buildClient({
    routesDir,
    outDir: join(projectRoot, "dist"),
    clientModule,
    minify: false,
  })
  await expect(promise).rejects.toThrow(/node:crypto reached the client bundle via/)
  await expect(promise).rejects.toThrow(/server-only path/)
})

test("buildClient does NOT throw on a benign `node:` string literal (no false positive)", async () => {
  // The string mentions `node:crypto` but never imports it — minified, so any text-based check would
  // be defeated; the graph-based check sees no import edge.
  writeFileSync(
    join(routesDir, "index.tsx"),
    "export default function Index() { return null }\n" +
      'export const note = "node:crypto is a Node built-in"\n',
  )
  const manifest = await buildClient({
    routesDir,
    outDir: join(projectRoot, "dist"),
    clientModule,
    minify: true,
  })
  expect(manifest.entry).toMatch(/\.js$/)
})
