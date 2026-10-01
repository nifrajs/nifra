/**
 * `@nifrajs/web/plugins/vite-leak-guard` - nifra's client-leak guards, for a Vite/Rollup production
 * build.
 *
 * ## Why this exists
 *
 * nifra's production default is Bun, and that is not changing: a Vite/Rollup production build inherits
 * Rollup's build profile and gives up the Bun-native advantage nifra competes on. But some apps depend on
 * a Vite-only transform that has no Bun equivalent, and for those a Vite production build is the escape
 * hatch. The moment that hatch exists, the two client-leak guards have to come with it - they are security
 * guards, not lints: one stops secrets and database access from shipping to a browser. A second production
 * pipeline arriving WITHOUT them, or with a hastily re-implemented "mostly ported" copy, is the failure the
 * neutral module-graph seam was built to prevent.
 *
 * So this is not a second implementation. The zone verification (`verifyClientGraph`,
 * `accountEmittedFiles`), the `node:` and `backend-only` detectors and their failure MESSAGES are the
 * exact same functions the Bun build calls. This plugin only adapts Rollup's bundle shape into the
 * neutral `ClientModuleGraph` (`fromRollupBundle`) and runs them. A leak reads identically whichever
 * bundler produced it, and there is one place to change if a guard changes.
 *
 * ## How
 *
 * In `generateBundle` the whole client graph is available: each output chunk lists its `moduleIds`, and
 * `this.getModuleInfo(id)` gives each module's resolved import edges. That is exactly what
 * `fromRollupBundle` needs. Findings fail the build through Rollup's `this.error`, so the message lands in
 * the build output the same way a Bun-build throw does.
 *
 * Add it to the `plugins` of a Vite production build (the LAST plugin, so it sees the final graph),
 * with `viteBareBuiltinExternal()` first so a bare built-in such as `fs/promises` stays named:
 *
 *   // vite.config.ts (production client build)
 *   import { viteBareBuiltinExternal, viteLeakGuard } from "@nifrajs/web/plugins/vite-leak-guard"
 *   export default {
 *     plugins: [viteBareBuiltinExternal()],
 *     build: {
 *       rollupOptions: { external: [/^node:/], plugins: [viteLeakGuard({ appRoot: import.meta.dirname })] },
 *     },
 *   }
 */
import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import {
  detectNodeBuiltinsInClient,
  detectServerOnlyInClient,
  formatNodeBuiltinLeak,
  formatServerOnlyLeak,
} from "../build-plan.ts"
import { isBareNodeBuiltin } from "../internal/node-builtins.ts"
import { privateEnvCheck } from "../internal/private-env.ts"
import {
  accountEmittedFiles,
  type EmittedFile,
  formatClientGraphVerdict,
  formatServerGraphVerdict,
  formatUnaccountedOutput,
  rollupModuleSource,
  verifyClientGraph,
  verifyServerGraph,
} from "../internal/zone-graph.ts"
import {
  type ClientModuleGraph,
  fromRollupBundle,
  type GraphModule,
  type RollupBundleLike,
} from "../module-graph.ts"
import { createZoneClassifier } from "../zones.ts"

/**
 * The Rollup plugin-context slice this uses: `getModuleInfo` for a module's resolved imports, and `error`
 * to fail the build. Typed structurally so the file needs no `rollup`/`vite` type dependency.
 */
interface RollupPluginContext {
  getModuleInfo(id: string): {
    readonly importedIds?: readonly string[]
    readonly dynamicallyImportedIds?: readonly string[]
    readonly isExternal?: boolean
  } | null
  /** Every module the build loaded, including ones tree-shaking left out of every chunk. */
  getModuleIds?(): Iterable<string>
  /**
   * Takes an `Error`, never a string.
   *
   * Handed a string, rolldown synthesizes its own error type and calls `Error.captureStackTrace` on a
   * plain object - which Bun rejects with "First argument must be an Error object", and THAT becomes the
   * build failure. The guard still fires, but its message is replaced by an internal one naming nothing,
   * so a real client leak reports as a stack-trace complaint. Passing an Error skips that construction
   * entirely and the message survives.
   */
  error(error: Error): never
}

