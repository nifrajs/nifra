/**
 * Proof that a client build holds browser code only.
 *
 * Runs on the finished module graph of either bundler, after the build and before anything is
 * written. It fails closed: a module it cannot place, an import edge it cannot follow, an emitted file
 * it cannot trace back to the graph or an import the bundle left external is an error, not a pass.
 */
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, posix, relative, resolve } from "node:path"
import { BACKEND_ROUTE_EXPORTS, backendFileFor } from "../manifest.ts"
import type { ClientModuleGraph, GraphImport } from "../module-graph.ts"
import {
  BACKEND_ONLY_MARKER,
  browserDenial,
  type Classification,
  importAllowed,
  importRuleMessage,
  type ZoneClassifier,
} from "../zones.ts"
import { isBareNodeBuiltin } from "./node-builtins.ts"

/** What a graph module id names. */
export type ModuleSource =
  | { readonly kind: "file"; readonly file: string }
  /** `node:`/`bun:` builtins; the node-builtin guard reports these with its own message. */
  | { readonly kind: "builtin" }
  /** A plugin's virtual module, with the file it derives from when it names one. */
  | { readonly kind: "virtual"; readonly file?: string }

/** A namespace prefix needs two characters, so a Windows drive letter still reads as a path. */
const NAMESPACED = /^([a-z][\w.+-]+):(.*)$/i
const stripQuery = (id: string): string => id.replace(/[?#].*$/, "")
const virtualOf = (rest: string): ModuleSource => {
  const file = stripQuery(rest)
  return isAbsolute(file) && existsSync(file) ? { kind: "virtual", file } : { kind: "virtual" }
}

/** Bun metafile ids: cwd-relative paths, `node:` builtins, `namespace:path` for plugin modules. */
export function bunModuleSource(cwd: string): (id: string) => ModuleSource {
  return (id) => {
    if (id.startsWith("node:") || id.startsWith("bun:")) return { kind: "builtin" }
    const namespaced = NAMESPACED.exec(id)
    if (namespaced !== null && namespaced[1] !== "file") return virtualOf(namespaced[2] ?? "")
    return { kind: "file", file: resolve(cwd, stripQuery(namespaced?.[2] ?? id)) }
  }
}

/** Rollup/Vite ids: absolute paths, `\0`-prefixed virtual modules, Vite's browser-external shim. */
export function rollupModuleSource(id: string): ModuleSource {
  if (id.startsWith("node:") || id.includes("__vite-browser-external")) return { kind: "builtin" }
  if (id.startsWith("\0")) return virtualOf(id.slice(1).replace(/^[\w-]+:/, ""))
  const file = stripQuery(id)
  return isAbsolute(file) ? { kind: "file", file } : { kind: "virtual" }
}

export interface ZoneLeak {
  /** The refused module, as the report names it. */
  readonly module: string
  readonly reason: string
  /** Shortest import path from an entry: `[entry, ...as-written specifiers]`. */
  readonly chain: readonly string[]
}

export interface ClientGraphVerdict {
  readonly leaks: readonly ZoneLeak[]
  /** Evidence the graph does not account for. Any entry fails the build. */
  readonly gaps: readonly string[]
  /** Route frontend files whose compiled entry exports a backend-only name. */
  readonly misplacedExports: readonly string[]
}

export interface VerifyClientGraphOptions {
  readonly classifier: ZoneClassifier
  readonly sourceOf: (id: string) => ModuleSource
  /** The private-env denial for a browser-code file (see `privateEnvCheck`); unchecked when absent. */
  readonly privateEnv?: (file: string) => string | undefined
  /** Files the zone guard refused while the bundler loaded them. Bun keeps the edge to a module
   * tree-shaking removed but drops the module, so such an edge still names a refusal. */
  readonly refused?: ReadonlySet<string>
}

const realOrSelf = (file: string): string => {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** Zones whose code runs in a browser, so may read only public environment variables. */
const BROWSER_CODE = new Set<string>(["route-frontend", "frontend", "shared"])

const isUrl = (spec: string): boolean => /^(?:https?:|data:)/i.test(spec)
const isBuiltinSpec = (spec: string): boolean =>
  spec.startsWith("node:") || spec.startsWith("bun:") || isBareNodeBuiltin(spec)

/** Check every module and edge of a client graph against the zone rules. */
export function verifyClientGraph(
  graph: ClientModuleGraph,
  options: VerifyClientGraphOptions,
): ClientGraphVerdict {
  const { classifier, sourceOf } = options
  const display = (file: string): string => {
    const rel = relative(classifier.appRoot, file).replaceAll("\\", "/")
    return rel.startsWith("..") || isAbsolute(rel) ? file : rel
  }
  const labelOf = (id: string): string => {
    const source = sourceOf(id)
    return source.kind !== "builtin" && source.file !== undefined ? display(source.file) : id
  }

  const idByFile = new Map<string, string>()
  for (const id of Object.keys(graph.modules)) {
    const source = sourceOf(id)
    if (source.kind === "file") idByFile.set(source.file, id)
  }
  const refused = new Set([...(options.refused ?? [])].map(realOrSelf))
  const dropped = new Set<string>()
  const resolveEdge = (im: GraphImport): string | undefined => {
    const path = im.path
    if (path === undefined) return undefined
    if (graph.modules[path] !== undefined) return path
    const source = sourceOf(path)
    if (source.kind !== "file") return undefined
    const known = idByFile.get(source.file)
    if (known !== undefined) return known
    if (!refused.has(realOrSelf(source.file))) return undefined
    dropped.add(path)
    return path
  }
  // A lazy `import()` of a split module is an edge to the OUTPUT chunk; its entry module continues the walk.
  const entryByChunk = new Map<string, string>()
  for (const [path, chunk] of Object.entries(graph.chunks)) {
    if (chunk.entryPoint !== undefined) entryByChunk.set(basename(path), chunk.entryPoint)
  }
  const chunkNames = new Set(Object.keys(graph.chunks).map((path) => basename(path)))
  const outputKey = (path: string): string => posix.normalize(path.replaceAll("\\", "/"))
  const outputKeys = new Set(Object.keys(graph.chunks).map(outputKey))
  // When every output reports what its code imports, that is the evidence; a module-level external
  // edge may be one the bundler dropped (an unused re-export of a `sideEffects: false` package).
  const chunkList = Object.values(graph.chunks)
  const outputImportsKnown =
    chunkList.length > 0 && chunkList.every((chunk) => chunk.imports !== undefined)

  const gaps: string[] = []
  for (const [path, chunk] of Object.entries(graph.chunks)) {
    for (const spec of chunk.imports ?? []) {
      if (outputKeys.has(outputKey(spec)) || isBuiltinSpec(spec) || isUrl(spec)) continue
      gaps.push(
        `${basename(path)} imports "${spec}", which is not one of the build's own outputs: browser output may import only its own chunks`,
      )
    }
  }
  const edges = new Map<string, Array<{ readonly to: string; readonly label: string }>>()
  const specifiers = new Map<string, Set<string>>()
  for (const [id, module] of Object.entries(graph.modules)) {
    const out: Array<{ readonly to: string; readonly label: string }> = []
    for (const im of module.imports) {
      const spec = im.original ?? im.path ?? ""
      if (im.external === true) {
        const chunk = im.path === undefined ? undefined : basename(im.path)
        if (chunk !== undefined && chunkNames.has(chunk)) {
          const entry = entryByChunk.get(chunk)
          if (entry !== undefined) out.push({ to: entry, label: spec })
          continue
        }
        if (outputImportsKnown || isBuiltinSpec(spec) || isUrl(spec)) continue
        gaps.push(
          `${labelOf(id)} imports "${spec}", which the bundle left external: browser output may import only its own chunks`,
        )
        continue
      }
      // An edge with no module behind it was never loaded (a `sideEffects: false` package's unused
      // re-export), so it is not missing evidence - unless the zone guard refused the file it names.
      const target = resolveEdge(im)
      if (target === undefined) continue
      out.push({ to: target, label: im.original ?? labelOf(target) })
      if (im.original !== undefined) {
        const set = specifiers.get(target) ?? new Set<string>()
        set.add(im.original)
        specifiers.set(target, set)
      }
    }
    edges.set(id, out)
  }
  for (const [path, chunk] of Object.entries(graph.chunks)) {
    for (const id of chunk.modules) {
      if (graph.modules[id] === undefined && sourceOf(id).kind !== "builtin") {
        gaps.push(
          `${basename(path)} contains ${id}, which the build's module graph does not describe`,
        )
      }
    }
  }

  const denied = new Map<string, string>()
  for (const id of [...Object.keys(graph.modules), ...dropped]) {
    const source = sourceOf(id)
    const file = source.kind === "builtin" ? undefined : source.file
    if (file === undefined) continue
    const classification = classifier.classify(file)
    let reason = browserDenial(classification)
    for (const spec of specifiers.get(id) ?? []) reason ??= browserDenial(classification, spec)
    if (reason === undefined && BROWSER_CODE.has(classification.zone))
      reason = options.privateEnv?.(file)
    if (reason !== undefined) denied.set(id, reason)
  }

  // Chains start at a route file where they can: a lazily split module is an entry of its own chunk,
  // but the import that pulled it in sits in a route.
  const entries = [
    ...new Set(
      Object.values(graph.chunks)
        .map((chunk) => chunk.entryPoint)
        .filter((entry): entry is string => entry !== undefined),
    ),
  ]
  const zoneOfEntry = (id: string) => {
    const source = sourceOf(id)
    return source.kind === "file" ? classifier.classify(source.file).zone : undefined
  }
  const routeEntries = entries.filter((id) => zoneOfEntry(id) === "route-frontend")
  const generatedEntries = entries.filter((id) => zoneOfEntry(id) === "generated")
  const roots =
    routeEntries.length + generatedEntries.length > 0
      ? [...routeEntries, ...generatedEntries]
      : entries
  const chains = denied.size === 0 ? new Map<string, string[]>() : shortestChains(roots, edges)
  const leaks = [...denied]
    .map(([id, reason]) => ({
      module: labelOf(id),
      reason,
      chain: (chains.get(id) ?? [id]).map((label, i) => (i === 0 ? labelOf(label) : label)),
    }))
    .sort((a, b) => a.module.localeCompare(b.module))

  const misplacedExports: string[] = []
  for (const [path, chunk] of Object.entries(graph.chunks)) {
    if (chunk.entryPoint === undefined || chunk.exports === undefined) continue
    if (!/\.[cm]?js$/.test(path)) continue
    const source = sourceOf(chunk.entryPoint)
    if (source.kind !== "file" || classifier.classify(source.file).zone !== "route-frontend")
      continue
    const file = display(source.file)
    for (const name of chunk.exports) {
      if (BACKEND_ROUTE_EXPORTS.has(name)) {
        misplacedExports.push(
          `"${file}" exports "${name}", which runs on the server only. Move it to "${backendFileFor(file)}"`,
        )
      }
    }
  }

  return { leaks, gaps: [...new Set(gaps)].sort(), misplacedExports: misplacedExports.sort() }
}

/** BFS from every entry at once: each reached module's shortest chain, entry first. */
function shortestChains(
  entries: readonly string[],
  edges: ReadonlyMap<string, ReadonlyArray<{ readonly to: string; readonly label: string }>>,
): Map<string, string[]> {
  const chains = new Map<string, string[]>()
  let frontier: string[] = []
  for (const entry of entries) {
    if (chains.has(entry)) continue
    chains.set(entry, [entry])
    frontier.push(entry)
  }
  while (frontier.length > 0) {
    const next: string[] = []
    for (const node of frontier) {
      const chain = chains.get(node) ?? [node]
      for (const edge of edges.get(node) ?? []) {
        if (chains.has(edge.to)) continue
        chains.set(edge.to, [...chain, edge.label])
        next.push(edge.to)
      }
    }
    frontier = next
  }
  return chains
}

export interface ServerGraphVerdict {
  /** Unzoned files and imports the zone rules refuse, each with the chain from an entry. */
  readonly violations: readonly ZoneLeak[]
}

/**
 * Check a server bundle's graph against the zone rules. Unlike the browser build, backend code is
 * expected here; what is refused is a first-party file in no zone, an import the rules forbid
 * (backend reaching frontend code, shared reaching anything but shared code), and shared code reaching
 * a server built-in or the backend-only marker. The build's own entries and generated modules are
 * `generated`, so they may import both halves.
 */
export function verifyServerGraph(
  graph: ClientModuleGraph,
  options: VerifyClientGraphOptions,
): ServerGraphVerdict {
  const { classifier, sourceOf } = options
  const display = (file: string): string => {
    const rel = relative(classifier.appRoot, file).replaceAll("\\", "/")
    return rel.startsWith("..") || isAbsolute(rel) ? file : rel
  }
  const fileOf = (id: string): string | undefined => {
    const source = sourceOf(id)
    return source.kind === "builtin" ? undefined : source.file
  }
  const labelOf = (id: string): string => {
    const file = fileOf(id)
    return file === undefined ? id : display(file)
  }
  const classes = new Map<string, Classification | undefined>()
  const classOf = (id: string): Classification | undefined => {
    if (!classes.has(id)) {
      const source = sourceOf(id)
      classes.set(id, source.kind === "file" ? classifier.classify(source.file) : undefined)
    }
    return classes.get(id)
  }
  const idByFile = new Map<string, string>()
  for (const id of Object.keys(graph.modules)) {
    const source = sourceOf(id)
    if (source.kind === "file") idByFile.set(source.file, id)
  }
  const resolveEdge = (im: GraphImport): string | undefined => {
    if (im.path === undefined || im.external === true) return undefined
    if (graph.modules[im.path] !== undefined) return im.path
    const source = sourceOf(im.path)
    if (source.kind !== "file") return undefined
    // Bun keeps the edge to a module tree-shaking removed and drops the module; its zone still counts.
    return idByFile.get(source.file) ?? (existsSync(source.file) ? im.path : undefined)
  }

  const edges = new Map<string, Array<{ readonly to: string; readonly label: string }>>()
  const found: Array<{
    readonly at: string
    readonly module: string
    readonly reason: string
    readonly tail?: string
  }> = []
  for (const [id, module] of Object.entries(graph.modules)) {
    const from = classOf(id)
    if (from?.zone === "error") found.push({ at: id, module: labelOf(id), reason: from.reason })
    const file = fileOf(id)
    const env =
      from !== undefined && file !== undefined && BROWSER_CODE.has(from.zone)
        ? options.privateEnv?.(file)
        : undefined
    if (env !== undefined) found.push({ at: id, module: labelOf(id), reason: env })
    const out: Array<{ readonly to: string; readonly label: string }> = []
    for (const im of module.imports) {
      const spec = im.original ?? im.path ?? ""
      if (from?.zone === "shared") {
        const builtin =
          isBuiltinSpec(spec) || (im.path !== undefined && sourceOf(im.path).kind === "builtin")
        if (builtin || spec === BACKEND_ONLY_MARKER) {
          found.push({
            at: id,
            module: labelOf(id),
            reason: `shared code runs on both sides, so it may not import "${spec}"; move the code that needs it under backend/`,
            tail: spec,
          })
        }
      }
      const target = resolveEdge(im)
      if (target === undefined) continue
      out.push({ to: target, label: im.original ?? labelOf(target) })
      const to = classOf(target)
      if (from === undefined || to === undefined || from.zone === "error" || to.zone === "error")
        continue
      if (!importAllowed(from.zone, to.zone)) {
        found.push({
          at: id,
          module: labelOf(target),
          reason: importRuleMessage(labelOf(id), from.zone, labelOf(target), to.zone),
          tail: im.original ?? labelOf(target),
        })
      }
    }
    edges.set(id, out)
  }
  if (found.length === 0) return { violations: [] }

  const entries = [
    ...new Set(
      Object.values(graph.chunks)
        .map((chunk) => chunk.entryPoint)
        .filter((entry): entry is string => entry !== undefined),
    ),
  ]
  const chains = shortestChains(entries, edges)
  const violations = found
    .map(({ at, module, reason, tail }) => {
      const chain = (chains.get(at) ?? [at]).map((label, i) => (i === 0 ? labelOf(label) : label))
      return { module, reason, chain: tail === undefined ? chain : [...chain, tail] }
    })
    .sort((a, b) => a.module.localeCompare(b.module) || a.reason.localeCompare(b.reason))
  return { violations }
}

/** The build-failing message for a server graph that breaks the zone rules. */
export function formatServerGraphVerdict(verdict: ServerGraphVerdict): string | undefined {
  if (verdict.violations.length === 0) return undefined
  const lines = verdict.violations.map(
    (v) =>
      `  - ${v.module}: ${v.reason}${v.chain.length > 1 ? `\n      via ${v.chain.join(" → ")}` : ""}`,
  )
  return `[nifra/web] the server build breaks the zone rules:\n${lines.join("\n")}`
}

/** One emitted file, as the accounting sees it. */
export interface EmittedFile {
  /** Output path relative to the output directory. */
  readonly name: string
  readonly kind: "code" | "css" | "asset" | "map"
  /** Source files the bundler says an asset came from, when it says. */
  readonly sources?: readonly string[]
  /** The file's text, for code and maps. */
  readonly text?: string
}

/**
 * Why a file may not ship as an asset - its bytes copied or inlined into the bundle - or `undefined`
 * when it may. A server function reaches the browser only as the stub its import is replaced with, so
 * as an asset it is the server source itself.
 */
export function assetDenial(classification: Classification): string | undefined {
  return (
    browserDenial(classification) ??
    (classification.zone === "fn"
      ? "it is a server function, and this asset is its source rather than the calls a browser makes"
      : undefined)
  )
}

/**
 * Trace every emitted file back to the graph. A code or CSS file must be a graph chunk; an asset must
 * name the module it was copied from; a source map (external or inline) may name browser-allowed
 * sources only.
 */
export function accountEmittedFiles(
  files: readonly EmittedFile[],
  graph: ClientModuleGraph,
  options: VerifyClientGraphOptions & {
    /** Where the files will be written; source map paths resolve against it. */
    readonly outDir: string
  },
): string[] {
  const { classifier, sourceOf } = options
  const problems: string[] = []
  const chunkNames = new Set(Object.keys(graph.chunks).map((path) => basename(path)))
  const moduleFiles = new Map<string, string[]>()
  for (const id of Object.keys(graph.modules)) {
    const source = sourceOf(id)
    if (source.kind !== "file") continue
    const name = basename(source.file)
    moduleFiles.set(name, [...(moduleFiles.get(name) ?? []), source.file])
  }
  const checkSources = (where: string, sources: readonly string[], asset = false): void => {
    for (const file of sources) {
      const classification = classifier.classify(file)
      const reason = asset ? assetDenial(classification) : browserDenial(classification)
      if (reason !== undefined) problems.push(`${where} names ${file}: ${reason}`)
    }
  }
  for (const file of files) {
    const name = basename(file.name)
    if (file.kind === "code" || file.kind === "css") {
      if (!chunkNames.has(name))
        problems.push(`${file.name} is in the output but not in the module graph`)
      const inline = file.kind === "code" ? inlineSourceMap(file.text) : undefined
      if (inline !== undefined) {
        checkSources(`${file.name}'s inline source map`, mapSourceFiles(inline, options.outDir))
      }
      continue
    }
    if (file.kind === "map") {
      const map = parseMap(file.text)
      if (map === undefined) {
        problems.push(`${file.name} is not a readable source map`)
        continue
      }
      checkSources(file.name, mapSourceFiles(map, dirname(resolve(options.outDir, file.name))))
      continue
    }
    const sources = file.sources ?? assetSourcesByName(name, moduleFiles)
    if (sources.length === 0) {
      problems.push(`${file.name} was emitted, but no module in the graph accounts for it`)
      continue
    }
    checkSources(file.name, sources, true)
  }
  return problems
}

/** `logo-a1b2c3d4.png` came from a graph module named `logo.png`. */
function assetSourcesByName(name: string, moduleFiles: ReadonlyMap<string, string[]>): string[] {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const dash = stem.lastIndexOf("-")
  if (dash <= 0) return moduleFiles.get(name) ?? []
  return moduleFiles.get(`${stem.slice(0, dash)}${ext}`) ?? []
}

interface SourceMapLike {
  readonly sources?: readonly (string | null)[]
  readonly sourceRoot?: string
  readonly sections?: ReadonlyArray<{ readonly map?: SourceMapLike }>
}

function parseMap(text: string | undefined): SourceMapLike | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? (parsed as SourceMapLike) : undefined
  } catch {
    return undefined
  }
}

function inlineSourceMap(text: string | undefined): SourceMapLike | undefined {
  if (text === undefined) return undefined
  const match = /[#@] sourceMappingURL=data:application\/json[^,]*?(;base64)?,([^\s'"]+)/.exec(text)
  if (match === null) return undefined
  const payload = match[2] ?? ""
  try {
    const json =
      match[1] !== undefined
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload)
    return parseMap(json) ?? { sources: ["<unreadable inline source map>"] }
  } catch {
    return { sources: ["<unreadable inline source map>"] }
  }
}

/** Every source a map (or an indexed map's sections) names that exists on disk, as absolute paths. */
function mapSourceFiles(map: SourceMapLike, base: string): string[] {
  const files: string[] = []
  for (const section of map.sections ?? []) {
    if (section.map !== undefined) files.push(...mapSourceFiles(section.map, base))
  }
  const root = map.sourceRoot ?? ""
  for (const source of map.sources ?? []) {
    if (source === null || source === "") continue
    const path = source.replace(/^file:\/\//, "")
    const absolute = isAbsolute(path) ? path : resolve(base, root, path)
    // Virtual sources (`\0id`, bundler helpers) have no file to classify; their code came from a
    // graph module that was classified already.
    if (existsSync(absolute)) files.push(absolute)
  }
  return files
}

const indent = (lines: readonly string[]): string => lines.map((line) => `  - ${line}`).join("\n")

/** The build-failing message for a verdict, or `undefined` when the build is clean. */
export function formatClientGraphVerdict(verdict: ClientGraphVerdict): string | undefined {
  const sections: string[] = []
  if (verdict.leaks.length > 0) {
    const lines = verdict.leaks.map(
      (leak) =>
        `  - ${leak.module}: ${leak.reason}${leak.chain.length > 1 ? `\n      via ${leak.chain.join(" → ")}` : ""}`,
    )
    sections.push(
      `[nifra/web] the browser build reached code that may not ship to a browser:\n${lines.join("\n")}\n` +
        "Reach backend code through a route's backend half (x.backend.ts) or a *.fn.ts server function; " +
        "code both sides need belongs in shared/.",
    )
  }
  if (verdict.misplacedExports.length > 0) {
    sections.push(
      `[nifra/web] route frontend files export server-only names:\n${indent(verdict.misplacedExports)}\n` +
        "`nifra migrate layout` splits every route of an app into its two halves.",
    )
  }
  if (verdict.gaps.length > 0) {
    sections.push(
      "[nifra/web] the client build's module graph does not account for everything it reached, so " +
        `nifra cannot prove the bundle is browser-only:\n${indent(verdict.gaps)}`,
    )
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined
}

/** The build-failing message for emitted files the graph does not account for. */
export function formatUnaccountedOutput(problems: readonly string[]): string | undefined {
  if (problems.length === 0) return undefined
  return `[nifra/web] the client build emitted files nifra cannot trace to browser code:\n${indent(problems)}`
}
