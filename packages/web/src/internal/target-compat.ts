/**
 * Which runtime built-ins a server bundle can load on its target. Separate from the zone rules: a
 * backend module may import `node:fs`, but an edge worker cannot run it, and a Node server has no
 * `bun:` modules. Same refusal and wording as the Vite edge build's guard.
 */
import type { ClientModuleGraph, GraphImport } from "../module-graph.ts"

export type ServerBundleTarget = "browser" | "node" | "bun"

/** Built-in prefixes each target cannot load. The `browser` target is the edge (workerd, edge-light). */
const UNSUPPORTED: Readonly<Record<ServerBundleTarget, readonly string[]>> = {
  browser: ["node:", "bun:"],
  node: ["bun:"],
  bun: [],
}

/**
 * The `node:` built-ins every edge runtime nifra deploys to provides: Cloudflare Workers with
 * `nodejs_compat` (the scaffold's wrangler.toml sets it), Vercel Edge and Deno. Svelte's server renderer
 * imports `node:async_hooks` for AsyncLocalStorage.
 */
export const EDGE_NODE_BUILTINS: ReadonlySet<string> = new Set([
  "node:assert",
  "node:async_hooks",
  "node:buffer",
  "node:events",
  "node:util",
])

/** Whether a server bundle for `target` cannot load the built-in `specifier`. */
export function unsupportedBuiltin(specifier: string, target: ServerBundleTarget): boolean {
  if (target === "browser" && EDGE_NODE_BUILTINS.has(specifier)) return false
  return UNSUPPORTED[target].some((prefix) => specifier.startsWith(prefix))
}

/**
 * The built-ins a server bundle still loads that its target cannot, each with the modules that import
 * them. A tree-shaken library module that imports `node:fs` is not one: only what the output keeps can
 * fail. Two kinds are kept: an import the emitted code still makes (a dynamic `import()` that survived),
 * and a static import of a built-in the bundler left external in a module that ships, which Bun's
 * browser target replaces with an empty object that throws on first use. A chunk without `imports`
 * evidence falls back to every module import, so missing evidence refuses.
 */
export function unsupportedBuiltins(
  graph: ClientModuleGraph,
  target: ServerBundleTarget,
  labelOf: (id: string) => string,
): ReadonlyMap<string, readonly string[]> {
  if (UNSUPPORTED[target].length === 0) return new Map()
  const unsupported = (spec: string) => unsupportedBuiltin(spec, target)
  const specOf = (im: GraphImport) => im.original ?? im.path ?? ""
  const chunks = Object.values(graph.chunks)
  const evidence = chunks.every((chunk) => chunk.imports !== undefined)
  const shipped = evidence
    ? new Set(chunks.flatMap((chunk) => chunk.modules))
    : new Set(Object.keys(graph.modules))
  const found = new Map<string, Set<string>>()
  const keep = (builtin: string) => {
    if (unsupported(builtin) && !found.has(builtin)) found.set(builtin, new Set())
  }
  for (const chunk of chunks) for (const spec of chunk.imports ?? []) keep(spec)
  for (const id of shipped) {
    for (const im of graph.modules[id]?.imports ?? []) {
      if (!evidence || (im.external === true && im.dynamic !== true)) keep(specOf(im))
    }
  }
  for (const id of shipped) {
    for (const im of graph.modules[id]?.imports ?? []) found.get(specOf(im))?.add(labelOf(id))
  }
  return new Map([...found].map(([builtin, importers]) => [builtin, [...importers].sort()]))
}

/** The build-failing message for {@link unsupportedBuiltins}, or `undefined` when there are none. */
export function formatUnsupportedBuiltins(
  found: ReadonlyMap<string, readonly string[]>,
  target: ServerBundleTarget,
): string | undefined {
  if (found.size === 0) return undefined
  const builtins = [...found.keys()].sort()
  const importers = [...new Set([...found.values()].flat())].sort().join(", ") || "unknown module"
  if (target === "browser") {
    return (
      `[nifra/web] Node built-in(s) reached an edge server bundle: ${builtins.join(", ")}. ` +
      `Imported by: ${importers}. ` +
      "Move the import behind a Node/Bun target or replace it with an edge-compatible API."
    )
  }
  return (
    `[nifra/web] Bun built-in(s) reached a Node server bundle: ${builtins.join(", ")}. ` +
    `Imported by: ${importers}. Build for the Bun target or replace it with a Node API.`
  )
}