/** The parts of a Rollup output file the accounting reads. */
interface RollupOutputLike {
  readonly type?: string
  readonly fileName?: string
  readonly code?: string
  readonly source?: string | Uint8Array
  readonly map?: { readonly sources?: readonly (string | null)[] } | null
  readonly originalFileNames?: readonly string[]
  readonly viteMetadata?: {
    readonly importedCss?: ReadonlySet<string>
    readonly importedAssets?: ReadonlySet<string>
  }
  readonly moduleIds?: readonly string[]
}

export interface LeakGuardOptions {
  /** The app root: the directory holding `routes/`, `frontend/`, `backend/` and `shared/` (default
   * the working directory). */
  readonly appRoot?: string
  /** The routes directory (default `<appRoot>/routes`). */
  readonly routesDir?: string
  /** Vite's `root`, which emitted asset names are relative to (default `appRoot`). */
  readonly root?: string
  /** Where the bundle is written; source map paths resolve against it (default `<root>/dist`). */
  readonly outDir?: string
  /** The build's own generated entry modules. */
  readonly generatedFiles?: readonly string[]
  /** Output files another guarded build already verified (a worker sub-build's chunks). */
  readonly verified?: Set<string>
  /** The public-env prefix browser code may read (default `"PUBLIC_"`; `""` exposes nothing). */
  readonly publicEnvPrefix?: string
}

/** The minimal Rollup plugin shape this returns - `generateBundle` bound to the plugin context. */
export interface LeakGuardPlugin {
  readonly name: string
  /**
   * The finding that failed the build, or `undefined` when the bundle was clean.
   *
   * Recorded as well as thrown because the throw does not reliably survive. A plugin error is handed to
   * the bundler, which builds its own error to report it, and on some Bun + rolldown combinations that
   * construction itself fails (`Error.captureStackTrace` rejecting a non-Error) - so what surfaces is an
   * internal complaint naming neither the leaked module nor its import chain. A caller that owns the
   * build can read this afterwards and raise the real message from its own code, where nothing can
   * rewrite it. A leak is the one failure that must stay legible: the whole point is naming what
   * reached the browser.
   */
  leak?: string
  generateBundle(this: RollupPluginContext, options: unknown, bundle: RollupBundleLike): void
}

const CSS_FILE = /\.(?:css|scss|sass|less|styl)(?:$|\?)/

/**
 * A Vite/Rollup plugin that fails the build when anything the zones keep on the server reaches the client
 * bundle, with the same checks and messages as nifra's Bun build: every module classified, the graph
 * evidence complete, every emitted file traced back to it, and the `node:` and `backend-only` guards.
 * It runs in `generateBundle`, before Rollup writes a byte.
 */
