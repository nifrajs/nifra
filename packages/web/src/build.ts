/**
 * `@nifrajs/web/build` — the production build (Bun-only, build-time). `buildClient` codegens + bundles
 * the client entry (content-hashed, code-split); `buildServer` codegens the static-import server
 * manifest + bundles a self-contained **worker** for the disk-less edge (Cloudflare Workers). Both
 * are Bun-specific and never on the request path (own subpath, like `@nifrajs/web/fs`); the *output*
 * runs on any runtime.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { cp, mkdir } from "node:fs/promises"
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path"
import { type BunPlugin, Glob } from "bun"
import { sanitizeOutputNames } from "./chunk-names.ts"
import { discoverRoutes } from "./fs.ts"
import { generateClientEntry, generateServerManifest } from "./index.ts"
// `buildTarget(static)` drives the SSG prerender engine directly (it's also re-exported below).
import { type ClientModuleGraph, fromBunMetafile } from "./module-graph.ts"
import { prerenderRoutes } from "./prerender.ts"

// Build-time SSG: prerender opted-in static + dynamic routes to `index.html` (+ static `_data.json`),
// run after `buildClient`.
export {
  type CloudflarePagesRoutes,
  type CloudflarePagesRoutesOptions,
  cloudflarePagesRoutes,
  dataFileFor,
  htmlFileFor,
  type PrerenderApp,
  type PrerenderEntry,
  type PrerenderOptions,
  type PrerenderResult,
  prerenderRoutes,
} from "./prerender.ts"

export interface BuildClientOptions {
  /** The `routes/` directory to discover (absolute path). */
  readonly routesDir: string
  /** Output directory for the bundle + `manifest.json` (absolute path). */
  readonly outDir: string
  /** The adapter's client runtime (exports `mountRouter`), e.g. `"@nifrajs/web-solid/client"`. */
  readonly clientModule: string
  /** Route/layout file → import specifier (default: `${routesDir}/${file}`). */
  readonly resolve?: (file: string) => string
  /** Adapter build plugins (e.g. `solidBunPlugin("dom")`). */
  readonly plugins?: readonly BunPlugin[]
  /** `Bun.build` export conditions (e.g. `["bun", "solid", "browser"]`). */
  readonly conditions?: readonly string[]
  /** Compile-time replacements (e.g. `{ "process.env.NODE_ENV": '"production"' }`). */
  readonly define?: Readonly<Record<string, string>>
  /** Minify the output (default `true`). */
  readonly minify?: boolean
  /** URL prefix the assets are served under (default `"/assets/"`); also Bun's chunk `publicPath`. */
  readonly publicPath?: string
  /**
   * Directory of user-authored static files copied into the build and served at the root (default
   * `"public"`). Absent directory ⇒ nothing copied, no error.
   *
   * NOT the same thing as {@link publicPath}, despite the names: that is the URL prefix for
   * content-hashed bundle chunks and never covers files an author put on disk. The collision is a
   * real source of confusion, which is why both are spelled out here.
   */
  readonly publicDir?: string
  /**
   * Prefix that opts an environment variable into the **client** bundle (Vite/Next convention; default
   * `"PUBLIC_"`). Every var in the build environment whose name starts with this prefix is baked into
   * the client `define` as `"process.env.NAME": JSON.stringify(value)`, so `process.env.PUBLIC_API_URL`
   * compiles to its literal value in the browser. Vars WITHOUT the prefix are never exposed — the bare
   * `process.env` define resolves them to `undefined`, so server secrets can't leak into the client
   * bundle. Set to `""` to disable auto-exposure entirely (no var is baked in). `options.define` still
   * wins over an auto-exposed var (it's layered last). Sourced from `Bun.env` (falls back to
   * `process.env`) at build time. */
  readonly publicEnvPrefix?: string
}

/**
 * The `process.env.<NAME>` → `JSON.stringify(value)` define entries for every env var whose name
 * carries `prefix` (the Vite/Next public-env convention). Exposing ONLY the prefixed vars is the
 * security boundary: an unprefixed var (a secret) never gets a define, so the bare `process.env`
 * define resolves it to `undefined` in the client bundle. An empty `prefix` exposes nothing (the
 * opt-out). Pure + exported so the prefix/redaction contract is unit-testable without a real build.
 */
export function publicEnvDefines(
  prefix: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const defines: Record<string, string> = {}
  if (prefix === "") return defines // opt-out: bake in nothing
  for (const [name, value] of Object.entries(env)) {
    // Skip `undefined` (a deleted/unset key can still enumerate) so we never bake in `"undefined"`.
    if (name.startsWith(prefix) && value !== undefined) {
      defines[`process.env.${name}`] = JSON.stringify(value)
    }
  }
  return defines
}

/** The built asset map — the server reads `entry` for the client script + serves `assets`. */
/**
 * Copy `from` into `to`, returning the URL paths copied (sorted).
 *
 * Lives here, not beside `servePublicDir`, because it is BUILD-time: it reaches for `Bun.Glob` and
 * `node:fs`, and `public-dir.ts` is reachable from the client bundle graph through the package
 * entry - a dynamic `import("bun")` there fails the browser build outright.
 */
export async function copyPublicDir(from: string, to: string): Promise<string[]> {
  const source = resolvePath(from)
  const copied: string[] = []
  for await (const rel of new Glob("**/*").scan({ cwd: source, dot: true, onlyFiles: true })) {
    const target = join(to, rel)
    await mkdir(join(target, ".."), { recursive: true })
    await cp(join(source, rel), target)
    copied.push(`/${rel.split(sep).join("/")}`)
  }
  return copied.sort()
}

