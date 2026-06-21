import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildClient,
  buildServer,
  detectServerOnlyInClient,
  SERVER_ONLY_MARKER,
} from "../src/build.ts"

// §3.3/§5.1: the `server-only` poison-import marker. A module of PURE server logic (no `node:` import,
// not named `*.server`) opts in with `import "@nifrajs/web/server-only"` and the CLIENT build fails
// loud — with the import chain — if it reaches a browser chunk. detectServerOnlyInClient is the pure
// core; it works off Bun's metafile graph (NOT the emitted text), so it survives minification.

// A metafile where a route imports a module that opted into the marker (so the module is "marked"),
// and that module lands in a client chunk. The marker module itself imports nothing — it must NOT be
// reported (it's the import target, not an opt-in).
const META_MARKED = {
  inputs: {
    "routes/index.tsx": { imports: [{ path: "src/secrets.ts", original: "../secrets.ts" }] },
    "src/secrets.ts": {
      imports: [
        { path: "node_modules/@nifrajs/web/src/server-only.ts", original: SERVER_ONLY_MARKER },
      ],
    },
    "node_modules/@nifrajs/web/src/server-only.ts": { imports: [] },
  },
  outputs: {
    "dist/index-abc123.js": {
      entryPoint: "routes/index.tsx",
      inputs: {
        "routes/index.tsx": {},
        "src/secrets.ts": {},
        "node_modules/@nifrajs/web/src/server-only.ts": {},
      },
    },
  },
} as const

test("flags the marked module + its chunk + the import chain (entry → marked) [server-only]", () => {
  const found = detectServerOnlyInClient(META_MARKED)
  expect(found).toEqual([
    {
      chunk: "index-abc123.js",
      // Root is the route entry key; the hop is the as-written specifier; the tail names the marked module.
      chain: ["routes/index.tsx", "../secrets.ts (marked server-only)"],
    },
  ])
})

test("the marker module itself (imports nothing) is never reported [server-only]", () => {
  // Only the marker module is in the graph, as a leaf — there is no module that *opts in*, so it's clean.
  const found = detectServerOnlyInClient({
    inputs: { "node_modules/@nifrajs/web/dist/server-only.js": { imports: [] } },
    outputs: {
      "dist/x.js": { inputs: { "node_modules/@nifrajs/web/dist/server-only.js": {} } },
    },
  })
  expect(found).toHaveLength(0)
})

test("a normal module (no marker import) is unaffected [server-only]", () => {
  const found = detectServerOnlyInClient({
    inputs: {
      "routes/index.tsx": { imports: [{ path: "src/util.ts", original: "../util.ts" }] },
      "src/util.ts": { imports: [] },
    },
    outputs: { "dist/index-x.js": { inputs: { "routes/index.tsx": {}, "src/util.ts": {} } } },
  })
  expect(found).toHaveLength(0)
})

test("undefined/empty metafile → no findings (never throws on a missing graph) [server-only]", () => {
  expect(detectServerOnlyInClient(undefined)).toHaveLength(0)
  expect(detectServerOnlyInClient({ outputs: {} })).toHaveLength(0)
})

test("a pre-resolved marker edge (no `original`) is still recognised by its resolved path [server-only]", () => {
  const found = detectServerOnlyInClient({
    inputs: {
      "routes/page.tsx": { imports: [{ path: "src/secrets.ts", original: "../secrets.ts" }] },
      // The marker edge lost its `original` but resolved to the marker module file.
      "src/secrets.ts": {
        imports: [{ path: "node_modules/@nifrajs/web/dist/server-only.js" }],
      },
      "node_modules/@nifrajs/web/dist/server-only.js": { imports: [] },
    },
    outputs: {
      "dist/page-y.js": {
        entryPoint: "routes/page.tsx",
        inputs: {
          "routes/page.tsx": {},
          "src/secrets.ts": {},
          "node_modules/@nifrajs/web/dist/server-only.js": {},
        },
      },
    },
  })
  expect(found).toEqual([
    { chunk: "page-y.js", chain: ["routes/page.tsx", "../secrets.ts (marked server-only)"] },
  ])
})

