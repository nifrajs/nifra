/**
 * StyleX integration for Nifra's Bun and Vite pipelines.
 *
 * The StyleX compiler stays an optional peer owned by the StyleX project. This module owns only the
 * Nifra boundary: transform route/component modules in both pipelines, emit client CSS through the
 * existing virtual stylesheet seam, and run the same transform without CSS for SSR.
 */
import type { BunPlugin } from "bun"
import {
  createStylesheetEmitter,
  devServerCompile,
  hash8,
  normalizeFilePath,
  reproduciblePath,
  requirePeer,
} from "./kit.ts"

const STYLE_NS = "nifra-stylex"
const JS_FILTER = /\.[cm]?[jt]sx?(\?|$)/

/** StyleX's module resolution option, kept structural so the compiler remains an optional peer. */
export interface StylexModuleResolution {
  readonly type: "commonJS" | "haste"
  readonly rootDir: string
}

/** Structural slice of `@babel/core` used by the adapter. */
export interface StylexBabelCompiler {
  transformAsync(
    source: string,
    options: Readonly<Record<string, unknown>>,
  ): Promise<StylexBabelResult | null | undefined>
}

/** Structural slice of the StyleX Babel plugin used by the adapter. */
export interface StylexCompiler {
  withOptions(options: Readonly<Record<string, unknown>>): unknown
  processStylexRules(rules: readonly unknown[], options: Readonly<Record<string, unknown>>): string
}

/** Optional peer injection and compiler configuration shared by Bun and Vite adapters. */
export interface StylexPluginOptions {
  /** Inject `@babel/core` in tests or advanced integrations. Defaults to the optional peer. */
  readonly babel?: StylexBabelCompiler
  /** Inject `@stylexjs/babel-plugin` in tests or advanced integrations. */
  readonly compiler?: StylexCompiler
  /** Inject Babel syntax plugins. Defaults to the three official syntax peers. */
  readonly syntaxPlugins?: {
    readonly flow: unknown
    readonly jsx: unknown
    readonly typescript: unknown
  }
  /** StyleX import sources to transform. Defaults to `stylex` and `@stylexjs/stylex`. */
  readonly importSources?: readonly string[]
  /** StyleX development transform mode. Defaults to Nifra's dev-server signal. */
  readonly dev?: boolean
  /** StyleX CSS layer output. Defaults to `true` for deterministic precedence. */
  readonly useCSSLayers?: boolean
  /** StyleX's module resolution policy. */
  readonly unstable_moduleResolution?: StylexModuleResolution
  /** Extra Babel plugins and presets merged before the StyleX plugin. */
  readonly babelConfig?: {
    readonly plugins?: readonly unknown[]
    readonly presets?: readonly unknown[]
  }
}

interface StylexBabelResult {
  readonly code?: unknown
  readonly metadata?: unknown
}

interface StylexTransformedModule {
  readonly code: string
  readonly css: string
}

interface StylexDependencies {
  readonly babel: StylexBabelCompiler
  readonly compiler: StylexCompiler
  readonly syntax: Required<StylexPluginOptions>["syntaxPlugins"]
}

interface RecordLike {
  readonly [key: string]: unknown
}

const isRecord = (value: unknown): value is RecordLike =>
  (typeof value === "object" && value !== null) || typeof value === "function"

const unwrapDefault = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  return value.default ?? value
}

const isBabelCompiler = (value: unknown): value is StylexBabelCompiler =>
  isRecord(value) && typeof value.transformAsync === "function"

const isStylexCompiler = (value: unknown): value is StylexCompiler =>
  isRecord(value) &&
  typeof value.withOptions === "function" &&
  typeof value.processStylexRules === "function"

const syntaxPeer = async (specifier: string, feature: string): Promise<unknown> =>
  unwrapDefault(
    await requirePeer<unknown>(specifier, {
      feature,
      install: `bun add -d ${specifier}`,
    }),
  )

const loadBabelCompiler = async (options: StylexPluginOptions): Promise<StylexBabelCompiler> => {
  if (options.babel !== undefined) return options.babel
  const loaded = await requirePeer<unknown>("@babel/core", {
    feature: "StyleX compilation",
    install: "bun add -d @babel/core",
  })
  const compiler = unwrapDefault(loaded)
  if (!isBabelCompiler(compiler)) {
    throw new Error("[nifra/web] the installed @babel/core does not expose transformAsync")
  }
  return compiler
}

const loadStylexCompiler = async (options: StylexPluginOptions): Promise<StylexCompiler> => {
  if (options.compiler !== undefined) return options.compiler
  const loaded = await requirePeer<unknown>("@stylexjs/babel-plugin", {
    feature: "StyleX compilation",
    install: "bun add -d @stylexjs/babel-plugin",
  })
  const compiler = unwrapDefault(loaded)
  if (!isStylexCompiler(compiler)) {
    throw new Error(
      "[nifra/web] the installed @stylexjs/babel-plugin does not expose the StyleX compiler API",
    )
  }
  return compiler
}