export interface BuildManifest {
  /** URL of the client entry module (content-hashed). */
  readonly entry: string
  /** URLs of every emitted asset (entry + chunks) — for serving + preloading. */
  readonly assets: readonly string[]
  /** `routeId → [layout chunk URLs…, own chunk URL]` — the chunks a route needs, for `createWebApp`'s
   * `routePreload` (`<link rel="modulepreload">` the matched route alongside the entry). Each route +
   * layout is also a build entrypoint, so it gets a named chunk the bootstrap's lazy import dedupes to. */
  readonly routes: Readonly<Record<string, readonly string[]>>
  /** URL paths copied from `publicDir`, sorted. Lets the server entry serve them without scanning a
   * directory per request, and lets an adapter that needs a file list (CDN upload, platform static
   * assets) consume one. Omitted when there is no `public/`. */
  readonly publicFiles?: readonly string[]
  /** The app's bundled, content-hashed stylesheet(s) — the bootstrap's **aggregate** CSS (every
   * `import './x.css'` reachable from the app). The complete stylesheet regardless of which file
   * imported the CSS; the always-safe fallback `createWebApp` links when a route has no per-route entry
   * in {@link routeStyles}. Omitted when the app imports no CSS. */
  readonly css?: readonly string[]
  /** `routeId → [chain CSS URLs]` — only the stylesheets the matched route's layout chain + own file
   * actually use (Bun emits a per-entrypoint CSS bundle per route/layout, with shared-component CSS
   * inlined into each consumer). `createWebApp` links these instead of the aggregate, so a page ships
   * only its own CSS. A route is omitted (→ aggregate fallback) when its `[name]` collides with another
   * route's basename (ambiguous CSS↔route) or the build emitted orphan shared-chunk CSS — correctness
   * over minimality. Absent entirely when the app imports no CSS. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
}

/** One edge in the metafile's import graph: the resolved `path` + the `original` specifier as written
 * (so `import "node:crypto"` records `original: "node:crypto"` even after Bun resolves it to a
 * polyfill path). Other Bun fields (`kind`, `external`) are ignored here. */
interface BunMetafileImport {
  readonly path?: string
  readonly original?: string
}
/** The slice of Bun's build metafile nifra reads: per INPUT module, the specifiers it `imports`
 * (for the `node:` guard); per JS OUTPUT, its source `entryPoint`, the `cssBundle` Bun emitted for
 * that entry, and the `inputs` (graph keys) that landed in it (for the per-route CSS map + locating
 * which chunk a flagged builtin reached). Not yet in `@types/bun`; shape per the Bun bundler docs. */
interface BunMetafileOutput {
  readonly entryPoint?: string
  readonly cssBundle?: string
  readonly inputs?: Readonly<Record<string, unknown>>
}
interface BunMetafile {
  readonly inputs?: Readonly<Record<string, { readonly imports?: readonly BunMetafileImport[] }>>
  readonly outputs: Readonly<Record<string, BunMetafileOutput>>
}

/** The `node:` specifier of an import edge, or undefined if it isn't a Node built-in. Reads the
 * `original` (as-written) specifier first, falling back to the resolved `path` (an `external` node:
 * import keeps `node:` in its path). */
const nodeBuiltinOf = (im: BunMetafileImport): string | undefined => {
  if (im.original?.startsWith("node:")) return im.original
  if (im.path?.startsWith("node:")) return im.path
  return undefined
}

/** One `node:`-builtin-in-the-client finding: the offending builtin, the emitted chunk it landed in,
 * and the shortest USER-module import chain that pulled it there (entry → … → builtin). */
export interface NodeBuiltinFinding {
  readonly builtin: string
  readonly chunk: string
  /** The shortest import path from a user entry to the builtin, as a list of display labels:
   * `[entryFile, ...as-written specifiers along the way, builtin]`, e.g.
   * `["routes/article/[slug].tsx", "../data.ts", "../db/client.ts", "postgres", "node:tls"]`. The
   * entry is its graph key (the route file); each hop is the import's *as-written* specifier; the tail
   * is the builtin. Empty only if the builtin module isn't reachable from any traced input (it always
   * is when flagged). */
  readonly chain: readonly string[]
}

/**
 * BFS the metafile import graph for the SHORTEST user-module path that pulls `builtin` into the
 * bundle, returning it as display labels `[entryFile, …as-written specifiers…, builtin]`. The frontier
 * starts at every `entryInput` (the route/user entrypoints) so the reported chain begins where the dev
 * actually wrote `import` — the actionable root, not an arbitrary internal module. Traversal crosses
 * only NON-`node:` edges (so Bun's polyfill chain never extends the path) and stops at the first edge
 * whose target is the builtin. Returns `[builtin]` if no entry reaches it (defensive; a flagged builtin
 * is reachable by construction). Pure — operates on the graph, never the emitted text.
 */
function shortestBuiltinChain(
  inputs: Readonly<Record<string, { readonly imports?: readonly BunMetafileImport[] }>>,
  entryInputs: readonly string[],
  builtin: string,
): string[] {
  // Each queue item carries the resolved-path node + the display chain to reach it (entry + the
  // as-written specifier of every hop crossed so far). `seen` dedupes nodes so the BFS is linear and
  // the first time we touch the builtin's importer is via a shortest path.
  const seen = new Set<string>(entryInputs)
  let frontier: Array<{ node: string; chain: string[] }> = entryInputs.map((node) => ({
    node,
    chain: [node],
  }))
  while (frontier.length > 0) {
    const next: Array<{ node: string; chain: string[] }> = []
    for (const { node, chain } of frontier) {
      for (const im of inputs[node]?.imports ?? []) {
        // The builtin reached via THIS edge → the chain ends here (append the builtin label). Match on
        // the same `node:` detection the finding used (`original` first, then resolved `path`).
        if (nodeBuiltinOf(im) === builtin) return [...chain, builtin]
        const target = im.path
        // Only follow edges into user (non-`node:`) modules that exist in the input graph and haven't
        // been visited — so the polyfill subtree can't lengthen the path and there are no cycles.
        if (
          target === undefined ||
          target.startsWith("node:") ||
          inputs[target] === undefined ||
          seen.has(target)
        ) {
          continue
        }
        seen.add(target)
        // Display the hop by its as-written specifier (`../db/client.ts`, `postgres`), falling back to
        // the resolved path — that's what the dev recognizes in their source, not the resolved path.
        next.push({ node: target, chain: [...chain, im.original ?? target] })
      }
    }
    frontier = next
  }
  return [builtin] // unreachable from any entry — degrade to just the builtin (shouldn't happen)
}

/**
 * Scan a build's metafile for any `node:` builtin that a USER module pulled into a CLIENT output
 * chunk, returning a sorted, deduped list of {@link NodeBuiltinFinding}s. Three graph facts combine so
 * the report is precise AND actionable:
 *  1. **What the user wrote** — only builtins imported by a NON-`node:` input count, so Bun's own
 *     polyfill chain (`node:crypto` → `node:buffer`/`node:stream`/…) doesn't bury the real cause.
 *  2. **Where it landed** — the chunk is read from the per-output `inputs`, so the error names the
 *     emitted file to look at.
 *  3. **How it got there** — the shortest import chain from a user entry to the builtin
 *     (`shortestBuiltinChain`), so the error points straight at the offending `import` line instead of
 *     leaving the dev to grep the dependency tree (the DX gap this closes).
 * Graph-based (never the emitted text), so it survives minification and can't be fooled by a string
 * literal that merely contains `"node:crypto"`. Pure + exported for unit testing. Empty ⇒ clean.
 */
export function detectNodeBuiltinsInClient(
  graph: ClientModuleGraph,
): ReadonlyArray<NodeBuiltinFinding> {
  const inputs = graph.modules
  // (1) The builtins a user (non-polyfill) module imports directly — the ones the author controls.
  const userImported = new Set<string>()
  for (const [inputKey, input] of Object.entries(inputs)) {
    if (inputKey.startsWith("node:")) continue // a polyfill importing another builtin — not the cause
    for (const im of input.imports ?? []) {
      const builtin = nodeBuiltinOf(im)
      if (builtin !== undefined) userImported.add(builtin)
    }
  }
  // The entry inputs (route/user entrypoints) — the chain BFS starts here so the reported path begins
  // at the file the dev wrote an `import` in. Each output's `entryPoint` is one such input.
  const entryInputs = [
    ...new Set(
      Object.values(graph.chunks)
        .map((o) => o.entryPoint)
        .filter((e): e is string => e !== undefined && !e.startsWith("node:")),
    ),
  ]
  // The chain per builtin is independent of the chunk, so compute it once per builtin (memoized).
  const chainCache = new Map<string, readonly string[]>()
  const chainFor = (builtin: string): readonly string[] => {
    const cached = chainCache.get(builtin)
    if (cached !== undefined) return cached
    const chain = shortestBuiltinChain(inputs, entryInputs, builtin)
    chainCache.set(builtin, chain)
    return chain
  }
  // (2) Locate which emitted chunk each user-imported builtin reached, via the per-output `inputs`.
  const findings = new Map<string, NodeBuiltinFinding>()
  for (const [outPath, out] of Object.entries(graph.chunks)) {
    for (const inputKey of out.modules) {
      if (userImported.has(inputKey)) {
        const chunk = basename(outPath)
        findings.set(`${inputKey}\0${chunk}`, {
          builtin: inputKey,
          chunk,
          chain: chainFor(inputKey),
        })
      }
    }
  }
  return [...findings.values()].sort((a, b) =>
    a.builtin === b.builtin ? a.chunk.localeCompare(b.chunk) : a.builtin.localeCompare(b.builtin),
  )
}

// ---------------------------------------------------------------------------------------------------
// `server-only` poison-import guard (§3.3/§5.1). The complement to the `.server` convention + the
// node-builtin guard: a module of PURE server logic with NO `node:` import (a secret-bearing constant,
// a server-only API call) that an author wants to FAIL LOUD if it reaches the client opts in with a
// side-effect `import "@nifrajs/web/server-only"` (Next's `import "server-only"`). On the SERVER build
// the marker is an empty no-op; the CLIENT build detects — via the SAME Bun metafile graph the
// node-builtin guard walks — any module that imports the marker AND lands in a client chunk, and fails
// the build with the import chain. Graph-based (never the emitted text), so it survives minification.
// ---------------------------------------------------------------------------------------------------

/** The marker specifier an author imports to opt a module into the client-leak guard. Matched on the
 * import edge's *as-written* `original` first (the robust signal: it's exactly what the author typed,
 * before Bun resolves it to `src/server-only.ts` / `dist/server-only.js`). */
export const SERVER_ONLY_MARKER = "@nifrajs/web/server-only"

/** True when an import edge is the `server-only` marker import. Reads the as-written `original` (the
 * specifier the author typed); falls back to the resolved `path`'s basename so a pre-resolved edge
 * (no `original`) — or a workspace-relative resolution — is still recognised. */
const isServerOnlyMarkerImport = (im: BunMetafileImport): boolean => {
  if (im.original === SERVER_ONLY_MARKER) return true
  // Defensive fallback: an edge that lost its `original` but resolved to the marker module file. The
  // marker is the only `server-only.{ts,js}` under `@nifrajs/web`, so the basename is unambiguous.
  const path = im.path
  return path !== undefined && /(^|\/)server-only\.[cm]?[jt]s$/.test(path)
}

/** One `server-only`-module-in-the-client finding: the offending module (the as-written marker-import
 * chain's tail before the marker), the emitted chunk it landed in, and the shortest USER-module import
 * chain that pulled it there (entry → … → the server-only module). */
export interface ServerOnlyFinding {
  /** The emitted client chunk the server-only module landed in (basename). */
  readonly chunk: string
  /** The shortest import path from a user entry to the server-only module, as display labels:
   * `[entryFile, ...as-written specifiers…, "<module> (marked server-only)"]`. Mirrors
   * {@link NodeBuiltinFinding.chain}; the tail names the marked module so the message reads
   * `routes/x.tsx → ../secrets.ts (marked server-only)`. */
  readonly chain: readonly string[]
}

/**
 * BFS the metafile import graph for the SHORTEST user-module path that reaches a module which imports
 * the `server-only` marker, returning it as display labels `[entryFile, …as-written specifiers…,
 * "<module> (marked server-only)"]`. Mirrors {@link shortestBuiltinChain}: the frontier starts at
 * every `entryInput` so the chain begins at the file the dev wrote an `import` in; traversal crosses
 * only NON-`node:` user edges (no cycles via `seen`); it stops at the first node whose import set
 * contains the marker (the marked module — the actionable tail), labelling that node by the as-written
 * specifier the previous hop used to reach it. Pure — operates on the graph, never the emitted text.
 */
function shortestServerOnlyChain(
  inputs: Readonly<Record<string, { readonly imports?: readonly BunMetafileImport[] }>>,
  entryInputs: readonly string[],
  markedModule: string,
  resolveTarget: (im: BunMetafileImport) => string | undefined,
): string[] {
  // The label for the marked module's tail: its as-written specifier (filled when we cross the edge
  // that reaches it) suffixed with `(marked server-only)`; the entry case uses the entry key itself.
  const tail = (label: string): string => `${label} (marked server-only)`
  // An entry that is ITSELF the marked module — the chain is just that one node.
  if (entryInputs.includes(markedModule)) return [tail(markedModule)]
  const seen = new Set<string>(entryInputs)
  let frontier: Array<{ node: string; chain: string[] }> = entryInputs.map((node) => ({
    node,
    chain: [node],
  }))
  while (frontier.length > 0) {
    const next: Array<{ node: string; chain: string[] }> = []
    for (const { node, chain } of frontier) {
      for (const im of inputs[node]?.imports ?? []) {
        // Resolve the edge's `path` to the matching INPUT-GRAPH KEY — in a real build the edge `path`
        // is absolute while the input keys are cwd-relative, so a raw equality/lookup would miss every
        // multi-hop user edge (and the chain would degrade to just the tail). The resolver maps both.
        const target = resolveTarget(im)
        if (target === undefined || target.startsWith("node:")) continue
        // The marked module reached via THIS edge → the chain ends here (label it as the marked tail
        // using the as-written specifier the author wrote, falling back to the resolved key).
        if (target === markedModule) return [...chain, tail(im.original ?? target)]
        if (seen.has(target)) continue
        seen.add(target)
        next.push({ node: target, chain: [...chain, im.original ?? target] })
      }
    }
    frontier = next
  }
  return [tail(markedModule)] // unreachable from any entry (defensive; a flagged module is reachable)
}

/**
 * Build a resolver from an import EDGE to its INPUT-GRAPH KEY. Bun's metafile records edge `path`s as
 * ABSOLUTE paths but keys `inputs` by CWD-RELATIVE paths, so a raw `inputs[im.path]` lookup misses
 * every user edge in a real build. The resolver: (1) an exact key match (the synthetic-metafile / unit
 * case); else (2) the input key the absolute path ends with (`…/secrets.ts` → `packages/web/.../secrets.ts`).
 * The longest-suffix match is taken so a shorter key can't shadow a more specific one. Pure.
 */
function inputKeyResolver(
  inputs: Readonly<Record<string, unknown>>,
): (im: BunMetafileImport) => string | undefined {
  const keys = Object.keys(inputs)
  return (im) => {
    const path = im.path
    if (path === undefined) return undefined
    if (inputs[path] !== undefined) return path // exact (synthetic keys, or already-relative paths)
    let best: string | undefined
    for (const key of keys) {
      // `/<key>` so a suffix match aligns on a path boundary (never a partial segment), and the longest
      // such key wins (the most specific file).
      if (path.endsWith(`/${key}`) && (best === undefined || key.length > best.length)) best = key
    }
    return best
  }
}

/**
 * Scan a build's metafile for any module that opts into the `server-only` marker (a side-effect
 * `import "@nifrajs/web/server-only"`) yet landed in a CLIENT output chunk, returning a sorted, deduped
 * list of {@link ServerOnlyFinding}s. Mirrors {@link detectNodeBuiltinsInClient}: it reads the SAME
 * graph facts — which inputs import the marker (the "marked" modules), which chunk each landed in (the
 * per-output `inputs`), and the shortest import chain from a user entry to it. The marker module ITSELF
 * (which imports nothing) is excluded — only the modules that *opt in* are flagged. Pure + exported for
 * unit testing. Empty ⇒ clean.
 */
export function detectServerOnlyInClient(
  graph: ClientModuleGraph,
): ReadonlyArray<ServerOnlyFinding> {
  const inputs = graph.modules
  // (1) The modules that import the marker — the ones the author opted into the guard. The marker
  // module itself is skipped: it's the import TARGET, not an opt-in (it imports nothing of its own).
  const marked = new Set<string>()
  for (const [inputKey, input] of Object.entries(inputs)) {
    if (isServerOnlyMarkerModule(inputKey)) continue
    if ((input.imports ?? []).some(isServerOnlyMarkerImport)) marked.add(inputKey)
  }
  if (marked.size === 0) return []
  // The entry inputs — the chain BFS starts here, so the reported path begins at the file the dev
  // wrote an `import` in. Same derivation as the node-builtin guard.
  const entryInputs = [
    ...new Set(
      Object.values(graph.chunks)
        .map((o) => o.entryPoint)
        .filter((e): e is string => e !== undefined && !e.startsWith("node:")),
    ),
  ]
  const resolveTarget = inputKeyResolver(inputs)
  const chainCache = new Map<string, readonly string[]>()
  const chainFor = (markedModule: string): readonly string[] => {
    const cached = chainCache.get(markedModule)
    if (cached !== undefined) return cached
    const chain = shortestServerOnlyChain(inputs, entryInputs, markedModule, resolveTarget)
    chainCache.set(markedModule, chain)
    return chain
  }
  // (2) Locate which emitted chunk each marked module reached, via the per-output `inputs`.
  const findings = new Map<string, ServerOnlyFinding>()
  for (const [outPath, out] of Object.entries(graph.chunks)) {
    for (const inputKey of out.modules) {
      if (marked.has(inputKey)) {
        const chunk = basename(outPath)
        findings.set(`${inputKey}\0${chunk}`, { chunk, chain: chainFor(inputKey) })
      }
    }
  }
  return [...findings.values()].sort((a, b) => {
    const am = a.chain[a.chain.length - 1] ?? ""
    const bm = b.chain[b.chain.length - 1] ?? ""
    return am === bm ? a.chunk.localeCompare(b.chunk) : am.localeCompare(bm)
  })
}

/** True when an INPUT graph key is the marker module file itself (`…/server-only.{ts,js}` under web).
 * Excluded from the "marked" set — the marker is the import target, not an opt-in module. */
const isServerOnlyMarkerModule = (inputKey: string): boolean =>
  /(^|\/)server-only\.[cm]?[jt]s$/.test(inputKey)

// ---------------------------------------------------------------------------------------------------
// Guard MESSAGES — one owner for both production pipelines. The Bun build (below) and the Vite/Rollup
// leak-guard plugin (plugins/vite-leak-guard.ts) both call these, so a leak reads IDENTICALLY whichever
// bundler produced it. A second bundler must not grow a second, subtly-different wording of a security
// error; that is exactly the "mostly ported" outcome the neutral graph seam exists to prevent.
// ---------------------------------------------------------------------------------------------------

/** The build-failing message for `node:` builtins that reached the client bundle. `undefined` ⇒ clean. */
export function formatNodeBuiltinLeak(
  findings: ReadonlyArray<NodeBuiltinFinding>,
): string | undefined {
  if (findings.length === 0) return undefined
  const lines = findings.map((f) =>
    f.chain.length > 1
      ? `  - ${f.builtin} reached the client bundle via ${f.chain.join(" → ")} (chunk: ${f.chunk})`
      : `  - ${f.builtin} reached the client bundle via ${f.chunk}`,
  )
  return (
    `[nifra/web] Node built-in(s) in the client bundle — move them behind a server-only path ` +
    `(a loader/action runs on the server; import the \`node:\` module there, not at a route's ` +
    `top level):\n${lines.join("\n")}`
  )
}

/** The build-failing message for `server-only`-marked modules that reached the client. `undefined` ⇒ clean. */
export function formatServerOnlyLeak(
  findings: ReadonlyArray<ServerOnlyFinding>,
): string | undefined {
  if (findings.length === 0) return undefined
  const lines = findings.map((f) =>
    f.chain.length > 1
      ? `  - server-only module reached the client bundle via ${f.chain.join(" → ")} (chunk: ${f.chunk})`
      : `  - server-only module reached the client bundle via ${f.chunk}`,
  )
  return (
    `[nifra/web] server-only module(s) in the client bundle — a module marked ` +
    `\`import "${SERVER_ONLY_MARKER}"\` reached the browser. Move it behind a server-only path ` +
    `(reach it via a loader/action, or rename it \`*.server.ts\`), so its server logic never ships ` +
    `to the client:\n${lines.join("\n")}`
  )
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
/** `[name]` Bun derives for an entrypoint: basename without extension (`users/[id].tsx` → `[id]`). */
const entryName = (file: string): string => {
  const base = basename(file)
  const dot = base.lastIndexOf(".")
  return dot === -1 ? base : base.slice(0, dot)
}

// ---------------------------------------------------------------------------------------------------
// Bundle-size report (`nifra build --report`). The raw byte + gzip size of each emitted chunk lets a
// dev catch a bundle regression at build time. Pure aggregation/formatting helpers (no fs, no Bun
// build) so they're unit-testable in isolation; the orchestrator below wires them to real outputs.
// ---------------------------------------------------------------------------------------------------

/** One emitted chunk's measured size, in raw bytes + gzipped bytes (over-the-wire weight). */
export interface ChunkSize {
  /** The emitted file's basename (e.g. `index-abc123.js`). */
  readonly name: string
  /** Raw byte length of the file. */
  readonly bytes: number
  /** Gzipped byte length (what the client actually downloads, modulo brotli). */
  readonly gzip: number
}

/** A whole build's size report — every chunk (largest first) + the totals. */
export interface SizeReport {
  /** Per-chunk sizes, sorted biggest gzip first (the regression you want to see at the top). */
  readonly chunks: readonly ChunkSize[]
  /** Sum of every chunk's raw bytes. */
  readonly totalBytes: number
  /** Sum of every chunk's gzip bytes. */
  readonly totalGzip: number
}

/**
 * Aggregate a list of measured chunks into a {@link SizeReport}: sort biggest-gzip-first (ties broken
 * by raw bytes, then name for stable output) and sum the totals. Pure — the measurement (reading the
 * file + `Bun.gzipSync`) happens in the orchestrator; this is the deterministic, unit-testable core.
 */
export function aggregateSizeReport(chunks: readonly ChunkSize[]): SizeReport {
  const sorted = [...chunks].sort(
    (a, b) => b.gzip - a.gzip || b.bytes - a.bytes || a.name.localeCompare(b.name),
  )
  let totalBytes = 0
  let totalGzip = 0
  for (const c of sorted) {
    totalBytes += c.bytes
    totalGzip += c.gzip
  }
  return { chunks: sorted, totalBytes, totalGzip }
}

/** Human-readable byte count: `B`/`KB`/`MB` with one decimal above 1 KB (e.g. `12.3 KB`). Pure. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Render a {@link SizeReport} as a terse aligned table (biggest first) with a totals row — the text
 * `nifra build --report` prints. Pure (string in, string out) so the formatting is unit-testable.
 */
export function renderSizeReport(report: SizeReport): string {
  const rows = report.chunks.map((c) => ({
    name: c.name,
    raw: formatBytes(c.bytes),
    gz: formatBytes(c.gzip),
  }))
  // Column widths from the header + every row + the totals label, so the table never clips a value.
  const nameW = Math.max(5, ...rows.map((r) => r.name.length), "Total".length)
  const rawW = Math.max(3, ...rows.map((r) => r.raw.length), formatBytes(report.totalBytes).length)
  const gzW = Math.max(4, ...rows.map((r) => r.gz.length), formatBytes(report.totalGzip).length)
  const padEnd = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length))
  const padStart = (s: string, w: number): string => " ".repeat(Math.max(0, w - s.length)) + s
  const line = (name: string, raw: string, gz: string): string =>
    `  ${padEnd(name, nameW)}  ${padStart(raw, rawW)}  ${padStart(gz, gzW)}`
  const out = [
    line("Chunk", "Raw", "Gzip"),
    line("-".repeat(nameW), "-".repeat(rawW), "-".repeat(gzW)),
    ...rows.map((r) => line(r.name, r.raw, r.gz)),
    line("Total", formatBytes(report.totalBytes), formatBytes(report.totalGzip)),
  ]
  return out.join("\n")
}

