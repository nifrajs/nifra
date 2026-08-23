import { basename as pathBasename } from "node:path"
import type { ClientModuleGraph } from "./module-graph.ts"

export interface BuildManifest {
  /** URL of the client entry module (content-hashed). */
  readonly entry: string
  /** URLs of every emitted asset (entry + chunks) - for serving + preloading. */
  readonly assets: readonly string[]
  /** `routeId → [layout chunk URLs…, own chunk URL]` - the chunks a route needs, for `createWebApp`'s
   * `routePreload` (`<link rel="modulepreload">` the matched route alongside the entry). Each route +
   * layout is also a build entrypoint, so it gets a named chunk the bootstrap's lazy import dedupes to. */
  readonly routes: Readonly<Record<string, readonly string[]>>
  /** URL paths copied from `publicDir`, sorted. Lets the server entry serve them without scanning a
   * directory per request, and lets an adapter that needs a file list (CDN upload, platform static
   * assets) consume one. Omitted when there is no `public/`. */
  readonly publicFiles?: readonly string[]
  /** The app's bundled, content-hashed stylesheet(s) - the bootstrap's **aggregate** CSS (every
   * `import './x.css'` reachable from the app). The complete stylesheet regardless of which file
   * imported the CSS; the always-safe fallback `createWebApp` links when a route has no per-route entry
   * in {@link routeStyles}. Omitted when the app imports no CSS. */
  readonly css?: readonly string[]
  /** `routeId → [chain CSS URLs]` - only the stylesheets the matched route's layout chain + own file
   * actually use (Bun emits a per-entrypoint CSS bundle per route/layout, with shared-component CSS
   * inlined into each consumer). `createWebApp` links these instead of the aggregate, so a page ships
   * only its own CSS. A route is omitted (→ aggregate fallback) when its `[name]` collides with another
   * route's basename (ambiguous CSS↔route) or the build emitted orphan shared-chunk CSS - correctness
   * over minimality. Absent entirely when the app imports no CSS. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
}

/** The built worker bundle - point your `wrangler.toml`'s `main` at `worker`. */
export interface ServerBuild {
  /** Path to the bundled, self-contained worker entry. */
  readonly worker: string
  /** Paths of every emitted output (entry + any code-split chunks) - what to ship to the platform. */
  readonly outputs: readonly string[]
}

// ===================================================================================================
// `nifra build --target` - package the engine above into one command that emits a full deploy dir.
//
// An app already declares everything the build needs through nifra's conventions: `adapter` +
// `clientModule` (nifra.config.ts / framework.ts), an optional `backend` (backend.ts), and `routes/`.
// The ONLY thing apps used to hand-write per target was the server entry (`_worker.ts`, `server-bun.ts`,
// …) - so we GENERATE it here (per target) instead of asking each app to ship five near-identical files.
// ===================================================================================================

/** A deploy target `nifra build --target <t>` can emit. `static` is pure SSG (no server). */
export const BUILD_TARGETS = ["bun", "node", "deno", "cf-pages", "vercel", "static"] as const
export type BuildTarget = (typeof BUILD_TARGETS)[number]

/** A type guard narrowing an arbitrary string to a {@link BuildTarget}. */
export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value)
}

export type ServerBuildTarget = "browser" | "node" | "bun"

export interface StaticBuildTargetPlan {
  readonly target: "static"
  readonly kind: "static"
  readonly serverTarget: undefined
  readonly outputFile: undefined
  readonly run: string
}

export interface ServerBuildTargetPlan {
  readonly target: Exclude<BuildTarget, "static">
  readonly kind: "server"
  readonly serverTarget: ServerBuildTarget
  /** The worker's final filename inside the assembled deploy directory. */
  readonly outputFile: "_worker.js" | "index.js" | "server.js"
  readonly run: string
}

export type BuildTargetPlan = StaticBuildTargetPlan | ServerBuildTargetPlan

