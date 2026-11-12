import { basename as pathBasename } from "node:path"
import type { ClientModuleGraph } from "../module-graph.ts"
import { codeUnitOrder } from "./code-unit-order.ts"
import { isBareNodeBuiltin } from "./node-builtins.ts"

interface GraphImport {
  readonly path?: string
  readonly original?: string
  readonly external?: boolean
}

interface GraphInput {
  readonly imports?: readonly GraphImport[]
}

const basename = (path: string): string => pathBasename(path)

const nodeBuiltinOf = (im: GraphImport): string | undefined => {
  if (im.original?.startsWith("node:")) return im.original
  if (im.path?.startsWith("node:")) return im.path
  // A bare built-in only counts when the bundler left it external: a bundled `fs` resolved to an
  // installed package (or a polyfill keyed `node:fs`) is handled above or is not a built-in at all.
  // Labeled with the prefix, so `fs/promises` reads the same from either bundler.
  const spec = im.external === true ? (im.original ?? im.path) : undefined
  return spec !== undefined && isBareNodeBuiltin(spec) ? `node:${spec}` : undefined
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
  return (
    shortestImportChain(
      inputs,
      entryInputs,
      // Match on the same `node:` detection the finding used (`original` first, then resolved `path`).
      (im) => (nodeBuiltinOf(im) === builtin ? builtin : undefined),
      // Only user modules in the input graph, so the polyfill subtree can't lengthen the path.
      (im) => (im.path !== undefined && inputs[im.path] !== undefined ? im.path : undefined),
    ) ?? [builtin]
  )
}

/**
 * The shortest import chain from any of `entryInputs` to the first edge `end` labels, as `[entry,
 * …as-written specifiers…, end label]`; `undefined` when no entry reaches one. `target` names the input
 * an edge continues into, `undefined` for one the walk never crosses; a `node:` target is never crossed,
 * and no input twice. A hop shows its as-written specifier (`../db/client.ts`, `postgres`), the resolved
 * path only without one: that is what the dev recognizes in their source.
 */
function shortestImportChain(
  inputs: Readonly<Record<string, GraphInput>>,
  entryInputs: readonly string[],
  end: (im: GraphImport, target: string | undefined) => string | undefined,
  target: (im: GraphImport) => string | undefined,
): string[] | undefined {
  const seen = new Set(entryInputs)
  let frontier = entryInputs.map((node) => ({ node, chain: [node] }))
  while (frontier.length > 0) {
    const next: Array<{ node: string; chain: string[] }> = []
    for (const { node, chain } of frontier) {
      for (const im of inputs[node]?.imports ?? []) {
        const to = target(im)
        const label = end(im, to?.startsWith("node:") ? undefined : to)
        if (label !== undefined) return [...chain, label]
        if (to === undefined || to.startsWith("node:") || seen.has(to)) continue
        seen.add(to)
        next.push({ node: to, chain: [...chain, im.original ?? to] })
      }
    }
    frontier = next
  }
  return undefined
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
  // (1b) Builtins the bundler left EXTERNAL: the import ships in the importer's chunk but the module
  // is in no output, so (2) can't find it as a chunk member. Bun does this for a dynamic
  // `import("node:fs")` in a browser build; the browser then fails to load it.
  const externalsOf = new Map<string, string[]>()
  for (const [inputKey, input] of Object.entries(inputs)) {
    if (inputKey.startsWith("node:")) continue
    for (const im of input.imports ?? []) {
      if (im.external !== true) continue
      const builtin = nodeBuiltinOf(im)
      if (builtin === undefined) continue
      const list = externalsOf.get(inputKey) ?? []
      if (!list.includes(builtin)) list.push(builtin)
      externalsOf.set(inputKey, list)
    }
  }
  // (2) Locate which emitted chunk each user-imported builtin reached, via the per-output `inputs`.
  const findings = new Map<string, NodeBuiltinFinding>()
  const report = (builtin: string, outputPath: string): void => {
    const chunk = basename(outputPath)
    findings.set(`${builtin}\0${chunk}`, { builtin, chunk, chain: chainFor(builtin) })
  }
  for (const [outputPath, output] of Object.entries(graph.chunks)) {
    for (const inputKey of output.modules) {
      if (userImported.has(inputKey)) report(inputKey, outputPath)
      for (const builtin of externalsOf.get(inputKey) ?? []) report(builtin, outputPath)
    }
  }
  return [...findings.values()].sort((a, b) =>
    a.builtin === b.builtin ? codeUnitOrder(a.chunk, b.chunk) : codeUnitOrder(a.builtin, b.builtin),
  )
}