// ---------------------------------------------------------------------------------------------------
// Server-manifest drift detection (#7). `server-manifest.ts` is a committed generated file: it bakes
// the route list + the client-entry hash for a disk-less worker (`generateServerManifest`). If `routes/`
// changes but the manifest isn't regenerated, the worker serves a stale route table — a silent edge
// break. These pure helpers diff the COMMITTED manifest source against the freshly-discovered routes so
// `nifra check` (and `buildServer`) can fail with a named, actionable error before the drift ships.
// ---------------------------------------------------------------------------------------------------

/** A drift finding between a committed server-manifest and the live `routes/` tree. */
export interface ManifestDrift {
  /** Route files present in `routes/` but ABSENT from the committed manifest (the manifest is stale —
   * the new route won't be served by the worker). */
  readonly missing: readonly string[]
  /** Route files the committed manifest imports that no longer exist in `routes/` (a deleted/renamed
   * route still wired into the worker — a build/runtime break). */
  readonly extra: readonly string[]
}

// The route-relative specifiers the generated manifest imports. Both shapes `generateServerManifest`
// emits are matched: eager `import * as m0 from "./routes/x.tsx"` and lazy `() => import("./routes/x")`.
// Captures the path inside the quotes; the caller strips the routes-dir prefix to compare with discovery.
const MANIFEST_IMPORT = /(?:import\s+\*\s+as\s+\w+\s+from|import)\s*\(?\s*["']([^"']+)["']\)?/g
// The baked client-entry line: `export const clientEntry = "…"`.
const MANIFEST_CLIENT_ENTRY = /export\s+const\s+clientEntry\s*=\s*["']([^"']+)["']/