export function viteLeakGuard(options: LeakGuardOptions = {}): LeakGuardPlugin {
  const appRoot = resolve(options.appRoot ?? process.cwd())
  const root = resolve(options.root ?? appRoot)
  const outDir = resolve(root, options.outDir ?? "dist")
  const plugin: LeakGuardPlugin = {
    name: "nifra:leak-guard",
    generateBundle(_options, bundle) {
      const classifier = createZoneClassifier({
        appRoot,
        ...(options.routesDir !== undefined ? { routesDir: options.routesDir } : {}),
        ...(options.generatedFiles !== undefined ? { generatedFiles: options.generatedFiles } : {}),
      })
      // Resolved import edges per module, straight from Rollup's graph. Dynamic imports count too: a
      // `node:`/server-only module reached only via `import()` still ships to the browser.
      const importsOf = (id: string): readonly string[] => {
        const info = this.getModuleInfo(id)
        if (info === null) return []
        return [...(info.importedIds ?? []), ...(info.dynamicallyImportedIds ?? [])]
      }
      const graph = completeGraph(fromRollupBundle(bundle, importsOf), this, importsOf)
      const sources = { classifier, sourceOf: rollupModuleSource }
      const privateEnv = privateEnvCheck(options.publicEnvPrefix ?? "PUBLIC_")
      const outputs = Object.values(bundle as Readonly<Record<string, RollupOutputLike>>)
      for (const output of outputs) {
        if (output.type !== "asset" && output.fileName !== undefined)
          options.verified?.add(output.fileName)
      }
      const leak =
        formatClientGraphVerdict(verifyClientGraph(graph, { ...sources, privateEnv })) ??
        formatNodeBuiltinLeak(detectNodeBuiltinsInClient(graph)) ??
        formatServerOnlyLeak(detectServerOnlyInClient(graph)) ??
        formatUnaccountedOutput(
          accountEmittedFiles(emittedFiles(outputs, graph, root, options.verified), graph, {
            ...sources,
            outDir,
          }),
        )
      if (leak === undefined) return
      // Record before throwing: the throw is what fails the build for a standalone user of this plugin,
      // and the record is what lets a caller that owns the build re-raise the real message (see `leak`).
      plugin.leak = leak
      this.error(new Error(leak))
    },
  }
  return plugin
}

/** What {@link viteServerZoneGuard} needs: the zones of the app, nothing about the output. */
export type ServerZoneGuardOptions = Pick<
  LeakGuardOptions,
  "appRoot" | "routesDir" | "generatedFiles" | "publicEnvPrefix"
>

/**
 * The server build's half of the zone rules, with the same checks and message as nifra's Bun server
 * build: every first-party module zoned, backend code never importing frontend code, shared code
 * importing only shared code. It records the refusal in `leak` for the same reason the client guard
 * does.
 */
export function viteServerZoneGuard(options: ServerZoneGuardOptions = {}): LeakGuardPlugin {
  const appRoot = resolve(options.appRoot ?? process.cwd())
  const plugin: LeakGuardPlugin = {
    name: "nifra:server-zone-guard",
    generateBundle(_options, bundle) {
      const classifier = createZoneClassifier({
        appRoot,
        ...(options.routesDir !== undefined ? { routesDir: options.routesDir } : {}),
        ...(options.generatedFiles !== undefined ? { generatedFiles: options.generatedFiles } : {}),
      })
      const importsOf = (id: string): readonly string[] => {
        const info = this.getModuleInfo(id)
        if (info === null) return []
        return [...(info.importedIds ?? []), ...(info.dynamicallyImportedIds ?? [])]
      }
      const graph = completeGraph(fromRollupBundle(bundle, importsOf), this, importsOf)
      const leak = formatServerGraphVerdict(
        verifyServerGraph(graph, {
          classifier,
          sourceOf: rollupModuleSource,
          privateEnv: privateEnvCheck(options.publicEnvPrefix ?? "PUBLIC_"),
        }),
      )
      if (leak === undefined) return
      plugin.leak = leak
      this.error(new Error(leak))
    },
  }
  return plugin
}

/**
 * The chunk graph plus every module the build loaded but tree-shook out of every chunk, with external
 * edges marked: an import the bundle left external is evidence the graph has to account for.
 */
function completeGraph(
  graph: ClientModuleGraph,
  context: RollupPluginContext,
  importsOf: (id: string) => readonly string[],
): ClientModuleGraph {
  const external = (id: string): boolean => context.getModuleInfo(id)?.isExternal === true
  const modules: Record<string, GraphModule> = {}
  for (const [id, module] of Object.entries(graph.modules)) {
    modules[id] = {
      imports: module.imports.map((im) =>
        im.path !== undefined && !im.path.startsWith("node:") && external(im.path)
          ? { ...im, external: true }
          : im,
      ),
    }
  }
  for (const id of context.getModuleIds?.() ?? []) {
    if (modules[id] !== undefined || external(id)) continue
    modules[id] = {
      imports: importsOf(id).map((path) => (external(path) ? { path, external: true } : { path })),
    }
  }
  return { modules, chunks: graph.chunks }
}