const finalPathSegment = (path: string): string => {
  // Do not use a repeated, unanchored regex here: a separator-heavy path followed by a
  // non-separator can make the regex engine retry every possible start position (ReDoS).
  let end = path.length
  while (end > 0) {
    const code = path.charCodeAt(end - 1)
    if (code !== 0x2f && code !== 0x5c) break
    end -= 1
  }
  const trimmed = path.slice(0, end)
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Resolve the target-specific deploy shape before any bundling starts. Keeping this decision pure
 * means Bun and Vite strategies share the same output filename, server target, and hand-off text;
 * the filesystem emitter only has to execute the plan.
 */
export function planBuildTarget(target: BuildTarget, outDir: string): BuildTargetPlan {
  if (target === "static") {
    return {
      target,
      kind: "static",
      serverTarget: undefined,
      outputFile: undefined,
      run: `static site → ${outDir} (serve the directory with any static host)`,
    }
  }
  if (target === "cf-pages") {
    return {
      target,
      kind: "server",
      serverTarget: "browser",
      outputFile: "_worker.js",
      run: `Cloudflare Pages → ${outDir} (deploy: wrangler pages deploy ${finalPathSegment(outDir)})`,
    }
  }
  if (target === "vercel") {
    return {
      target,
      kind: "server",
      serverTarget: "browser",
      outputFile: "index.js",
      run: `Vercel edge function → ${outDir}/index.js (wrap with your vercel.json or Build Output API)`,
    }
  }
  return {
    target,
    kind: "server",
    serverTarget: target === "node" ? "node" : target === "bun" ? "bun" : "browser",
    outputFile: "server.js",
    run: `${target} server → ${outDir} (run: ${target === "node" ? "node" : target} ${finalPathSegment(outDir)}/server.js)`,
  }
}

/**
 * A build-tool STRATEGY for {@link buildTargetWith} - the two bundling steps, and nothing else. Everything
 * around them (server-entry codegen, deploy assembly, prerender, size report) is bundler-agnostic and
 * lives in `buildTargetWith`, so a second bundler (Vite) is this interface, not a second orchestrator.
 *
 * Plugin lists are `readonly unknown[]` because a Bun plugin and a Vite plugin are different types; each
 * strategy casts to its own. `buildTargetWith` only forwards them.
 */
export interface Bundler {
  /** Build the client bundle → the shared {@link BuildManifest}. */
  buildClient(input: {
    readonly routesDir: string
    readonly outDir: string
    readonly clientModule: string
    readonly plugins?: readonly unknown[]
    readonly conditions?: readonly string[]
    readonly define?: Readonly<Record<string, string>>
    readonly publicDir?: string | false
    readonly publicEnvPrefix?: string
    /** Project root (Vite needs it; the Bun strategy ignores it). */
    readonly root?: string
  }): Promise<BuildManifest>
  /** Build the server worker → the shared {@link ServerBuild}. */
  buildServer(input: {
    readonly routesDir: string
    readonly serverEntry: string
    readonly outDir: string
    readonly clientEntry: string
    readonly target: "browser" | "node" | "bun"
    readonly plugins?: readonly unknown[]
    readonly define?: Readonly<Record<string, string>>
    readonly root?: string
  }): Promise<ServerBuild>
}

interface GraphImport {
  readonly path?: string
  readonly original?: string
}

interface GraphInput {
  readonly imports?: readonly GraphImport[]
}

const basename = (path: string): string => pathBasename(path)

const nodeBuiltinOf = (im: GraphImport): string | undefined => {
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
 * actually wrote `import` - the actionable root, not an arbitrary internal module. Traversal crosses
 * only NON-`node:` edges (so Bun's polyfill chain never extends the path) and stops at the first edge
 * whose target is the builtin. Returns `[builtin]` if no entry reaches it (defensive; a flagged builtin
 * is reachable by construction). Pure - operates on the graph, never the emitted text.
 */
function shortestBuiltinChain(
  inputs: Readonly<Record<string, GraphInput>>,
  entryInputs: readonly string[],
  builtin: string,
): string[] {
  const seen = new Set(entryInputs)
  let frontier = entryInputs.map((node) => ({ node, chain: [node] }))
  while (frontier.length > 0) {
    const next: Array<{ node: string; chain: string[] }> = []
    for (const { node, chain } of frontier) {
      for (const im of inputs[node]?.imports ?? []) {
        // The builtin reached via THIS edge → the chain ends here (append the builtin label). Match on
        // the same `node:` detection the finding used (`original` first, then resolved `path`).
        if (nodeBuiltinOf(im) === builtin) return [...chain, builtin]
        const target = im.path
        // Only follow edges into user (non-`node:`) modules that exist in the input graph and haven't
        // been visited - so the polyfill subtree can't lengthen the path and there are no cycles.
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
        // the resolved path - that's what the dev recognizes in their source, not the resolved path.
        next.push({ node: target, chain: [...chain, im.original ?? target] })
      }
    }
    frontier = next
  }
  return [builtin]
}

/**
 * Scan a build's metafile for any `node:` builtin that a USER module pulled into a CLIENT output
 * chunk, returning a sorted, deduped list of {@link NodeBuiltinFinding}s. Three graph facts combine so
 * the report is precise AND actionable:
 *  1. **What the user wrote** - only builtins imported by a NON-`node:` input count, so Bun's own
 *     polyfill chain (`node:crypto` → `node:buffer`/`node:stream`/…) doesn't bury the real cause.
 *  2. **Where it landed** - the chunk is read from the per-output `inputs`, so the error names the
 *     emitted file to look at.
 *  3. **How it got there** - the shortest import chain from a user entry to the builtin
 *     (`shortestBuiltinChain`), so the error points straight at the offending `import` line instead of
 *     leaving the dev to grep the dependency tree (the DX gap this closes).
 * Graph-based (never the emitted text), so it survives minification and can't be fooled by a string
 * literal that merely contains `"node:crypto"`. Pure + exported for unit testing. Empty ⇒ clean.
 */
export function detectNodeBuiltinsInClient(
  graph: ClientModuleGraph,
): ReadonlyArray<NodeBuiltinFinding> {
  const inputs = graph.modules
  // (1) The builtins a user (non-polyfill) module imports directly - the ones the author controls.
  const userImported = new Set<string>()
  for (const [inputKey, input] of Object.entries(inputs)) {
    if (inputKey.startsWith("node:")) continue // a polyfill importing another builtin - not the cause
    for (const im of input.imports ?? []) {
      const builtin = nodeBuiltinOf(im)
      if (builtin !== undefined) userImported.add(builtin)
    }
  }
  // The entry inputs (route/user entrypoints) - the chain BFS starts here so the reported path begins
  // at the file the dev wrote an `import` in. Each output's `entryPoint` is one such input.
  const entryInputs = [
    ...new Set(
      Object.values(graph.chunks)
        .map((output) => output.entryPoint)
        .filter((entry): entry is string => entry !== undefined && !entry.startsWith("node:")),
    ),
  ]
  // The chain per builtin is independent of the chunk, so compute it once per builtin (memoized).
  const chains = new Map<string, readonly string[]>()
  const chainFor = (builtin: string): readonly string[] => {
    const cached = chains.get(builtin)
    if (cached !== undefined) return cached
    const chain = shortestBuiltinChain(inputs, entryInputs, builtin)
    chains.set(builtin, chain)
    return chain
  }
  // (2) Locate which emitted chunk each user-imported builtin reached, via the per-output `inputs`.
  const findings = new Map<string, NodeBuiltinFinding>()
  for (const [outputPath, output] of Object.entries(graph.chunks)) {
    for (const inputKey of output.modules) {
      if (!userImported.has(inputKey)) continue
      const chunk = basename(outputPath)
      findings.set(`${inputKey}\0${chunk}`, {
        builtin: inputKey,
        chunk,
        chain: chainFor(inputKey),
      })
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
// the marker is an empty no-op; the CLIENT build detects - via the SAME Bun metafile graph the
// node-builtin guard walks - any module that imports the marker AND lands in a client chunk, and fails
// the build with the import chain. Graph-based (never the emitted text), so it survives minification.
// ---------------------------------------------------------------------------------------------------

/** The marker specifier an author imports to opt a module into the client-leak guard. Matched on the
 * import edge's *as-written* `original` first (the robust signal: it's exactly what the author typed,
 * before Bun resolves it to `src/server-only.ts` / `dist/server-only.js`). */
export const SERVER_ONLY_MARKER = "@nifrajs/web/server-only"

const isServerOnlyMarkerImport = (im: GraphImport): boolean => {
  if (im.original === SERVER_ONLY_MARKER) return true
  return im.path !== undefined && /(^|\/)server-only\.[cm]?[jt]s$/.test(im.path)
}

/** True when an INPUT graph key is the marker module file itself (`…/server-only.{ts,js}` under web).
 * Excluded from the "marked" set - the marker is the import target, not an opt-in module. */
const isServerOnlyMarkerModule = (inputKey: string): boolean =>
  /(^|\/)server-only\.[cm]?[jt]s$/.test(inputKey)

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
 * Build a resolver from an import EDGE to its INPUT-GRAPH KEY. Bun's metafile records edge `path`s as
 * ABSOLUTE paths but keys `inputs` by CWD-RELATIVE paths, so a raw `inputs[im.path]` lookup misses
 * every user edge in a real build. The resolver: (1) an exact key match (the synthetic-metafile / unit
 * case); else (2) the input key the absolute path ends with (`…/secrets.ts` → `packages/web/.../secrets.ts`).
 * The longest-suffix match is taken so a shorter key can't shadow a more specific one. Pure.
 */
function inputKeyResolver(
  inputs: Readonly<Record<string, unknown>>,
): (im: GraphImport) => string | undefined {
  const keys = Object.keys(inputs)
  return (im) => {
    const path = im.path
    if (path === undefined) return undefined
    if (inputs[path] !== undefined) return path
    let best: string | undefined
    for (const key of keys) {
      if (path.endsWith(`/${key}`) && (best === undefined || key.length > best.length)) best = key
    }
    return best
  }
}

/**
 * BFS the metafile import graph for the SHORTEST user-module path that reaches a module which imports
 * the `server-only` marker, returning it as display labels `[entryFile, …as-written specifiers…,
 * "<module> (marked server-only)"]`. Mirrors {@link shortestBuiltinChain}: the frontier starts at
 * every `entryInput` so the chain begins at the file the dev wrote an `import` in; traversal crosses
 * only NON-`node:` user edges (no cycles via `seen`); it stops at the first node whose import set
 * contains the marker (the marked module - the actionable tail), labelling that node by the as-written
 * specifier the previous hop used to reach it. Pure - operates on the graph, never the emitted text.
 */
function shortestServerOnlyChain(
  inputs: Readonly<Record<string, GraphInput>>,
  entryInputs: readonly string[],
  markedModule: string,
  resolveTarget: (im: GraphImport) => string | undefined,
): string[] {
  // The label for the marked module's tail: its as-written specifier (filled when we cross the edge
  // that reaches it) suffixed with `(marked server-only)`; the entry case uses the entry key itself.
  const tail = (label: string): string => `${label} (marked server-only)`
  // An entry that is ITSELF the marked module - the chain is just that one node.
  if (entryInputs.includes(markedModule)) return [tail(markedModule)]
  const seen = new Set(entryInputs)
  let frontier = entryInputs.map((node) => ({ node, chain: [node] }))
  while (frontier.length > 0) {
    const next: Array<{ node: string; chain: string[] }> = []
    for (const { node, chain } of frontier) {
      for (const im of inputs[node]?.imports ?? []) {
        // Resolve the edge's `path` to the matching INPUT-GRAPH KEY - in a real build the edge `path`
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
  return [tail(markedModule)]
}

/**
 * Scan a build's metafile for any module that opts into the `server-only` marker (a side-effect
 * `import "@nifrajs/web/server-only"`) yet landed in a CLIENT output chunk, returning a sorted, deduped
 * list of {@link ServerOnlyFinding}s. Mirrors {@link detectNodeBuiltinsInClient}: it reads the SAME
 * graph facts - which inputs import the marker (the "marked" modules), which chunk each landed in (the
 * per-output `inputs`), and the shortest import chain from a user entry to it. The marker module ITSELF
 * (which imports nothing) is excluded - only the modules that *opt in* are flagged. Pure + exported for
 * unit testing. Empty ⇒ clean.
 */
export function detectServerOnlyInClient(
  graph: ClientModuleGraph,
): ReadonlyArray<ServerOnlyFinding> {
  const inputs = graph.modules
  // (1) The modules that import the marker - the ones the author opted into the guard. The marker
  // module itself is skipped: it's the import TARGET, not an opt-in (it imports nothing of its own).
  const marked = new Set<string>()
  for (const [inputKey, input] of Object.entries(inputs)) {
    if (isServerOnlyMarkerModule(inputKey)) continue
    if ((input.imports ?? []).some(isServerOnlyMarkerImport)) marked.add(inputKey)
  }
  if (marked.size === 0) return []
  const entryInputs = [
    ...new Set(
      Object.values(graph.chunks)
        .map((output) => output.entryPoint)
        .filter((entry): entry is string => entry !== undefined && !entry.startsWith("node:")),
    ),
  ]
  // The entry inputs - the chain BFS starts here, so the reported path begins at the file the dev
  // wrote an `import` in. Same derivation as the node-builtin guard.
  const resolveTarget = inputKeyResolver(inputs)
  const chains = new Map<string, readonly string[]>()
  const chainFor = (module: string): readonly string[] => {
    const cached = chains.get(module)
    if (cached !== undefined) return cached
    const chain = shortestServerOnlyChain(inputs, entryInputs, module, resolveTarget)
    chains.set(module, chain)
    return chain
  }
  // (2) Locate which emitted chunk each marked module reached, via the per-output `inputs`.
  const findings = new Map<string, ServerOnlyFinding>()
  for (const [outputPath, output] of Object.entries(graph.chunks)) {
    for (const inputKey of output.modules) {
      if (!marked.has(inputKey)) continue
      const chunk = basename(outputPath)
      findings.set(`${inputKey}\0${chunk}`, { chunk, chain: chainFor(inputKey) })
    }
  }
  return [...findings.values()].sort((a, b) => {
    const am = a.chain[a.chain.length - 1] ?? ""
    const bm = b.chain[b.chain.length - 1] ?? ""
    return am === bm ? a.chunk.localeCompare(b.chunk) : am.localeCompare(bm)
  })
}

// ---------------------------------------------------------------------------------------------------
// Guard MESSAGES - one owner for both production pipelines. The Bun build and the Vite/Rollup leak-guard
// plugin both call these, so a leak reads IDENTICALLY whichever bundler produced it. A second bundler
// must not grow a second, subtly-different wording of a security error; that is exactly the "mostly
// ported" outcome the neutral graph seam exists to prevent.
// ---------------------------------------------------------------------------------------------------

/** The build-failing message for `node:` builtins that reached the client bundle. `undefined` ⇒ clean. */
export function formatNodeBuiltinLeak(
  findings: ReadonlyArray<NodeBuiltinFinding>,
): string | undefined {
  if (findings.length === 0) return undefined
  const lines = findings.map((finding) =>
    finding.chain.length > 1
      ? `  - ${finding.builtin} reached the client bundle via ${finding.chain.join(" → ")} (chunk: ${finding.chunk})`
      : `  - ${finding.builtin} reached the client bundle via ${finding.chunk}`,
  )
  return (
    `[nifra/web] Node built-in(s) in the client bundle - move them behind a server-only path ` +
    `(a loader/action runs on the server; import the \`node:\` module there, not at a route's ` +
    `top level):\n${lines.join("\n")}`
  )
}

/** The build-failing message for `server-only`-marked modules that reached the client. `undefined` ⇒ clean. */
export function formatServerOnlyLeak(
  findings: ReadonlyArray<ServerOnlyFinding>,
): string | undefined {
  if (findings.length === 0) return undefined
  const lines = findings.map((finding) =>
    finding.chain.length > 1
      ? `  - server-only module reached the client bundle via ${finding.chain.join(" → ")} (chunk: ${finding.chunk})`
      : `  - server-only module reached the client bundle via ${finding.chunk}`,
  )
  return (
    `[nifra/web] server-only module(s) in the client bundle - a module marked ` +
    `\`import "${SERVER_ONLY_MARKER}"\` reached the browser. Move it behind a server-only path ` +
    `(reach it via a loader/action, or rename it \`*.server.ts\`), so its server logic never ships ` +
    `to the client:\n${lines.join("\n")}`
  )
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

/** A whole build's size report - every chunk (largest first) + the totals. */
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
 * by raw bytes, then name for stable output) and sum the totals. Pure - the measurement (reading the
 * file + gzipping it) happens in the orchestrator; this is the deterministic, unit-testable core.
 */
export function aggregateSizeReport(chunks: readonly ChunkSize[]): SizeReport {
  const sorted = [...chunks].sort(
    (a, b) => b.gzip - a.gzip || b.bytes - a.bytes || a.name.localeCompare(b.name),
  )
  let totalBytes = 0
  let totalGzip = 0
  for (const chunk of sorted) {
    totalBytes += chunk.bytes
    totalGzip += chunk.gzip
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
 * Render a {@link SizeReport} as a terse aligned table (biggest first) with a totals row - the text
 * `nifra build --report` prints. Pure (string in, string out) so the formatting is unit-testable.
 */
export function renderSizeReport(report: SizeReport): string {
  const rows = report.chunks.map((chunk) => ({
    name: chunk.name,
    raw: formatBytes(chunk.bytes),
    gz: formatBytes(chunk.gzip),
  }))
  // Column widths from the header + every row + the totals label, so the table never clips a value.
  const nameW = Math.max(5, ...rows.map((row) => row.name.length), "Total".length)
  const rawW = Math.max(
    3,
    ...rows.map((row) => row.raw.length),
    formatBytes(report.totalBytes).length,
  )
  const gzW = Math.max(4, ...rows.map((row) => row.gz.length), formatBytes(report.totalGzip).length)
  const padEnd = (value: string, width: number): string =>
    value + " ".repeat(Math.max(0, width - value.length))
  const padStart = (value: string, width: number): string =>
    " ".repeat(Math.max(0, width - value.length)) + value
  const line = (name: string, raw: string, gzip: string): string =>
    `  ${padEnd(name, nameW)}  ${padStart(raw, rawW)}  ${padStart(gzip, gzW)}`
  return [
    line("Chunk", "Raw", "Gzip"),
    line("-".repeat(nameW), "-".repeat(rawW), "-".repeat(gzW)),
    ...rows.map((row) => line(row.name, row.raw, row.gz)),
    line("Total", formatBytes(report.totalBytes), formatBytes(report.totalGzip)),
  ].join("\n")
}

// ---------------------------------------------------------------------------------------------------
// Server-manifest drift detection (#7). `server-manifest.ts` is a committed generated file: it bakes
// the route list + the client-entry hash for a disk-less worker (`generateServerManifest`). If `routes/`
// changes but the manifest isn't regenerated, the worker serves a stale route table - a silent edge
// break. These pure helpers diff the COMMITTED manifest source against the freshly-discovered routes so
// `nifra check` (and `buildServer`) can fail with a named, actionable error before the drift ships.
// ---------------------------------------------------------------------------------------------------

/** A drift finding between a committed server-manifest and the live `routes/` tree. */
export interface ManifestDrift {
  /** Route files present in `routes/` but ABSENT from the committed manifest (the manifest is stale -
   * the new route won't be served by the worker). */
  readonly missing: readonly string[]
  /** Route files the committed manifest imports that no longer exist in `routes/` (a deleted/renamed
   * route still wired into the worker - a build/runtime break). */
  readonly extra: readonly string[]
}

// The route-relative file keys the generated manifest's route map declares. Both shapes are matched by
// their VALUE: eager `  "routes/x.tsx": m0,` and lazy `  "routes/x.tsx": () => import("./routes/x"),`.
// The KEY (not the import specifier) is the route identity `discoverRoutes` produces, extension and all;
// the import specifier is emitted extensionless (so a bare `tsc` compiles the manifest) and could not be
// mapped back to the exact `.tsx`/`.ts` key. The baked `routeStyles` JSON is a single line, so its keys
// are never at an indented line start and never match. `[ \t]+` (not `\s+`) so the `m` anchor stays on
// the same line and one route-map entry cannot span two lines of source.
const MANIFEST_ROUTE_ENTRY = /^[ \t]+(["'])([^"'\n]+)\1\s*:\s*(?:m\d+\b|\(\s*\)\s*=>\s*import\b)/gm
// The baked client-entry line: `export const clientEntry = "…"`.
const MANIFEST_CLIENT_ENTRY = /export\s+const\s+clientEntry\s*=\s*["']([^"']+)["']/

/**
 * Extract the route-relative file list a committed server-manifest declares, as the same
 * `routes/`-relative keys `discoverRoutes` produces (e.g. `docs/index.tsx`). Reads the route map's KEYS,
 * which carry the file extension and no directory prefix - exactly discovery's shape - so the result is
 * independent of the specifier prefix the manifest happened to import with. The `@nifrajs/web` import and
 * the baked `clientEntry`/`styles`/`routeStyles` lines carry no route-map entry and are ignored.
 *
 * `_routesPrefix` is accepted for call-site compatibility but no longer needed: the keys are already
 * prefix-free. Pure - operates on source text.
 */
export function parseManifestRouteFiles(source: string, _routesPrefix?: string): string[] {
  const files = new Set<string>()
  for (const match of source.matchAll(MANIFEST_ROUTE_ENTRY)) {
    if (match[2] !== undefined) files.add(match[2])
  }
  return [...files].sort()
}

/** The baked `clientEntry` URL in a committed server-manifest, or `undefined` if absent. Pure. */
export function parseManifestClientEntry(source: string): string | undefined {
  return MANIFEST_CLIENT_ENTRY.exec(source)?.[1]
}

// The baked asset lines `generateServerManifest` emits: `export const styles = […]` then
// `export const routeStyles = {…}`, each a JSON literal running to the next `export const`. Extracted
// with `indexOf` slicing rather than a lazy `[\s\S]*?` regex: the slice is multi-line by nature (a
// formatter can wrap a long `routeStyles` map, and missing it would silently DROP every baked
// stylesheet on re-sync), and a lazy scan re-walks the file per unterminated opener - quadratic.
function bakedManifestLiteral(source: string, name: string): string | undefined {
  const opener = `export const ${name} = `
  const start = source.indexOf(opener)
  if (start === -1) return undefined
  const from = start + opener.length
  const end = source.indexOf("\nexport const ", from)
  return end === -1 ? undefined : source.slice(from, end)
}

/** Parse a baked JSON literal captured from a committed manifest, tolerating a formatter's TRAILING COMMAS
 * (biome/prettier add one when wrapping a multi-line array/object; strict `JSON.parse` would reject it).
 * Only a comma immediately before a closing `]`/`}` is stripped, so commas inside string values are safe. */
function parseManifestLiteral(raw: string): unknown {
  return JSON.parse(raw.replace(/,(\s*[\]}])/g, "$1"))
}

/** The baked top-level `styles` array in a committed server-manifest (empty if absent/unparseable). Pure. */
export function parseManifestStyles(source: string): string[] {
  const raw = bakedManifestLiteral(source, "styles")
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
  const raw = bakedManifestLiteral(source, "routeStyles")
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
 * Diff the route files a committed server-manifest imports against the files freshly discovered in
 * `routes/`. Returns the `missing` (in routes/, not in manifest - stale manifest) and `extra` (in
 * manifest, gone from routes/ - dangling import) sets. Empty arrays ⇒ in sync. Pure - the caller
 * supplies both file lists (the committed source is parsed via {@link parseManifestRouteFiles}; the
 * fresh list comes from `discoverRoutes`). Lists need not be pre-sorted; the result is sorted.
 */
export function diffManifestRoutes(
  manifestFiles: readonly string[],
  discoveredFiles: readonly string[],
): ManifestDrift {
  const inManifest = new Set(manifestFiles)
  const inRoutes = new Set(discoveredFiles)
  return {
    missing: discoveredFiles.filter((file) => !inManifest.has(file)).sort(),
    extra: manifestFiles.filter((file) => !inRoutes.has(file)).sort(),
  }
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
  const lines = [
    `[nifra/web] server-manifest drift - \`${manifestPath}\` is out of sync with routes/.`,
  ]
  if (drift.missing.length > 0) {
    lines.push(
      `  Missing (in routes/, not in the manifest - these routes won't be served): ${drift.missing.join(", ")}`,
    )
  }
  if (drift.extra.length > 0) {
    lines.push(
      `  Extra (imported by the manifest, gone from routes/ - a dangling import): ${drift.extra.join(", ")}`,
    )
  }
  lines.push("  Fix: re-run the build to regenerate the server manifest, then commit it.")
  return lines.join("\n")
}