/**
 * Extract the route-relative file list the committed server-manifest imports, normalized to the same
 * `routes/`-relative keys `discoverRoutes` produces (e.g. `docs/index.tsx`). `routesPrefix` is the
 * specifier prefix the manifest used for the routes dir (default `./routes/`, what `buildServer`'s
 * default `resolve` emits). Only import specifiers under that prefix are route files; the
 * `@nifrajs/web` import (and any other bare specifier) is ignored. Pure — operates on source text.
 */
export function parseManifestRouteFiles(source: string, routesPrefix = "./routes/"): string[] {
  const files = new Set<string>()
  for (const match of source.matchAll(MANIFEST_IMPORT)) {
    const spec = match[1]
    if (spec === undefined || !spec.startsWith(routesPrefix)) continue
    files.add(spec.slice(routesPrefix.length))
  }
  return [...files].sort()
}

/** The baked `clientEntry` URL in a committed server-manifest, or `undefined` if absent. Pure. */
export function parseManifestClientEntry(source: string): string | undefined {
  return MANIFEST_CLIENT_ENTRY.exec(source)?.[1]
}

// The baked asset lines `generateServerManifest` emits: `export const styles = […]` then
// `export const routeStyles = {…}`, each a JSON literal followed by the next `export const`. The capture
// is `[\s\S]*?` (multi-line, non-greedy up to the following `export const`) NOT `.+` - a committed
// manifest carries no format-ignore pragma, so a formatter can wrap a long `routeStyles` map across lines;
// a single-line regex would then miss it and silently DROP every baked stylesheet on re-sync.
const MANIFEST_STYLES = /export const styles = ([\s\S]*?)\nexport const /
const MANIFEST_ROUTE_STYLES = /export const routeStyles = ([\s\S]*?)\nexport const /

/** Parse a baked JSON literal captured from a committed manifest, tolerating a formatter's TRAILING COMMAS
 * (biome/prettier add one when wrapping a multi-line array/object; strict `JSON.parse` would reject it).
 * Only a comma immediately before a closing `]`/`}` is stripped, so commas inside string values are safe. */
function parseManifestLiteral(raw: string): unknown {
  return JSON.parse(raw.replace(/,(\s*[\]}])/g, "$1"))
}

/** The baked top-level `styles` array in a committed server-manifest (empty if absent/unparseable). Pure. */
export function parseManifestStyles(source: string): string[] {
  const raw = MANIFEST_STYLES.exec(source)?.[1]
  if (raw === undefined) return []
  try {
    const value = parseManifestLiteral(raw)
    return Array.isArray(value) ? (value as string[]) : []
  } catch {
    return []
  }
}

