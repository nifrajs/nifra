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
 *     plugins: [viteBareBuiltinExternal(), viteAssetUrlGuard({ appRoot: import.meta.dirname })],
 *     build: {
 *       rollupOptions: { external: [/^node:/], plugins: [viteLeakGuard({ appRoot: import.meta.dirname })] },
 *     },
 *   }
 */
import { existsSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import {
  detectNodeBuiltinsInClient,
  detectServerOnlyInClient,
  formatNodeBuiltinLeak,
  formatServerOnlyLeak,
} from "../build-plan.ts"
import { isBareNodeBuiltin } from "../internal/node-builtins.ts"
import { privateEnvCheck } from "../internal/private-env.ts"
import {
  emittedScanFiles,
  formatSecretFindings,
  graphScanInput,
  originName,
  publicScanFiles,
  type SecretExemption,
  type SecretScanFile,
  scanForSecrets,
  textOf,
} from "../internal/secret-scan.ts"
import {
  accountEmittedFiles,
  assetDenial,
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
import { createZoneClassifier, type ZoneClassifier } from "../zones.ts"

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
  /** The secret scan of what the bundle publishes. */
  readonly secrets?: LeakGuardSecretOptions
}

export interface LeakGuardSecretOptions {
  /** The build environment whose non-public values must not ship (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Reviewed false positives; each names its rule, its file (or env variable) and a reason. */
  readonly exemptions?: readonly SecretExemption[]
  /** A `public/` directory whose files ship beside the bundle, scanned with it. */
  readonly publicDir?: string
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
      const classifier = classifierFor(appRoot, options)
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
        ) ??
        secretLeak(outputs, graph, classifier, appRoot, options)
      if (leak === undefined) return
      // Record before throwing: the throw is what fails the build for a standalone user of this plugin,
      // and the record is what lets a caller that owns the build re-raise the real message (see `leak`).
      plugin.leak = leak
      this.error(new Error(leak))
    },
  }
  return plugin
}