// ---------------------------------------------------------------------------------------------------
// `backend-only` poison-import guard (§3.3/§5.1). The complement to the zones + the
// node-builtin guard: a module of PURE server logic with NO `node:` import (a secret-bearing constant,
// a server-only API call) that an author wants to FAIL LOUD if it reaches the client opts in with a
// side-effect `import "@nifrajs/web/backend-only"` (Next's `import "server-only"`). On the SERVER build
// the marker is an empty no-op; the CLIENT build detects - via the SAME Bun metafile graph the
// node-builtin guard walks - any module that imports the marker AND lands in a client chunk, and fails
// the build with the import chain. Graph-based (never the emitted text), so it survives minification.
// ---------------------------------------------------------------------------------------------------

/** The marker specifier an author imports to opt a module into the client-leak guard. Matched on the
 * import edge's *as-written* `original` first (the robust signal: it's exactly what the author typed,
 * before Bun resolves it to `src/backend-only.ts` / `dist/backend-only.js`). */
export const SERVER_ONLY_MARKER = "@nifrajs/web/backend-only"

const isServerOnlyMarkerImport = (im: GraphImport): boolean => {
  if (im.original === SERVER_ONLY_MARKER) return true
  return im.path !== undefined && /(^|\/)backend-only\.[cm]?[jt]s$/.test(im.path)
}

/** True when an INPUT graph key is the marker module file itself (`…/backend-only.{ts,js}` under web).
 * Excluded from the "marked" set - the marker is the import target, not an opt-in module. */
const isServerOnlyMarkerModule = (inputKey: string): boolean =>
  /(^|\/)backend-only\.[cm]?[jt]s$/.test(inputKey)

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
  const tail = (label: string): string => `${label} (marked backend-only)`
  // An entry that is ITSELF the marked module - the chain is just that one node.
  if (entryInputs.includes(markedModule)) return [tail(markedModule)]
  return (
    shortestImportChain(
      inputs,
      entryInputs,
      // The marked module reached via THIS edge ends the chain, labelled by the as-written specifier.
      (im, target) => (target === markedModule ? tail(im.original ?? target) : undefined),
      // Resolve the edge's `path` to the matching INPUT-GRAPH KEY - in a real build the edge `path`
      // is absolute while the input keys are cwd-relative, so a raw equality/lookup would miss every
      // multi-hop user edge (and the chain would degrade to just the tail). The resolver maps both.
      resolveTarget,
    ) ?? [tail(markedModule)]
  )
}

/**
 * Scan a build's metafile for any module that opts into the `server-only` marker (a side-effect
 * `import "@nifrajs/web/backend-only"`) yet landed in a CLIENT output chunk, returning a sorted, deduped
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
  const placed = new Set<string>()
  for (const [outputPath, output] of Object.entries(graph.chunks)) {
    for (const inputKey of output.modules) {
      if (!marked.has(inputKey)) continue
      const chunk = basename(outputPath)
      placed.add(inputKey)
      findings.set(`${inputKey}\0${chunk}`, { chunk, chain: chainFor(inputKey) })
    }
  }
  // A marked module the build loaded but no chunk lists: the bundler inlined what it exports (a
  // constant ships without its module) or dropped it. The import crossed the boundary either way.
  for (const inputKey of marked) {
    if (placed.has(inputKey)) continue
    findings.set(`${inputKey}\0`, {
      chunk: "none, inlined or shaken out",
      chain: chainFor(inputKey),
    })
  }
  return [...findings.values()].sort((a, b) => {
    const am = a.chain[a.chain.length - 1] ?? ""
    const bm = b.chain[b.chain.length - 1] ?? ""
    return am === bm ? codeUnitOrder(a.chunk, b.chunk) : codeUnitOrder(am, bm)
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
    `[nifra/web] Node built-in(s) in the client bundle - built-ins run on the server only: import ` +
    `them in a route's backend half (x.backend.ts) or under backend/, never in browser code:\n${lines.join("\n")}`
  )
}

/** The build-failing message for `server-only`-marked modules that reached the client. `undefined` ⇒ clean. */
export function formatServerOnlyLeak(
  findings: ReadonlyArray<ServerOnlyFinding>,
): string | undefined {
  if (findings.length === 0) return undefined
  const lines = findings.map((finding) =>
    finding.chain.length > 1
      ? `  - backend-only module reached the client bundle via ${finding.chain.join(" → ")} (chunk: ${finding.chunk})`
      : `  - backend-only module reached the client bundle via ${finding.chunk}`,
  )
  return (
    `[nifra/web] backend-only module(s) in the client bundle - a module marked ` +
    `\`import "${SERVER_ONLY_MARKER}"\` reached the browser. Move it under backend/ and reach it ` +
    `from a route's backend half (x.backend.ts) or a *.fn.ts server function:\n${lines.join("\n")}`
  )
}