/** The baked per-route `routeStyles` map in a committed server-manifest (empty if absent/unparseable). Pure. */
export function parseManifestRouteStyles(source: string): Record<string, string[]> {
  const raw = MANIFEST_ROUTE_STYLES.exec(source)?.[1]
  if (raw === undefined) return {}
  try {
    const value = parseManifestLiteral(raw)
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string[]>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Re-emit a committed server-manifest from a freshly-discovered route tree, PRESERVING its baked
 * client-asset references (`clientEntry` / `styles` / `routeStyles`) and its eager-vs-lazy shape. This is
 * what makes `nifra sync-manifest` a route-table refresh (renamed / added / removed routes) that does NOT
 * need a full build. It deliberately does NOT rebuild the client bundle: a brand-new HYDRATING route still
 * needs a full build so its client chunk exists - this only re-syncs the server manifest's route table.
 * Pure: `source` + the discovered `manifest` in, new source out.
 */
export function resyncServerManifestSource(
  source: string,
  manifest: Parameters<typeof generateServerManifest>[0],
  routesPrefix: string,
): string {
  return generateServerManifest(manifest, {
    resolve: (file) => `${routesPrefix}${file}`,
    clientEntry: parseManifestClientEntry(source) ?? "",
    styles: parseManifestStyles(source),
    routeStyles: parseManifestRouteStyles(source),
    lazy: source.includes("const loaders ="),
  })
}

/**
 * Diff the route files a committed server-manifest imports against the files freshly discovered in
 * `routes/`. Returns the `missing` (in routes/, not in manifest — stale manifest) and `extra` (in
 * manifest, gone from routes/ — dangling import) sets. Empty arrays ⇒ in sync. Pure — the caller
 * supplies both file lists (the committed source is parsed via {@link parseManifestRouteFiles}; the
 * fresh list comes from `discoverRoutes`). Lists need not be pre-sorted; the result is sorted.
 */
export function diffManifestRoutes(
  manifestFiles: readonly string[],
  discoveredFiles: readonly string[],
): ManifestDrift {
  const inManifest = new Set(manifestFiles)
  const inRoutes = new Set(discoveredFiles)
  const missing = discoveredFiles.filter((f) => !inManifest.has(f)).sort()
  const extra = manifestFiles.filter((f) => !inRoutes.has(f)).sort()
  return { missing, extra }
}

/** True when a drift report is clean (no missing + no extra routes). */
export function isManifestInSync(drift: ManifestDrift): boolean {
  return drift.missing.length === 0 && drift.extra.length === 0
}

/**
 * Format a {@link ManifestDrift} as a named, actionable error message, or `undefined` when in sync.
 * Names the exact missing/extra routes + the one fix (regenerate the manifest by re-running the build).
 * `manifestPath` is shown for the dev to locate the stale file. Pure.
 */
export function formatManifestDrift(
  drift: ManifestDrift,
  manifestPath = "server-manifest.ts",
): string | undefined {
  if (isManifestInSync(drift)) return undefined
  const lines: string[] = [
    `[nifra/web] server-manifest drift — \`${manifestPath}\` is out of sync with routes/.`,
  ]
  if (drift.missing.length > 0) {
    lines.push(
      `  Missing (in routes/, not in the manifest — these routes won't be served): ${drift.missing.join(", ")}`,
    )
  }
  if (drift.extra.length > 0) {
    lines.push(
      `  Extra (imported by the manifest, gone from routes/ — a dangling import): ${drift.extra.join(", ")}`,
    )
  }
  lines.push("  Fix: re-run the build to regenerate the server manifest, then commit it.")
  return lines.join("\n")
}

/**
 * Build the client bundle for a file-routed app. Writes the hashed assets + `manifest.json` to
 * `outDir` and returns the manifest. Throws (with the bundler logs) on build failure — never
 * silently ships a broken bundle.
 */
export async function buildClient(options: BuildClientOptions): Promise<BuildManifest> {
  const { routesDir, outDir, clientModule } = options
  const resolve = options.resolve ?? ((file: string) => `${routesDir}/${file}`)
  const publicPath = options.publicPath ?? "/assets/"
  mkdirSync(outDir, { recursive: true })

  const routeManifest = discoverRoutes(routesDir)
  // The bootstrap's filename is `_nifra`-namespaced (not `entry.ts`) so its `[name]` can't collide with
  // a user route named `entry.tsx` when the CSS mapping below excludes the bootstrap's aggregate CSS.
  const mode = options.minify === false ? "development" : "production"
  // PUBLIC_*-prefixed env → client define (Vite/Next convention). Sourced from the build env (`Bun.env`,
  // falling back to `process.env`). Only prefixed vars are baked in; unprefixed secrets stay undefined
  // in the client via the bare `process.env` → `({})` define below. Caller's `options.define` wins (it's
  // layered after these in the `define` object). `Bun` may be absent under non-Bun typecheck — guard it.
  const buildEnv = (typeof Bun !== "undefined" ? Bun.env : undefined) ?? process.env
  const publicDefines = publicEnvDefines(options.publicEnvPrefix ?? "PUBLIC_", buildEnv)
  // Keep the generated source beside the project, not inside `outDir`: module resolution starts at the
  // importing file, so an absolute `--out /tmp/deploy` must still resolve the app's dependencies.
  // A unique directory also avoids clobbering a user file or colliding with parallel builds.
  const entryDir = mkdtempSync(resolvePath(dirname(routesDir), ".nifra-client-"))
  const entryFile = `${entryDir}/_nifra-entry.ts`
  // A client bundle has no Node `process`; provide a minimal one so a stray bare `process` reference in
  // an app module doesn't crash hydration (`process.env.*` reads are handled at compile time by `define`).
  writeFileSync(
    entryFile,
    `globalThis.process ??= { env: {} };\n${generateClientEntry(routeManifest, { clientModule, resolve })}`,
  )

  // Every unique route/layout/`_404` file (sorted, stable), as ADDITIONAL entrypoints — Bun emits a
  // named chunk per file that the bootstrap's lazy `import()` dedupes to (verified), so the manifest
  // can map each route to its chunk URLs for matched-route preload. `resolve(file)` is the same
  // specifier the bootstrap imports, so the entrypoint + lazy import are the same module (dedup).
  const routeFiles = [
    ...new Set([
      ...routeManifest.routes.map((r) => r.file),
      ...Object.values(routeManifest.layouts).map((l) => l.file),
      ...(routeManifest.notFound ? [routeManifest.notFound.file] : []),
    ]),
  ].sort()

  // `metafile: true` asks Bun for the input/output graph — specifically `outputs[js].entryPoint`
  // (the source file) + `outputs[js].cssBundle` (that entry's emitted stylesheet). It's the robust
  // entry→CSS link for per-route splitting: keyed by the unique source path, so it survives
  // same-basename collisions (`index.tsx` + `blog/index.tsx`) that a filename match can't. Not yet in
  // `@types/bun`'s `BuildConfig`, so spread it in (spread props skip the excess-property check).
  const buildExtras = { metafile: true }
  const result = await (async () => {
    try {
      return await Bun.build({
        entrypoints: [entryFile, ...routeFiles.map(resolve)],
        outdir: outDir,
        target: "browser",
        naming: "[name]-[hash].[ext]",
        publicPath,
        splitting: true, // one chunk per lazily-imported route; shared deps deduped into shared chunks
        // `import "./x.css"` in a route/component → bundled, minified, content-hashed `.css` asset (Bun
        // strips the import from the JS; CSS bundling is on by default since Bun 1.2). Mapped to routes
        // below — both the aggregate and per-route — via the metafile, for `<link>` injection.
        ...buildExtras,
        minify: options.minify ?? true,
        plugins: [
          reactDedupePlugin(routesDir),
          preactDedupePlugin(routesDir),
          svelteDedupePlugin(routesDir),
          serverOnlyEmptyPlugin(),
          ...(options.plugins ?? []),
        ],
        ...(options.conditions ? { conditions: [...options.conditions] } : {}),
        // Replace `process.env.*` at compile time so an app module reading config off `process.env` doesn't
        // hit a `process is not defined` crash in the browser. Bun does longest-match: NODE_ENV resolves to
        // the build mode (React's prod/dev branch); each PUBLIC_* var resolves to its baked VALUE; every
        // other `process.env.X` becomes undefined (the bare `process.env` → `({})` fallback — so secrets
        // never leak). Callers can override any of these via `options.define` (layered last).
        define: {
          "process.env": "({})",
          "process.env.NODE_ENV": JSON.stringify(mode),
          ...publicDefines,
          ...options.define,
        },
      })
    } finally {
      rmSync(entryDir, { recursive: true, force: true })
    }
  })()
  if (!result.success) {
    throw new Error(
      `[nifra/web] client build failed:\n${result.logs.map((l) => String(l)).join("\n")}`,
    )
  }

  // #4: a `node:` builtin (e.g. `node:crypto`) pulled into a CLIENT chunk builds fine (Bun substitutes
  // a browser polyfill) but breaks/leaks at runtime. Fail the build with a named, actionable error
  // instead — caught at build time, not by a confused user in the browser. Graph-based (the metafile's
  // per-output `inputs`), so it can't false-positive on a `"node:..."` string literal and survives
  // minification. Only the client build runs this; the server build's `node:` imports are legitimate.
  const clientMeta = (result as unknown as { metafile?: BunMetafile }).metafile
  const clientGraph = fromBunMetafile(clientMeta)
  // #4: a `node:` builtin (e.g. `node:crypto`) pulled into a CLIENT chunk builds fine (Bun substitutes a
  // browser polyfill) but breaks/leaks at runtime. Fail with the chain (entry → … → builtin), through the
  // SHARED formatter so the Vite pipeline's identical guard reads byte-for-byte the same.
  const nodeBuiltinLeak = formatNodeBuiltinLeak(detectNodeBuiltinsInClient(clientGraph))
  if (nodeBuiltinLeak !== undefined) throw new Error(nodeBuiltinLeak)

  // §3.3/§5.1: a module that opted into the `server-only` marker yet reached a CLIENT chunk — catches
  // pure-server logic (a secret, a server-only API call) carrying no `node:` import and not named
  // `*.server`, so neither other guard fires. Same shared formatter as above.
  const serverOnlyLeak = formatServerOnlyLeak(detectServerOnlyInClient(clientGraph))
  if (serverOnlyLeak !== undefined) throw new Error(serverOnlyLeak)

  // Rename any chunk whose basename isn't URL-safe (dynamic-route files become `[slug]-hash.js`) and
  // rewrite the references — otherwise the lazy import 404s and the route silently never hydrates.
  const renamed = sanitizeOutputNames(result.outputs)
  const toUrl = (path: string): string =>
    `${publicPath}${renamed.get(basename(path)) ?? basename(path)}`
  // Entry-point outputs come back in entrypoint order: [bootstrap, ...routeFiles]. Map each route file
  // to its chunk URL by that order (guarded against drift), then a route's chunks = its layout chain +
  // own file.
  const entryPoints = result.outputs.filter((o) => o.kind === "entry-point")
  const bootstrap = entryPoints[0]
  if (bootstrap === undefined) throw new Error("[nifra/web] build produced no entry-point output")
  if (entryPoints.length !== routeFiles.length + 1) {
    throw new Error(
      `[nifra/web] expected ${routeFiles.length + 1} entry-point outputs (bootstrap + ${routeFiles.length} routes), got ${entryPoints.length}`,
    )
  }
  const fileToChunk = new Map<string, string>()
  routeFiles.forEach((file, i) => {
    const out = entryPoints[i + 1] // in range — length checked above
    if (out !== undefined) fileToChunk.set(file, toUrl(out.path))
  })
  const chunksFor = (chainFiles: readonly string[]): string[] =>
    chainFiles.map((f) => fileToChunk.get(f)).filter((u): u is string => u !== undefined)
  const routes: Record<string, string[]> = {}
  for (const route of routeManifest.routes) {
    routes[route.id] = chunksFor([
      ...route.layoutIds.map((id) => routeManifest.layouts[id]?.file ?? ""),
      route.file,
    ])
  }
  if (routeManifest.notFound) routes._404 = chunksFor([routeManifest.notFound.file])

  // CSS — aggregate: an `import "./x.css"` anywhere → a content-hashed `.css` asset (Bun strips the
  // import from the JS). The bootstrap lazily imports every route, so its **aggregate** stylesheet is
  // the whole app's CSS — the always-safe fallback `createWebApp` links when a route has no per-route
  // entry below. Fallback to all CSS assets if Bun emitted no distinct aggregate.
  const bootstrapName = entryName(entryFile) // `_nifra-entry`
  const cssNameOf = (path: string): string => {
    const base = basename(path)
    return base.slice(0, base.lastIndexOf("-")) // strip `-${hash}.css`
  }
  const cssAssets = result.outputs.filter((o) => o.kind === "asset" && o.path.endsWith(".css"))
  const aggregate = cssAssets
    .filter((o) => cssNameOf(o.path) === bootstrapName)
    .map((o) => toUrl(o.path))
  const css: readonly string[] =
    aggregate.length > 0 ? aggregate : cssAssets.map((o) => toUrl(o.path))

  // CSS — per-route: each route/layout file is its own entrypoint, so the build metafile records its
  // `cssBundle` — exactly the CSS that file's subtree uses (shared-component CSS is inlined into each
  // consumer; verified). Keyed by the metafile's unique source `entryPoint`, so it survives
  // same-basename collisions (`index.tsx` + `blog/index.tsx`) that a filename match can't. A page then
  // links only its layout chain + own CSS (deduped); an empty array means the page needs no CSS at all.
  // Absent (→ aggregate fallback) only if Bun emits no metafile/cssBundle — never silently incomplete.
  const cwd = process.cwd()
  const cssByEntry = new Map<string, string>()
  for (const out of Object.values(clientMeta?.outputs ?? {})) {
    if (out.entryPoint !== undefined && out.cssBundle !== undefined) {
      cssByEntry.set(resolvePath(cwd, out.entryPoint), toUrl(out.cssBundle))
    }
  }
  const stylesFor = (chainFiles: readonly string[]): readonly string[] => {
    const urls = chainFiles
      .map((f) => (f ? cssByEntry.get(resolvePath(resolve(f))) : undefined))
      .filter((u): u is string => u !== undefined)
    return [...new Set(urls)]
  }
  const routeStyles: Record<string, readonly string[]> = {}
  if (css.length > 0 && cssByEntry.size > 0) {
    for (const route of routeManifest.routes) {
      routeStyles[route.id] = stylesFor([
        ...route.layoutIds.map((id) => routeManifest.layouts[id]?.file ?? ""),
        route.file,
      ])
    }
    if (routeManifest.notFound) routeStyles._404 = stylesFor([routeManifest.notFound.file])
  }

  // Copy `public/` into the output next to the hashed assets. A missing directory is normal (most
  // apps have none) and must not fail the build.
  const publicDir = options.publicDir ?? "public"
  const publicFiles = existsSync(publicDir) ? await copyPublicDir(publicDir, outDir) : []

  const manifest: BuildManifest = {
    entry: toUrl(bootstrap.path),
    assets: result.outputs.map((o) => toUrl(o.path)),
    routes,
    ...(publicFiles.length > 0 ? { publicFiles } : {}),
    ...(css.length > 0 ? { css } : {}),
    ...(Object.keys(routeStyles).length > 0 ? { routeStyles } : {}),
  }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2))
  return manifest
}