/** The secret scan over a finished bundle and the `public/` files that ship beside it. */
function secretLeak(
  outputs: readonly RollupOutputLike[],
  graph: ClientModuleGraph,
  classifier: ReturnType<typeof createZoneClassifier>,
  appRoot: string,
  options: LeakGuardOptions,
): string | undefined {
  const { sources, originsOf } = graphScanInput(graph, rollupModuleSource, classifier)
  const artifacts: SecretScanFile[] = []
  for (const output of outputs) {
    const name = output.fileName
    if (name === undefined || name.startsWith(".vite/")) continue
    if (output.type === "chunk") {
      artifacts.push(...emittedScanFiles(name, output.code ?? "", originsOf(name)))
      if (output.map) artifacts.push({ name: `${name}.map`, text: JSON.stringify(output.map) })
      continue
    }
    const text =
      typeof output.source === "string"
        ? output.source
        : output.source === undefined
          ? undefined
          : textOf(output.source)
    if (text !== undefined) artifacts.push({ name, text })
  }
  const publicDir = options.secrets?.publicDir
  if (publicDir !== undefined && existsSync(publicDir)) {
    artifacts.push(...publicScanFiles(publicDir, originName(appRoot, resolve(publicDir))))
  }
  return formatSecretFindings(
    scanForSecrets({
      sources,
      artifacts,
      env: options.secrets?.env ?? process.env,
      publicEnvPrefix: options.publicEnvPrefix ?? "PUBLIC_",
      ...(options.secrets?.exemptions ? { exemptions: options.secrets.exemptions } : {}),
    }),
  )
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
      const classifier = classifierFor(appRoot, options)
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

/** The zone classifier for the app `options` names. */
function classifierFor(appRoot: string, options: ServerZoneGuardOptions): ZoneClassifier {
  return createZoneClassifier({
    appRoot,
    ...(options.routesDir !== undefined ? { routesDir: options.routesDir } : {}),
    ...(options.generatedFiles !== undefined ? { generatedFiles: options.generatedFiles } : {}),
  })
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

/** The plugin-context slice {@link viteAssetUrlGuard} uses. */
interface TransformContext extends ResolveContext {
  parse(code: string): unknown
  error(error: Error): never
}

type InlineLimit = number | ((file: string, content: Uint8Array) => boolean | undefined)

/** The minimal Vite plugin shape {@link viteAssetUrlGuard} returns. */
export interface AssetUrlGuardPlugin {
  readonly name: string
  readonly apply: "build"
  /** The refusal that failed the build, recorded for the reason {@link LeakGuardPlugin.leak} gives. */
  leak?: string
  config(config: { readonly build?: { readonly assetsInlineLimit?: InlineLimit } }): {
    readonly build: { readonly assetsInlineLimit: InlineLimit }
  }
  transform(
    this: TransformContext,
    code: string,
    id: string,
    options?: { readonly ssr?: boolean },
  ): Promise<null>
}

const POSTFIX = /[?#].*$/s
const URL_SCHEME = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

/**
 * Keep server files out of a Vite client build's assets. A `new URL("./x", import.meta.url)` makes
 * Vite copy the file it names into the output, or inline it into the chunk as a `data:` URL when it is
 * small - no module and no import edge, so {@link viteLeakGuard}'s graph never sees it. This refuses a
 * reference whose file the zones keep off the browser (backend code, a route's backend half, a server
 * function's source, a file in no zone), and stops Vite inlining such a file anywhere else (a
 * stylesheet's `url()`), so it is emitted where the leak guard's output accounting names it.
 *
 * Add it to the top-level `plugins`, after any framework plugin: it reads each module once that
 * module is JavaScript, before Vite resolves the references.
 */
export function viteAssetUrlGuard(options: ServerZoneGuardOptions = {}): AssetUrlGuardPlugin {
  const appRoot = resolve(options.appRoot ?? process.cwd())
  let classifier: ZoneClassifier | undefined
  const denial = (file: string): string | undefined => {
    classifier ??= classifierFor(appRoot, options)
    return assetDenial(classifier.classify(file))
  }
  const shown = (file: string): string => relative(appRoot, file).replaceAll("\\", "/")
  const plugin: AssetUrlGuardPlugin = {
    name: "nifra:asset-url-guard",
    apply: "build",
    config(config) {
      const own = config.build?.assetsInlineLimit
      return {
        build: {
          assetsInlineLimit: (file, content) =>
            denial(file) !== undefined
              ? false
              : typeof own === "function"
                ? own(file, content)
                : own === undefined
                  ? undefined
                  : content.length < own,
        },
      }
    },
    async transform(code, id, transformOptions) {
      if (transformOptions?.ssr === true || !code.includes("import.meta.url")) return null
      const importer = id.replace(POSTFIX, "")
      if (!isAbsolute(importer) || importer.includes("/node_modules/") || CSS_FILE.test(importer))
        return null
      let program: unknown
      try {
        program = this.parse(code)
      } catch {
        return null
      }
      const problems: string[] = []
      for (const url of newUrlLiterals(program)) {
        if (URL_SCHEME.test(url)) continue
        for (const file of await assetUrlFiles(this, url, importer)) {
          const reason = denial(file)
          if (reason !== undefined) {
            problems.push(
              `${shown(importer)}: new URL(${JSON.stringify(url)}, import.meta.url) names ${shown(file)}: ${reason}`,
            )
          }
        }
      }
      if (problems.length === 0) return null
      const leak =
        `[nifra/web] the browser build references files that may not ship to a browser:\n${problems.map((line) => `  - ${line}`).join("\n")}\n` +
        "The bundler copies or inlines the file such a URL names, so it would ship as it is. Reach " +
        "backend code through a route's backend half (x.backend.ts) or a *.fn.ts server function; a " +
        "file the browser loads belongs in frontend/ or public/."
      plugin.leak = leak
      return this.error(new Error(leak))
    },
  }
  return plugin
}

/**
 * The files a `new URL(url, import.meta.url)` can name, resolved the ways Vite tries: beside the
 * module, then through the resolver (aliases, extensions, a root-relative path). Existing files only;
 * a reference to nothing ships nothing.
 */
async function assetUrlFiles(
  context: ResolveContext,
  url: string,
  importer: string,
): Promise<string[]> {
  const files = new Set<string>()
  const add = (path: string | undefined): void => {
    const file = path?.replace(POSTFIX, "")
    if (file === undefined || !isAbsolute(file) || file.includes("\0")) return
    if (statSync(file, { throwIfNoEntry: false })?.isFile() === true) files.add(file)
  }
  if (!url.startsWith("/")) add(resolve(dirname(importer), url.replace(POSTFIX, "")))
  const sources = url.startsWith(".") || url.startsWith("/") ? [url] : [url, `./${url}`]
  for (const source of sources) {
    try {
      add((await context.resolve(source, importer, { skipSelf: true }))?.id)
    } catch {
      // An unresolvable reference is one Vite leaves unchanged.
    }
  }
  return [...files]
}

const field = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined

/** `import.meta.url`, and not `new.target.url`. */
const isImportMetaUrl = (node: unknown): boolean =>
  field(node, "type") === "MemberExpression" &&
  field(node, "computed") === false &&
  field(field(node, "property"), "name") === "url" &&
  field(field(field(node, "object"), "meta"), "name") === "import"

/** A string literal's text as written and as it evaluates; nothing for a template with holes. */
function literalTexts(node: unknown): string[] {
  const type = field(node, "type")
  if (type === "Literal") {
    const value = field(node, "value")
    const raw = field(node, "raw")
    if (typeof value !== "string") return []
    return typeof raw === "string" ? [value, raw.slice(1, -1)] : [value]
  }
  if (type !== "TemplateLiteral") return []
  const holes = field(node, "expressions")
  const quasis = field(node, "quasis")
  if (!Array.isArray(holes) || holes.length > 0 || !Array.isArray(quasis)) return []
  const value = field(quasis[0], "value")
  return [field(value, "cooked"), field(value, "raw")].filter(
    (text): text is string => typeof text === "string",
  )
}

/**
 * The URL text of every `new URL("...", import.meta.url)` in a parsed module. Parsed rather than
 * matched, so a comment inside the call cannot hide one; a template with holes is skipped, as Vite
 * turns it into an `import.meta.glob` the module graph sees.
 */
function newUrlLiterals(program: unknown): string[] {
  const found = new Set<string>()
  const stack: unknown[] = [program]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== "object" || node === null) continue
    const args = field(node, "arguments")
    if (
      field(node, "type") === "NewExpression" &&
      field(field(node, "callee"), "type") === "Identifier" &&
      field(field(node, "callee"), "name") === "URL" &&
      Array.isArray(args) &&
      isImportMetaUrl(args[1])
    ) {
      for (const text of literalTexts(args[0])) found.add(text)
    }
    for (const child of Object.values(node)) {
      if (typeof child === "object" && child !== null) stack.push(child)
    }
  }
  return [...found]
}
