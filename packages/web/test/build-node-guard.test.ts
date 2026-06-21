import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient, detectNodeBuiltinsInClient } from "../src/build.ts"

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
}

test("flags only the user-imported builtin (not Bun's transitive polyfill chain) + its chunk [#4]", () => {
  const found = detectNodeBuiltinsInClient(META_WITH_NODE)
  // node:crypto is what the route imported; node:buffer is only pulled in by the crypto polyfill, so
  // it must NOT be reported (it would bury the real cause).
  expect(found).toEqual([{ builtin: "node:crypto", chunk: "index-abc123.js" }])
})

test("clean metafile (no node: builtins) → no findings [#4]", () => {
  const found = detectNodeBuiltinsInClient({
    inputs: { "routes/index.tsx": { imports: [{ path: "./util.ts", original: "./util.ts" }] } },
    outputs: { "dist/index-x.js": { inputs: { "routes/index.tsx": {} } } },
  })
  expect(found).toHaveLength(0)
})

test("undefined/empty metafile → no findings (never throws on a missing graph) [#4]", () => {
  expect(detectNodeBuiltinsInClient(undefined)).toHaveLength(0)
  expect(detectNodeBuiltinsInClient({ outputs: {} })).toHaveLength(0)
})

test("an `external` node: import (resolved path only, no `original`) is still flagged [#4]", () => {
  const found = detectNodeBuiltinsInClient({
    inputs: { "routes/page.tsx": { imports: [{ path: "node:fs" }] } },
    outputs: { "dist/page-y.js": { inputs: { "routes/page.tsx": {}, "node:fs": {} } } },
  })
  expect(found).toEqual([{ builtin: "node:fs", chunk: "page-y.js" }])
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

test("buildClient throws a named error when a route imports node:crypto [#4]", async () => {
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

test("buildClient does NOT throw on a benign `node:` string literal (no false positive) [#4]", async () => {
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