export interface BuildServerOptions {
  /** The `routes/` directory to discover (absolute path). */
  readonly routesDir: string
  /** The worker entry module (absolute path) — your `worker.ts`. It imports `{ manifest, clientEntry }`
   * from the generated `./server-manifest`, builds `createWebApp`, and `export default toFetchHandler(app)`. */
  readonly serverEntry: string
  /** Output directory for the bundled worker (absolute path). */
  readonly outDir: string
  /** The content-hashed client entry URL (from `buildClient`'s manifest) — **baked** into the generated
   * server manifest, since a disk-less worker can't read `manifest.json` at runtime. */
  readonly clientEntry: string
  /** The app's aggregate stylesheet URLs (`buildClient`'s `BuildManifest.css`) — baked into the generated
   * manifest so the server entry hands them to `createWebApp` (→ `<link rel="stylesheet">`). Omit ⇒ no CSS
   * link (the built SSR page would otherwise render unstyled). */
  readonly styles?: readonly string[] | undefined
  /** Per-route stylesheet URLs (`buildClient`'s `BuildManifest.routeStyles`) — baked alongside `styles`. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>> | undefined
  /** Route/layout file → import specifier in the generated manifest (default: a relative path from the
   * manifest's location — written next to `serverEntry` — to `routesDir`). */
  readonly resolve?: (file: string) => string
  /** Filename for the generated server-manifest module, written next to `serverEntry` (default
   * `"server-manifest.ts"`); your `serverEntry` imports it as `./server-manifest`. */
  readonly manifestFile?: string
  /** Adapter build plugins (e.g. `solidBunPlugin("ssr")` — Solid routes need their SSR transform at
   * build time; React's JSX is Bun-native and needs none). */
  readonly plugins?: readonly BunPlugin[]
  /** `Bun.build` resolution conditions (default `["workerd", "edge-light", "browser"]`) — selects each
   * dependency's edge build. */
  readonly conditions?: readonly string[]
  /** Compile-time replacements (default `{ "process.env.NODE_ENV": '"production"' }` → production
   * React/Solid on the edge). Pass an explicit object to override (e.g. `{}` to opt out). */
  readonly define?: Readonly<Record<string, string>>
  /** Minify the output (default `true`). */
  readonly minify?: boolean
  /** `Bun.build` target (default `"browser"` — the right shape for edge runtimes: Cloudflare Workers,
   * Vercel Edge, Deno, Deno Deploy). Use `"node"` for a `@nifrajs/node` server (so `node:*` built-ins
   * stay external), or `"bun"` for a Bun server. The default `conditions` + the edge resolve shims
   * only apply to the `"browser"` target; `"node"`/`"bun"` resolve their own renderer builds via the
   * matching condition. */
  readonly target?: "browser" | "node" | "bun"
  /** **Lazy/code-split routes** (default `false`): emit `() => import(route)` loaders + bundle with
   * `splitting`, so each route is its own chunk loaded on first request (smaller cold-start parse)
   * instead of all parsed at boot. The output becomes the worker entry **+ chunk files** in `outDir`
   * — on Cloudflare, ship them with wrangler's `no_bundle` + `find_additional_modules` + an ESModule
   * `rule` (Node/Deno import the chunks natively). Eager (one self-contained file) stays the default. */
  readonly lazy?: boolean
}

/** The built worker bundle — point your `wrangler.toml`'s `main` at `worker`. */
export interface ServerBuild {
  /** Path to the bundled, self-contained worker entry. */
  readonly worker: string
  /** Paths of every emitted output (entry + any code-split chunks) — what to ship to the platform. */
  readonly outputs: readonly string[]
}

/**
 * react-dom's `exports["./server"]` maps the `bun` condition to a Bun-API server build that crashes
 * on workerd, and `Bun.build` always applies the `bun` condition (it wins over `workerd`/`edge-light`),
 * so conditions alone can't select the edge build. This shim pins `react-dom/server` to its edge build
 * (`server.edge.js`, which exports `renderToReadableStream`). A no-op when nothing imports react-dom
 * (e.g. a Solid worker) — the resolver only runs on a match.
 */
const reactDomEdgePlugin = (from: string): BunPlugin => ({
  name: "nifra-react-dom-edge",
  setup(build) {
    build.onResolve({ filter: /^react-dom\/server$/ }, () => ({
      path: Bun.resolveSync("react-dom/server.edge", from),
    }))
  },
})

/**
 * Dedupe React to a single copy. A `file:`-linked package can ship its OWN `react` under its own
 * node_modules, so the bundle ends up with two React cores — each with its own hook dispatcher — and SSR
 * throws the cryptic `null is not an object (evaluating '…H.useState')` (the second renderer's dispatcher
 * is null). This was the #1 time-sink in app builds. Pinning `react` + its JSX runtimes to ONE resolved
 * copy (the app's, from `from`) guarantees a single dispatcher; `react-dom`, which imports `react`, then
 * shares it — so the class can't occur rather than needing a named error. No-op when React isn't used
 * (an unresolvable spec is skipped; the resolver only fires on an exact match). React core is
 * condition-agnostic, so pinning it doesn't disturb the edge/browser/server conditions that select
 * react-dom's build.
 */
const REACT_DEDUPE_SPECS = ["react", "react/jsx-runtime", "react/jsx-dev-runtime"] as const
export const reactDedupePlugin = (from: string): BunPlugin => ({
  name: "nifra-react-dedupe",
  setup(build) {
    for (const spec of REACT_DEDUPE_SPECS) {
      let resolved: string
      try {
        resolved = Bun.resolveSync(spec, from)
      } catch {
        continue // React (or this subpath) isn't resolvable here — nothing to dedupe
      }
      const escaped = spec.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")
      build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: resolved }))
    }
  },
})

/**
 * Dedupe Preact to a single copy — the Preact analogue of `reactDedupePlugin`, closing the same class of
 * bug for the Preact framework (which had NO build-time dedup before). A `file:`-linked package can ship
 * its OWN `preact`, so the bundle ends up with two Preact cores; since `preact-render-to-string` mutates
 * `preact`'s shared `options` global and `preact/hooks` writes the SAME global, two copies → two `options`
 * → SSR throws `undefined is not an object (… __H)` (the vnode's hook state was set up on the other copy).
 * Pinning `preact` + its hooks/compat/jsx subpaths to ONE resolved copy (the app's, from `from`) makes the
 * renderer and the components share one core. No-op when Preact isn't used (an unresolvable spec is
 * skipped). Preact core is condition-agnostic, so pinning it doesn't disturb any condition selection — and
 * unlike react-dom there is no edge-vs-server build to preserve, so pinning the subpaths is safe.
 */
const PREACT_DEDUPE_SPECS = [
  "preact",
  "preact/hooks",
  "preact/compat",
  "preact/jsx-runtime",
  "preact/jsx-dev-runtime",
] as const
export const preactDedupePlugin = (from: string): BunPlugin => ({
  name: "nifra-preact-dedupe",
  setup(build) {
    for (const spec of PREACT_DEDUPE_SPECS) {
      let resolved: string
      try {
        resolved = Bun.resolveSync(spec, from)
      } catch {
        continue // Preact (or this subpath) isn't resolvable here — nothing to dedupe
      }
      const escaped = spec.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")
      build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: resolved }))
    }
  },
})

/**
 * Dedupe Svelte to a single copy — the Svelte analogue of `reactDedupePlugin`/`preactDedupePlugin`, closing
 * the same class of bug for Svelte (which had NO build-time dedup before). A workspace- or file-linked
 * `@nifrajs/web-svelte` can resolve its OWN `svelte` (e.g. a sibling repo's install store) while the app's
 * components resolve another — SAME version, two physical copies. Svelte 5's client runtime
 * (`svelte/internal/client`) holds module-level component-context state, so two copies means the compiled
 * components register on one runtime while `hydrate` runs on the other → hydration throws
 * `Cannot read properties of undefined (reading 'call')` and the server-rendered markup is wiped.
 *
 * Pin every `svelte` + `svelte/internal/*` import to the ONE copy resolvable from `from` (the app root) so
 * the renderer (`hydrate`/`mount`) and the compiled components share one runtime. Unlike react/preact (a
 * fixed subpath list), Svelte has many internal subpaths, so each matched import is resolved dynamically.
 * `svelte/compiler` (build-time only, not in the bundle) doesn't match the filter and is left alone. No-op
 * when Svelte isn't used / isn't resolvable from `from`.
 */
export const svelteDedupePlugin = (from: string): BunPlugin => ({
  name: "nifra-svelte-dedupe",
  setup(build) {
    build.onResolve({ filter: /^svelte($|\/internal\/)/ }, (args) => {
      try {
        return { path: Bun.resolveSync(args.path, from) }
      } catch {
        return undefined // not resolvable from the app root — leave Bun's default resolution
      }
    })
  },
})

/**
 * Remix-style `.server` convention for the CLIENT build. A module named `*.server.ts(x)` (`db.server.ts`,
 * `auth.server.ts`, …) is server-only — empty it in the browser bundle so its (possibly `node:` / native /
 * Capacitor) import subtree never reaches the client. The body is CJS-with-a-Proxy so any named OR default
 * import resolves to `undefined` rather than a "missing export" bundle error (verified), and the real
 * import subtree is gone. The complement to the node-builtin guard: when a server-only import is co-located
 * in a route file (so it can't be tree-shaken out and the guard fails loud), moving it into a `*.server`
 * module is the fix. CLIENT-only — buildServer keeps the real module, which runs server-side.
 */
const SERVER_ONLY_MODULE = /\.server(\.[cm]?[jt]sx?)?$/
export const serverOnlyEmptyPlugin = (): BunPlugin => ({
  name: "nifra-server-only-empty",
  setup(build) {
    build.onLoad({ filter: SERVER_ONLY_MODULE }, () => ({
      contents: "module.exports = new Proxy({}, { get: () => undefined })",
      loader: "js",
    }))
  },
})

/**
 * `solid-js/web` selects its **server** runtime (`renderToStream`) via the `worker` condition, but
 * `Bun.build` 1.3.14 **segfaults** when the `worker` condition is active (https://bun.report). And
 * without `worker`, `browser` (which precedes the other server conditions in solid's exports map)
 * wins → the *dom* runtime, which can't SSR. So this shim pins `solid-js/web` straight to its server
 * build, sidestepping the crashing condition. Lazy (resolved on match) + a no-op when nothing imports
 * `solid-js/web` (e.g. a React worker). Drop it (and use the `worker` condition) once Bun is fixed.
 */
const solidWebServerPlugin = (from: string): BunPlugin => ({
  name: "nifra-solid-web-server",
  setup(build) {
    build.onResolve({ filter: /^solid-js\/web$/ }, () => {
      // solid's `worker`/`node`/`deno` conditions all map to ./web/dist/server.js (its server build).
      const pkg = Bun.resolveSync("solid-js/package.json", from)
      return { path: pkg.replace(/package\.json$/, "web/dist/server.js") }
    })
  },
})

/**
 * Build a self-contained **worker bundle** for a file-routed app on a disk-less edge (Cloudflare
 * Workers / workerd). Discovers routes (build-time fs), codegens the static-import server manifest
 * (`generateServerManifest`, written next to `serverEntry`), then bundles `serverEntry` with
 * `Bun.build` using **edge conditions** + the adapter's SSR plugins. The output imports no `node:fs`
 * and does no dynamic-path import, so it runs on workerd: point `wrangler.toml`'s `main` at it and
 * serve the client assets via Workers Assets. Throws (with the bundler logs) on failure — never
 * silently ships a broken worker.
 */
