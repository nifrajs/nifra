import type { ClientModuleGraph } from "./module-graph.ts"

export interface BuildManifest {
  readonly entry: string
  readonly assets: readonly string[]
  readonly routes: Readonly<Record<string, readonly string[]>>
  readonly publicFiles?: readonly string[]
  readonly css?: readonly string[]
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
}

/** The built worker bundle - point your `wrangler.toml`'s `main` at `worker`. */
export interface ServerBuild {
  readonly worker: string
  readonly outputs: readonly string[]
}

/** A deploy target `nifra build --target <t>` can emit. `static` is pure SSG (no server). */
export const BUILD_TARGETS = ["bun", "node", "deno", "cf-pages", "vercel", "static"] as const
export type BuildTarget = (typeof BUILD_TARGETS)[number]

/** A type guard narrowing an arbitrary string to a {@link BuildTarget}. */
export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value)
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
  buildClient(input: {
    readonly routesDir: string
    readonly outDir: string
    readonly clientModule: string
    readonly plugins?: readonly unknown[]
    readonly conditions?: readonly string[]
    readonly define?: Readonly<Record<string, string>>
    readonly publicDir?: string | false
    readonly publicEnvPrefix?: string
    readonly root?: string
  }): Promise<BuildManifest>
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

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

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
  readonly chain: readonly string[]
}

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
        if (nodeBuiltinOf(im) === builtin) return [...chain, builtin]
        const target = im.path
        if (
          target === undefined ||
          target.startsWith("node:") ||
          inputs[target] === undefined ||
          seen.has(target)
        ) {
          continue
        }
        seen.add(target)
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
  const userImported = new Set<string>()
  for (const [inputKey, input] of Object.entries(inputs)) {
    if (inputKey.startsWith("node:")) continue
    for (const im of input.imports ?? []) {
      const builtin = nodeBuiltinOf(im)
      if (builtin !== undefined) userImported.add(builtin)
    }
  }
  const entryInputs = [
    ...new Set(
      Object.values(graph.chunks)
        .map((output) => output.entryPoint)
        .filter((entry): entry is string => entry !== undefined && !entry.startsWith("node:")),
    ),
  ]
  const chains = new Map<string, readonly string[]>()
  const chainFor = (builtin: string): readonly string[] => {
    const cached = chains.get(builtin)
    if (cached !== undefined) return cached
    const chain = shortestBuiltinChain(inputs, entryInputs, builtin)
    chains.set(builtin, chain)
    return chain
  }
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

/** The marker specifier an author imports to opt a module into the client-leak guard. Matched on the
 * import edge's *as-written* `original` first (the robust signal: it's exactly what the author typed,
 * before Bun resolves it to `src/server-only.ts` / `dist/server-only.js`). */
export const SERVER_ONLY_MARKER = "@nifrajs/web/server-only"

const isServerOnlyMarkerImport = (im: GraphImport): boolean => {
  if (im.original === SERVER_ONLY_MARKER) return true
  return im.path !== undefined && /(^|\/)server-only\.[cm]?[jt]s$/.test(im.path)
}

const isServerOnlyMarkerModule = (inputKey: string): boolean =>
  /(^|\/)server-only\.[cm]?[jt]s$/.test(inputKey)

/** One `server-only`-module-in-the-client finding: the offending module (the as-written marker-import
 * chain's tail before the marker), the emitted chunk it landed in, and the shortest USER-module import
 * chain that pulled it there (entry → … → the server-only module). */
export interface ServerOnlyFinding {
  readonly chunk: string
  readonly chain: readonly string[]
}

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

function shortestServerOnlyChain(
  inputs: Readonly<Record<string, GraphInput>>,
  entryInputs: readonly string[],
  markedModule: string,
  resolveTarget: (im: GraphImport) => string | undefined,
): string[] {
  const tail = (label: string): string => `${label} (marked server-only)`
  if (entryInputs.includes(markedModule)) return [tail(markedModule)]
  const seen = new Set(entryInputs)
  let frontier = entryInputs.map((node) => ({ node, chain: [node] }))
  while (frontier.length > 0) {
    const next: Array<{ node: string; chain: string[] }> = []
    for (const { node, chain } of frontier) {
      for (const im of inputs[node]?.imports ?? []) {
        const target = resolveTarget(im)
        if (target === undefined || target.startsWith("node:")) continue
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
  const resolveTarget = inputKeyResolver(inputs)
  const chains = new Map<string, readonly string[]>()
  const chainFor = (module: string): readonly string[] => {
    const cached = chains.get(module)
    if (cached !== undefined) return cached
    const chain = shortestServerOnlyChain(inputs, entryInputs, module, resolveTarget)
    chains.set(module, chain)
    return chain
  }
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

/** One emitted chunk's measured size, in raw bytes + gzipped bytes (over-the-wire weight). */
export interface ChunkSize {
  readonly name: string
  readonly bytes: number
  readonly gzip: number
}

/** A whole build's size report - every chunk (largest first) + the totals. */
export interface SizeReport {
  readonly chunks: readonly ChunkSize[]
  readonly totalBytes: number
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

/** A drift finding between a committed server-manifest and the live `routes/` tree. */
export interface ManifestDrift {
  readonly missing: readonly string[]
  readonly extra: readonly string[]
}

const MANIFEST_ROUTE_ENTRY = /^[ \t]+(["'])([^"'\n]+)\1\s*:\s*(?:m\d+\b|\(\s*\)\s*=>\s*import\b)/gm
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

function bakedManifestLiteral(source: string, name: string): string | undefined {
  const opener = `export const ${name} = `
  const start = source.indexOf(opener)
  if (start === -1) return undefined
  const from = start + opener.length
  const end = source.indexOf("\nexport const ", from)
  return end === -1 ? undefined : source.slice(from, end)
}

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