const loadSyntaxPlugins = async (
  options: StylexPluginOptions,
): Promise<Required<StylexPluginOptions>["syntaxPlugins"]> => {
  if (options.syntaxPlugins !== undefined) return options.syntaxPlugins
  const [flow, jsx, typescript] = await Promise.all([
    syntaxPeer("@babel/plugin-syntax-flow", "StyleX Flow syntax parsing"),
    syntaxPeer("@babel/plugin-syntax-jsx", "StyleX JSX syntax parsing"),
    syntaxPeer("@babel/plugin-syntax-typescript", "StyleX TypeScript syntax parsing"),
  ])
  return { flow, jsx, typescript }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const containsStylexImport = (source: string, importSources: readonly string[]): boolean =>
  importSources.some((specifier) => {
    const escaped = escapeRegExp(specifier)
    return new RegExp(
      `(?:from\\s*['"]${escaped}['"]|import\\s*\\(\\s*['"]${escaped}['"]\\s*\\)|require\\s*\\(\\s*['"]${escaped}['"]\\s*\\))`,
      "m",
    ).test(source)
  })

const loaderFor = (path: string): "js" | "jsx" | "ts" | "tsx" => {
  const clean = path.split("?", 1)[0] ?? path
  if (clean.endsWith(".tsx")) return "tsx"
  if (clean.endsWith(".jsx")) return "jsx"
  if (clean.endsWith(".ts") || clean.endsWith(".mts") || clean.endsWith(".cts")) return "ts"
  return "js"
}

const moduleResolution = (options: StylexPluginOptions): StylexModuleResolution =>
  options.unstable_moduleResolution ?? { type: "commonJS", rootDir: process.cwd() }

const transformModule = async (
  source: string,
  filename: string,
  options: StylexPluginOptions,
  dependencies: Promise<StylexDependencies>,
): Promise<StylexTransformedModule | undefined> => {
  if (!containsStylexImport(source, options.importSources ?? ["stylex", "@stylexjs/stylex"])) {
    return undefined
  }

  const { babel, compiler, syntax } = await dependencies
  const result = await babel.transformAsync(source, {
    babelrc: false,
    filename,
    presets: [...(options.babelConfig?.presets ?? [])],
    plugins: [
      ...((options.babelConfig?.plugins ?? []) as readonly unknown[]),
      /\.jsx?$/.test(filename) ? syntax.flow : [syntax.typescript, { isTSX: true }],
      syntax.jsx,
      compiler.withOptions({
        dev: options.dev ?? devServerCompile(),
        importSources: options.importSources ?? ["stylex", "@stylexjs/stylex"],
        treeshakeCompensation: true,
        unstable_moduleResolution: moduleResolution(options),
      }),
    ],
  })
  const code = typeof result?.code === "string" ? result.code : undefined
  if (code === undefined) return undefined

  const metadata = isRecord(result?.metadata) ? result.metadata : undefined
  const rules = Array.isArray(metadata?.stylex) ? metadata.stylex : []
  const css =
    rules.length === 0
      ? ""
      : compiler.processStylexRules(rules, {
          useCSSLayers: options.useCSSLayers ?? true,
        })
  return { code, css }
}

const dependenciesFor = (options: StylexPluginOptions): (() => Promise<StylexDependencies>) => {
  let dependencies: Promise<StylexDependencies> | undefined
  return (): Promise<StylexDependencies> => {
    dependencies ??= Promise.all([
      loadBabelCompiler(options),
      loadStylexCompiler(options),
      loadSyntaxPlugins(options),
    ]).then(([babel, compiler, syntax]) => ({ babel, compiler, syntax }))
    return dependencies
  }
}

/** Build a Bun plugin that transforms StyleX and emits CSS for the browser or class maps for SSR. */
export function stylexBunPlugin(
  generate: "dom" | "ssr",
  options: StylexPluginOptions = {},
): BunPlugin {
  return {
    name: `nifra-stylex-${generate}`,
    setup(build) {
      const stylesheet = generate === "dom" ? createStylesheetEmitter(build, STYLE_NS) : undefined
      const dependencies = dependenciesFor(options)
      build.onLoad({ filter: JS_FILTER }, async (args) => {
        const path = normalizeFilePath(args.path)
        const source = await Bun.file(path).text()
        const transformed = await transformModule(source, path, options, dependencies())
        if (transformed === undefined) return
        const contents =
          generate === "dom" && stylesheet !== undefined && transformed.css !== ""
            ? `${transformed.code}\n${stylesheet.emit(path, transformed.css)}`
            : transformed.code
        return { contents, loader: loaderFor(path) }
      })
    },
  }
}

/** Structural Vite plugin return type. Vite remains an optional peer of `@nifrajs/web`. */
export interface StylexVitePlugin {
  readonly name: string
  transform(
    source: string,
    id: string,
  ): Promise<{ readonly code: string; readonly map?: null } | undefined>
  resolveId(id: string): string | undefined
  load(id: string): string | undefined
}

/** Build a Vite plugin that maps each transformed StyleX module to a virtual CSS asset. */
export function stylexVitePlugin(
  generate: "dom" | "ssr",
  options: StylexPluginOptions = {},
): StylexVitePlugin {
  const cssById = new Map<string, string>()
  const dependencies = dependenciesFor(options)
  const virtualIdFor = (id: string): string =>
    `virtual:nifra-stylex/${hash8(reproduciblePath(normalizeFilePath(id)))}.css`

  return {
    name: `nifra-stylex-${generate}`,
    async transform(source, id) {
      const path = normalizeFilePath(id)
      const transformed = await transformModule(source, path, options, dependencies())
      if (transformed === undefined) return undefined
      if (generate === "ssr" || transformed.css === "") return { code: transformed.code, map: null }
      const cssId = virtualIdFor(path)
      cssById.set(cssId, transformed.css)
      return {
        code: `${transformed.code}\nimport ${JSON.stringify(cssId)}`,
        map: null,
      }
    },
    resolveId(id) {
      return cssById.has(id) ? id : undefined
    },
    load(id) {
      return cssById.get(id)
    },
  }
}

/** Convenience alias for apps that configure only a browser Vite build. */
export const stylexVite = (options: StylexPluginOptions = {}): StylexVitePlugin =>
  stylexVitePlugin("dom", options)