export async function buildServer(options: BuildServerOptions): Promise<ServerBuild> {
  const { routesDir, serverEntry, outDir, clientEntry, styles, routeStyles } = options
  const entryDir = dirname(serverEntry)
  const manifestFile = options.manifestFile ?? "server-manifest.ts"
  // Default: import routes relative from the generated manifest (next to serverEntry) to routesDir.
  const rel = relative(entryDir, routesDir).replaceAll("\\", "/")
  const resolve = options.resolve ?? ((file: string) => `./${rel}/${file}`)
  mkdirSync(outDir, { recursive: true })

  const lazy = options.lazy ?? false
  const target = options.target ?? "browser"
  // Edge (browser) target: Bun's `bun` condition contaminates react-dom's server build + the `worker`
  // condition segfaults Bun.build on solid, so force the edge/server builds via shims. The `node`/`bun`
  // targets resolve those correctly via their own condition, so the shims (and edge conditions) don't
  // apply — defaults become `[target]` (e.g. react-dom → server.node.js under `node`).
  const edge = target === "browser"
  const conditions = options.conditions ?? (edge ? ["workerd", "edge-light", "browser"] : [target])
  const manifest = discoverRoutes(routesDir)
  writeFileSync(
    `${entryDir}/${manifestFile}`,
    generateServerManifest(manifest, { resolve, clientEntry, styles, routeStyles, lazy }),
  )

  const result = await Bun.build({
    entrypoints: [serverEntry],
    outdir: outDir,
    target,
    conditions: [...conditions],
    define: {
      ...(options.define ?? { "process.env.NODE_ENV": '"production"' }),
      // Tag every BUNDLED SSR output so @nifrajs/web-react's react-dom adapter takes the static
      // (bundled, deduped) react-dom instead of re-rooting react-dom/server to a DISK copy at runtime.
      // A `target:"bun"` bundle still has `Bun.resolveSync` under the Bun runtime, so without this tag the
      // adapter re-imports a SECOND react-dom from node_modules — a second React core whose hook dispatcher
      // is null for the bundled components → SSR throws `…H.useRef of null`. Always set (a structural fact
      // of bundling, layered after any caller `define` so it can't be overridden). Unbundled Bun runtimes
      // (nifra dev/start, nifra_render) never define it, so they still re-root — the dev dual-install fix.
      "process.env.NIFRA_SSR_BUNDLED": '"1"',
    },
    minify: options.minify ?? true,
    // Lazy → one chunk per route (loaded on first request); eager → a single self-contained file.
    splitting: lazy,
    plugins: [
      ...(edge ? [reactDomEdgePlugin(entryDir), solidWebServerPlugin(entryDir)] : []),
      reactDedupePlugin(entryDir),
      preactDedupePlugin(entryDir),
      ...(options.plugins ?? []),
    ],
  })
  if (!result.success) {
    throw new Error(
      `[nifra/web] server build failed:\n${result.logs.map((l) => String(l)).join("\n")}`,
    )
  }
  const entryOutput = result.outputs.find((o) => o.kind === "entry-point")
  if (entryOutput === undefined) {
    throw new Error("[nifra/web] server build produced no entry-point output")
  }
  return { worker: entryOutput.path, outputs: result.outputs.map((o) => o.path) }
}

// ===================================================================================================
// `nifra build --target` — package the engine above into one command that emits a full deploy dir.
//
// An app already declares everything the build needs through nifra's conventions: `adapter` +
// `clientModule` (nifra.config.ts / framework.ts), an optional `backend` (backend.ts), and `routes/`.
// The ONLY thing apps used to hand-write per target was the server entry (`_worker.ts`, `server-bun.ts`,
// …) — so we GENERATE it here (per target) instead of asking each app to ship five near-identical files.
// ===================================================================================================

/** A deploy target `nifra build --target <t>` can emit. `static` is pure SSG (no server). */
export const BUILD_TARGETS = ["bun", "node", "deno", "cf-pages", "vercel", "static"] as const
export type BuildTarget = (typeof BUILD_TARGETS)[number]

/** A type guard narrowing an arbitrary string to a {@link BuildTarget}. */
export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value)
}

/**
 * Codegen the per-target **server entry** module (source text) for `buildServer` to bundle. It imports
 * the app's `adapter` (from `framework.ts`), the optional `backend` (from `backend.ts`), and the
 * generated `{ manifest, clientEntry }` (from `./server-manifest`), builds `createWebApp`, then wires
 * the right host:
 *   - `cf-pages` / `vercel`: `export default` the fetch handler (the platform serves /assets/* itself).
 *   - `deno`: same fetch-handler default, plus `Deno.serve` self-host when run directly.
 *   - `bun` / `node`: a self-hosting server that ALSO serves the client bundle from disk (those
 *     runtimes have a filesystem; the static `/assets/*` sit next to the entry).
 * `adapterImport`/`backendImport` are the specifiers the entry uses (relative to where it's written) —
 * `buildServer` writes the entry next to `serverEntry`, so they're resolved from there. Pure (string in,
 * string out) so the generation is unit-testable without a real build.
 */
export function generateServerEntry(options: {
  readonly target: BuildTarget
  /** Import specifier for the module exporting `adapter` (e.g. `"../framework.ts"`). */
  readonly adapterImport: string
  /** Import specifier for the module exporting `backend`, or `undefined` for a frontend-only app. */
  readonly backendImport?: string
  /** Document `<title>` passed to `createWebApp`. */
  readonly title?: string
}): string {
  const { target, adapterImport, backendImport, title = "nifra" } = options
  if (target === "static") {
    throw new Error("[nifra/web] generateServerEntry: `static` has no server entry (SSG only)")
  }
  const lines: string[] = ['import { createWebApp } from "@nifrajs/web"']
  if (backendImport !== undefined) lines.push('import { inProcessClient } from "@nifrajs/client"')
  lines.push(`import { adapter } from ${JSON.stringify(adapterImport)}`)
  if (backendImport !== undefined) {
    lines.push(`import { backend } from ${JSON.stringify(backendImport)}`)
  }
  lines.push('import { clientEntry, manifest, styles, routeStyles } from "./server-manifest"')
  // cf-pages/vercel/deno need the fetch-handler shape; bun/node call app.fetch directly.
  const usesToFetch = target === "cf-pages" || target === "vercel" || target === "deno"
  if (usesToFetch) lines.push('import { toFetchHandler } from "@nifrajs/core/server"')
  if (target === "node") lines.push('import { serve } from "@nifrajs/node"')
  lines.push(
    "",
    "const app = createWebApp({",
    "  adapter,",
    "  manifest,",
    "  clientEntry,",
    "  styles,",
    "  routeStyles,",
    ...(backendImport !== undefined ? ["  api: inProcessClient(backend),"] : []),
    `  title: ${JSON.stringify(title)},`,
    "})",
    "",
  )

  if (target === "cf-pages") {
    // Cloudflare Pages advanced mode: `_routes.json` serves /assets/* from the CDN; everything else
    // falls through to this fetch handler (SSR). The default export is the handler object.
    lines.push("export default toFetchHandler(app)")
    return `${lines.join("\n")}\n`
  }
  if (target === "vercel") {
    lines.push(
      "// Vercel Edge Function — Vercel serves /assets/* from its CDN; this only SSRs page routes.",
      'export const config = { runtime: "edge" }',
      "export default (req: Request): Response | Promise<Response> => app.fetch(req)",
    )
    return `${lines.join("\n")}\n`
  }

  // bun / node / deno self-host AND serve the client bundle from disk (it sits next to this entry).
  lines.push(
    "// The client bundle lives next to this entry; serve /assets/* from disk, SSR everything else.",
    'const ASSETS = new URL("./assets/", import.meta.url)',
    'const TYPES = { js: "text/javascript", css: "text/css", map: "application/json" }',
  )
  if (target === "bun") {
    lines.push(
      "const server = Bun.serve({",
      "  port: Number(Bun.env.PORT ?? 3000),",
      "  async fetch(req) {",
      "    const { pathname } = new URL(req.url)",
      '    if (pathname.startsWith("/assets/")) {',
      '      const name = pathname.slice("/assets/".length)',
      '      if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad request", { status: 400 })',
      "      const file = Bun.file(new URL(name, ASSETS))",
      '      if (!(await file.exists())) return new Response("not found", { status: 404 })',
      '      const ext = name.slice(name.lastIndexOf(".") + 1)',
      '      return new Response(file, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } })',
      "    }",
      "    return app.fetch(req)",
      "  },",
      "})",
      // The `${...}` here is literal OUTPUT (a template in the GENERATED file), not a template in this
      // source — split so biome's noTemplateCurlyInString doesn't flag it; the emitted line is unchanged.
      `console.log(\`nifra (Bun) → http://localhost:$${"{server.port}"}\`)`,
    )
    return `${lines.join("\n")}\n`
  }
  if (target === "node") {
    lines.push(
      'import { readFile } from "node:fs/promises"',
      "await serve(",
      "  {",
      "    async fetch(req) {",
      "      const { pathname } = new URL(req.url)",
      '      if (pathname.startsWith("/assets/")) {',
      '        const name = pathname.slice("/assets/".length)',
      '        if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad request", { status: 400 })',
      "        try {",
      "          const body = await readFile(new URL(name, ASSETS))",
      '          const ext = name.slice(name.lastIndexOf(".") + 1)',
      '          return new Response(body, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } })',
      "        } catch {",
      '          return new Response("not found", { status: 404 })',
      "        }",
      "      }",
      "      return app.fetch(req)",
      "    },",
      "  },",
      "  { port: Number(process.env.PORT ?? 3000) },",
      ")",
    )
    return `${lines.join("\n")}\n`
  }
  // deno
  lines.push(
    "const handler = toFetchHandler(app)",
    "// @ts-ignore — Deno global is present on the Deno runtime this output targets.",
    'Deno.serve({ port: Number(Deno.env.get("PORT") ?? "3000") }, async (req) => {',
    "  const { pathname } = new URL(req.url)",
    '  if (pathname.startsWith("/assets/")) {',
    '    const name = pathname.slice("/assets/".length)',
    '    if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad request", { status: 400 })',
    "    try {",
    "      // @ts-ignore — Deno.readFile is present on the Deno runtime.",
    "      const body = await Deno.readFile(new URL(name, ASSETS))",
    '      const ext = name.slice(name.lastIndexOf(".") + 1)',
    '      return new Response(body, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } })',
    "    } catch {",
    '      return new Response("not found", { status: 404 })',
    "    }",
    "  }",
    "  return handler.fetch(req)",
    "})",
  )
  return `${lines.join("\n")}\n`
}