test("chain BFS picks the SHORTEST path to a marked module reachable two ways [server-only]", () => {
  const found = detectServerOnlyInClient({
    inputs: {
      "routes/index.tsx": {
        imports: [
          { path: "src/long/a.ts", original: "./long/a.ts" },
          { path: "src/secrets.ts", original: "./secrets.ts" },
        ],
      },
      "src/long/a.ts": { imports: [{ path: "src/secrets.ts", original: "../secrets.ts" }] },
      "src/secrets.ts": {
        imports: [
          { path: "node_modules/@nifrajs/web/src/server-only.ts", original: SERVER_ONLY_MARKER },
        ],
      },
      "node_modules/@nifrajs/web/src/server-only.ts": { imports: [] },
    },
    outputs: {
      "dist/index-z.js": {
        entryPoint: "routes/index.tsx",
        inputs: {
          "routes/index.tsx": {},
          "src/long/a.ts": {},
          "src/secrets.ts": {},
          "node_modules/@nifrajs/web/src/server-only.ts": {},
        },
      },
    },
  })
  // Direct import wins: entry → secrets (length 2), not entry → ./long/a.ts → secrets.
  expect(found[0]?.chain).toEqual(["routes/index.tsx", "./secrets.ts (marked server-only)"])
})

// End-to-end through the real build. The temp app lives INSIDE the workspace so the generated
// bootstrap's `@nifrajs/web`/`@nifrajs/web/client` imports (and `@nifrajs/web/server-only`) resolve.
const TMP = `${import.meta.dir}/.tmp-server-only-marker-`
let root: string
let routesDir: string
let clientModule: string

beforeEach(() => {
  root = mkdtempSync(TMP)
  routesDir = join(root, "routes")
  mkdirSync(routesDir, { recursive: true })
  clientModule = join(root, "client-stub.ts")
  writeFileSync(clientModule, "export function mountRouter() {}\n")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test("buildClient throws naming the marker + the chain when a marked module reaches the client", async () => {
  // A pure-server module (NO node: import) that opts into the marker, imported at a route's top level
  // so it can't be tree-shaken out → it lands in the route's chunk.
  writeFileSync(
    join(root, "secrets.ts"),
    `import "${SERVER_ONLY_MARKER}"\nexport const apiKey = "sk-live-1234567890"\n`,
  )
  writeFileSync(
    join(routesDir, "index.tsx"),
    'import { apiKey } from "../secrets.ts"\n' +
      "export const loader = () => ({ key: apiKey })\n" +
      "export default () => apiKey\n",
  )
  const promise = buildClient({
    routesDir,
    outDir: join(root, "dist"),
    clientModule,
    minify: false,
  })
  await expect(promise).rejects.toThrow(/server-only module reached the client bundle via/)
  await expect(promise).rejects.toThrow(/marked server-only/)
  await expect(promise).rejects.toThrow(/\.\.\/secrets\.ts/)
})

test("the server build KEEPS a marker-importing module (no throw — marker is a server no-op)", async () => {
  // The marker is an empty module on the server, so a server-only module importing it builds fine and
  // the real module is retained (it runs server-side).
  writeFileSync(
    join(root, "secrets.ts"),
    `import "${SERVER_ONLY_MARKER}"\nexport const apiKey = "sk-live-1234567890"\n`,
  )
  writeFileSync(
    join(routesDir, "index.tsx"),
    'import { apiKey } from "../secrets.ts"\nexport const loader = () => ({ key: apiKey })\nexport default () => "home"\n',
  )
  const serverEntry = join(root, "worker.ts")
  writeFileSync(
    serverEntry,
    'import { manifest, clientEntry } from "./server-manifest"\nexport default { manifest, clientEntry }\n',
  )
  const outDir = join(root, "dist-server")
  const build = await buildServer({
    routesDir,
    serverEntry,
    outDir,
    clientEntry: "/assets/entry.js",
    target: "bun",
    minify: false,
  })
  // The marker-importing module survived into the server bundle (its export is reachable).
  let bundle = ""
  for (const f of readdirSync(outDir))
    if (f.endsWith(".js")) bundle += readFileSync(join(outDir, f), "utf8")
  expect(bundle).toContain("sk-live-1234567890")
  expect(build.worker).toMatch(/\.js$/)
})

test("buildClient is unaffected by a normal (unmarked) module", async () => {
  writeFileSync(
    join(root, "util.ts"),
    "export const greeting = () => 'hello from a normal module'\n",
  )
  writeFileSync(
    join(routesDir, "index.tsx"),
    'import { greeting } from "../util.ts"\nexport default () => greeting()\n',
  )
  const manifest = await buildClient({
    routesDir,
    outDir: join(root, "dist"),
    clientModule,
    minify: true,
  })
  expect(manifest.entry).toMatch(/\.js$/)
})

test("the marker module itself is empty / a no-op (re-exports nothing)", async () => {
  const mod = (await import("../src/server-only.ts")) as Record<string, unknown>
  // No runtime exports — the marker is purely the import side-effect the build guard keys off.
  expect(Object.keys(mod).filter((k) => k !== "default")).toHaveLength(0)
})