/** Every file in the bundle, with what it claims to come from. */
function emittedFiles(
  outputs: readonly RollupOutputLike[],
  graph: ClientModuleGraph,
  root: string,
  verified: ReadonlySet<string> | undefined,
): EmittedFile[] {
  const fromRoot = (name: string): string => (isAbsolute(name) ? name : resolve(root, name))
  const moduleFiles = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => {
      const source = rollupModuleSource(id)
      return source.kind === "builtin" || source.file === undefined ? [] : [source.file]
    })
  const referencedBy = new Map<string, string[]>()
  for (const output of outputs) {
    if (output.type !== "chunk") continue
    for (const name of [
      ...(output.viteMetadata?.importedCss ?? []),
      ...(output.viteMetadata?.importedAssets ?? []),
    ]) {
      referencedBy.set(name, [
        ...(referencedBy.get(name) ?? []),
        ...moduleFiles(output.moduleIds ?? []),
      ])
    }
  }
  const cssModules = moduleFiles(Object.keys(graph.modules).filter((id) => CSS_FILE.test(id)))
  const files: EmittedFile[] = []
  for (const output of outputs) {
    const name = output.fileName
    // Vite's own bookkeeping (`.vite/manifest.json`); nifra deletes it before anything is deployed.
    if (name === undefined || name.startsWith(".vite/")) continue
    if (output.type === "chunk") {
      files.push({ name, kind: "code", text: output.code ?? "" })
      if (output.map)
        files.push({ name: `${name}.map`, kind: "map", text: JSON.stringify(output.map) })
      continue
    }
    const text = typeof output.source === "string" ? output.source : undefined
    if (name.endsWith(".map")) {
      files.push({ name, kind: "map", ...(text !== undefined ? { text } : {}) })
      continue
    }
    if (verified?.has(name)) continue
    // Vite names a synthesized asset (the `cssCodeSplit: false` aggregate is `style.css`) after no
    // real file; only names that exist are evidence.
    const original = (output.originalFileNames ?? [])
      .map(fromRoot)
      .filter((file) => existsSync(file))
    const referenced = referencedBy.get(name) ?? []
    const sources =
      original.length > 0
        ? original
        : referenced.length > 0
          ? referenced
          : name.endsWith(".css")
            ? cssModules
            : []
    files.push({ name, kind: "asset", sources })
  }
  return files
}

/** The resolve-hook context slice {@link viteBareBuiltinExternal} uses. */
interface ResolveContext {
  resolve(
    source: string,
    importer: string | undefined,
    options: { readonly skipSelf: boolean },
  ): Promise<{ readonly id: string } | null>
}

/** The minimal Vite plugin shape {@link viteBareBuiltinExternal} returns. */
export interface BareBuiltinPlugin {
  readonly name: string
  readonly enforce: "pre"
  resolveId(
    this: ResolveContext,
    source: string,
    importer: string | undefined,
  ): Promise<{ readonly id: string; readonly external?: boolean } | null>
}

/**
 * Keep a bare Node built-in (`fs/promises`, `path`) visible to {@link viteLeakGuard}. Vite resolves a
 * bare built-in that is not an installed package to one shared `__vite-browser-external` stub: the
 * import builds, does nothing in the browser, and no longer names the module. This plugin externalizes
 * it as `node:<name>` instead, so the guard fails the build naming it, as the Bun build does. A package
 * of the same name the app installed (`events`, `buffer`) still resolves to that package.
 */
export function viteBareBuiltinExternal(): BareBuiltinPlugin {
  return {
    name: "nifra:bare-builtin-external",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!isBareNodeBuiltin(source)) return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (resolved !== null && !resolved.id.startsWith("__vite-browser-external")) return resolved
      return { id: `node:${source}`, external: true }
    },
  }
}