/** The Bun.build `target` each deploy target compiles its server with (mirrors `buildServer`'s docs). */
const SERVER_BUILD_TARGET: Record<Exclude<BuildTarget, "static">, "browser" | "node" | "bun"> = {
  "cf-pages": "browser", // edge conditions (workerd/edge-light)
  vercel: "browser", // Vercel Edge runtime
  deno: "browser", // Deno's Web-standard runtime runs the edge bundle
  node: "node", // node:* external; react-dom → its Node SSR build
  bun: "bun", // Bun's flagship runtime
}

/** Measure each emitted output file's raw + gzip size. Reads the file off disk and gzips it with
 * `Bun.gzipSync` (the over-the-wire weight). Async only because it reads files; the aggregation is the
 * pure {@link aggregateSizeReport}. */
async function measureOutputs(paths: readonly string[]): Promise<ChunkSize[]> {
  const chunks: ChunkSize[] = []
  for (const path of paths) {
    const bytes = await Bun.file(path).bytes()
    chunks.push({
      name: basename(path),
      bytes: bytes.byteLength,
      gzip: Bun.gzipSync(bytes).byteLength,
    })
  }
  return chunks
}

export interface BuildTargetOptions {
  /** The `routes/` directory to discover (absolute path). */
  readonly routesDir: string
  /** Output directory for the assembled deploy dir (absolute path). Cleared and recreated. */
  readonly outDir: string
  /** A scratch directory for intermediate codegen (the generated server entry + manifest) and the
   * server bundle, cleaned up after. Absolute path. */
  readonly workDir: string
  /** The adapter's client runtime module (exports `mountRouter`), e.g. `"@nifrajs/web-react/client"`. */
  readonly clientModule: string
  /** Import specifier (resolvable from `workDir`) of the module exporting `adapter`. */
  readonly adapterImport: string
  /** Import specifier (resolvable from `workDir`) of the module exporting `backend`, or `undefined`. */
  readonly backendImport?: string
  /** Factory that builds the app for `static` prerendering, GIVEN the client build's manifest — so the
   * emitted hydration `<script src>` uses the REAL content-hashed entry (`client.entry`) plus the same
   * styles/route-preload the server targets use. A pre-built instance can't work here: the hash isn't known
   * until `buildClient` runs inside `buildTarget`, so a hardcoded entry 404s → pages render but never
   * hydrate. Required for `target: "static"` (SSG drives `app.fetch`); ignored otherwise. */
  readonly prerenderApp?: (client: BuildManifest) => PrerenderAppLike | Promise<PrerenderAppLike>
  /** Client-build plugins (e.g. the MDX/Vue/Solid Bun plugins). */
  readonly clientPlugins?: readonly BunPlugin[]
  /** Server-build plugins (e.g. the SSR variants). */
  readonly serverPlugins?: readonly BunPlugin[]
  /** Extra Bun.build resolve conditions for the CLIENT build. */
  readonly conditions?: readonly string[]
  /** Compile-time `define` replacements layered onto both builds. */
  readonly define?: Readonly<Record<string, string>>
  /** Document `<title>` for the generated server entry. */
  readonly title?: string
}

/** Minimal app surface `buildTarget`'s static path needs — a fetch handler (a built `createWebApp`). */
export interface PrerenderAppLike {
  fetch(req: Request): Response | Promise<Response>
}

/** The result of a target build — the deploy dir + the client manifest + an optional size report. */
export interface BuildTargetResult {
  /** The deploy target that was built. */
  readonly target: BuildTarget
  /** The assembled output directory. */
  readonly outDir: string
  /** The client build's manifest (entry URL, assets, per-route chunks/styles). */
  readonly client: BuildManifest
  /** A human-readable note on how to run/deploy the output. */
  readonly run: string
  /** Per-chunk size report over the emitted client (+ server) outputs. Always computed; the CLI prints
   * it only with `--report`. */
  readonly size: SizeReport
}

/**
 * Build a full deploy directory for `target` from a file-routed nifra app. Emits the client bundle to
 * `<outDir>/assets/*`, then per target:
 *   - `static`: prerenders opted-in routes (`prerenderRoutes`) to `<outDir>/<path>/index.html` (+
 *     `_data.json`); needs `prerenderApp`. No server.
 *   - `cf-pages`: a `_worker.js` (edge bundle) + a `_routes.json` excluding /assets/* from the worker.
 *   - `vercel`: a `.vercel/output`-shaped function isn't emitted here — `vercel` emits the bundled edge
 *     entry as `<outDir>/index.js` (the CLI's docs point at `vercel`'s Build Output wrapper). [see note]
 *   - `deno`/`node`/`bun`: the self-hosting server bundle (`server.js`) next to the assets.
 * The server entry is GENERATED (`generateServerEntry`) and bundled (`buildServer`); the app supplies
 * only adapter/backend/routes. Returns the manifest + a size report. Throws on any build failure.
 *
 * Note: the heavier platform wrappers (`.vercel/output` v3 layout, wrangler ISR `find_additional_modules`)
 * remain app-owned scripts; this command targets the common single-bundle deploys. See the CLI docs.
 */
export async function buildTarget(
  target: BuildTarget,
  options: BuildTargetOptions,
): Promise<BuildTargetResult> {
  const { routesDir, outDir, workDir } = options
  const { rmSync } = await import("node:fs")
  rmSync(outDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
  const assetsDir = `${outDir}/assets`
  mkdirSync(assetsDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  // (1) Client bundle → <outDir>/assets/* (every target ships the same hashed client bundle).
  const client = await buildClient({
    routesDir,
    outDir: assetsDir,
    clientModule: options.clientModule,
    ...(options.clientPlugins ? { plugins: options.clientPlugins } : {}),
    ...(options.conditions ? { conditions: options.conditions } : {}),
    define: { "process.env.NODE_ENV": '"production"', ...(options.define ?? {}) },
  })

  if (target === "static") {
    if (options.prerenderApp === undefined) {
      throw new Error(
        "[nifra/web] buildTarget(static) requires `prerenderApp` (a factory `(client) => createWebApp`)",
      )
    }
    const manifest = discoverRoutes(routesDir)
    // Build the prerender app with the REAL content-hashed client entry (+ styles/preload) from the client
    // build above, so the hydration `<script src>` the prerendered HTML emits matches the emitted bundle.
    // A stale/placeholder entry here 404s → the pages render but never hydrate (inert controls).
    const app = await options.prerenderApp(client)
    const result = await prerenderRoutes({
      app,
      routes: manifest.routes,
      outDir,
    })
    if (result.prerendered.length === 0) {
      // A static build that renders nothing is almost always a misconfig (no `prerender = true` / no
      // getStaticPaths) — fail loudly rather than ship an empty dir the dev thinks is their site.
      throw new Error(
        "[nifra/web] buildTarget(static): no routes were prerendered — opt routes in with " +
          "`export const prerender = true` (static) or `getStaticPaths` (dynamic).",
      )
    }
    rmSync(workDir, { recursive: true, force: true })
    const size = aggregateSizeReport(
      await measureOutputs(client.assets.map((u) => assetUrlToPath(u, assetsDir))),
    )
    return {
      target,
      outDir,
      client,
      run: `static site → ${outDir} (serve the directory with any static host)`,
      size,
    }
  }

  // (2) Generate + bundle the server entry. It's written into workDir; the generated server-manifest
  // lands next to it (buildServer writes it there). The adapter/backend specifiers are resolved from
  // workDir, so the caller passes paths relative to it (or absolute).
  const serverEntryPath = `${workDir}/server-entry.ts`
  writeFileSync(
    serverEntryPath,
    generateServerEntry({
      target,
      adapterImport: options.adapterImport,
      ...(options.backendImport !== undefined ? { backendImport: options.backendImport } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
    }),
  )
  const serverTarget = SERVER_BUILD_TARGET[target]
  const { worker } = await buildServer({
    routesDir,
    serverEntry: serverEntryPath,
    outDir: `${workDir}/server`,
    clientEntry: client.entry,
    target: serverTarget,
    ...(options.serverPlugins ? { plugins: options.serverPlugins } : {}),
    define: { "process.env.NODE_ENV": '"production"', ...(options.define ?? {}) },
  })

  // (3) Assemble the deploy dir for the target.
  const { cpSync } = await import("node:fs")
  let run: string
  if (target === "cf-pages") {
    cpSync(worker, `${outDir}/_worker.js`)
    writeFileSync(
      `${outDir}/_routes.json`,
      `${JSON.stringify({ version: 1, include: ["/*"], exclude: ["/assets/*"] }, null, 2)}\n`,
    )
    run = `Cloudflare Pages → ${outDir} (deploy: wrangler pages deploy ${basename(outDir)})`
  } else if (target === "vercel") {
    cpSync(worker, `${outDir}/index.js`)
    run = `Vercel edge function → ${outDir}/index.js (wrap with your vercel.json or Build Output API)`
  } else {
    // bun / node / deno: the runnable server bundle next to its /assets.
    cpSync(worker, `${outDir}/server.js`)
    const cmd =
      target === "node"
        ? `node ${basename(outDir)}/server.js`
        : `${target} ${basename(outDir)}/server.js`
    run = `${target} server → ${outDir} (run: ${cmd})`
  }
  rmSync(workDir, { recursive: true, force: true })

  // Size report over the client assets + the server bundle (its parse cost matters on the edge).
  const clientPaths = client.assets.map((u) => assetUrlToPath(u, assetsDir))
  const serverPath = `${outDir}/${target === "cf-pages" ? "_worker.js" : target === "vercel" ? "index.js" : "server.js"}`
  const size = aggregateSizeReport(await measureOutputs([...clientPaths, serverPath]))
  return { target, outDir, client, run, size }
}

/** Map a client asset URL (`/assets/x-hash.js`) back to its on-disk path under `assetsDir`. The
 * `publicPath` prefix is always `/assets/` for these builds, so strip it and rejoin. */
const assetUrlToPath = (url: string, assetsDir: string): string =>
  `${assetsDir}/${url.slice(url.lastIndexOf("/") + 1)}`
