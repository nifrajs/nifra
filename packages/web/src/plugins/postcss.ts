/**
 * `@nifrajs/web/plugins/postcss` - a PostCSS (`*.css`, `*.pcss`, `*.postcss`) Bun plugin, in its OWN
 * module so the SSR preload registers it BEFORE any CSS file loads. Mirrors `@nifrajs/web/plugins/scss`:
 * pass `"dom"` for the client bundle (`buildClient({ plugins: [...] })`) and preload `"ssr"` for the
 * server (`bun --preload`).
 *
 * PostCSS (`postcss`) is an **optional peer**, not a hard dependency: it's loaded on the first CSS file
 * and fails loud with an install hint if absent. The plugin list comes from an explicit `plugins`
 * option, or - when omitted - from the project's `postcss.config.js`, loaded via the optional
 * `postcss-load-config` peer. This is the Tailwind v4 path: a config with `@tailwindcss/postcss` runs
 * inside PostCSS, so `app.css` importing `tailwindcss` is compiled during `Bun.build` with no
 * framework-specific code (v4 bundles its own Lightning CSS, so no separate autoprefixer step).
 *
 * Composes with CSS Modules: a `*.module.css` / `*.module.pcss` file is processed and then run through
 * the same scoped-class transform as `@nifrajs/web/plugins/css-modules`, so `import styles` yields the
 * `{ original: scoped }` map (SSR/dom class-map parity). A plain CSS file is a side-effect import - its
 * CSS is bundled (dom) and it resolves to an empty module (ssr).
 */
import type { BunPlugin } from "bun"
import { transformCssModule } from "./css-modules.ts"
import { createStylesheetEmitter, reproduciblePath, requirePeer } from "./kit.ts"

const STYLE_NS = "nifra-postcss"

/** The subset of the `postcss` API this plugin uses (structural, so no hard dependency on its types). */
export type PostcssProcessor = (plugins?: readonly unknown[]) => {
  process(
    css: string,
    options: { readonly from?: string; readonly to?: string },
  ): PromiseLike<{ readonly css: string }>
}

/** The subset of `postcss-load-config` this plugin uses when no explicit `plugins` are given. */
export type PostcssConfigLoader = (
  ctx?: Record<string, unknown>,
  path?: string,
) => Promise<{ readonly plugins?: readonly unknown[]; readonly options?: Record<string, unknown> }>

export interface PostcssPluginOptions {
  /** Inject the `postcss` function (default: the optional peer, loaded lazily). Pass a stub in tests. */
  readonly postcss?: PostcssProcessor
  /** PostCSS plugins to run. When omitted, the project's `postcss.config.js` is loaded instead. */
  readonly plugins?: readonly unknown[]
  /** Directory (or file) to load `postcss.config.js` from, when `plugins` is omitted. Default: cwd. */
  readonly config?: string
  /** Inject the config loader (default: the `postcss-load-config` optional peer). */
  readonly loadConfig?: PostcssConfigLoader
}

const CSS_FILTER = /\.(css|pcss|postcss)(\?|$)/
const isModuleRequest = (cleanPath: string): boolean =>
  /\.module\.(css|pcss|postcss)$/.test(cleanPath)

/**
 * The PostCSS Bun plugin. `"dom"` → bundles the processed CSS (and, for `*.module.*`, exports the
 * scoped class map); `"ssr"` → the class map only for `*.module.*`, an empty module for plain CSS.
 * Tolerates a trailing `?query` (dev servers append one to bust Bun's import cache).
 */
export function postcssBunPlugin(
  generate: "dom" | "ssr",
  options: PostcssPluginOptions = {},
): BunPlugin {
  return {
    name: `nifra-postcss-${generate}`,
    setup(build) {
      const stylesheet = createStylesheetEmitter(build, STYLE_NS)
      let processor = options.postcss
      let pluginList: readonly unknown[] | undefined = options.plugins

      const getProcessor = async (): Promise<PostcssProcessor> => {
        processor ??= (
          await requirePeer<{ default: PostcssProcessor }>("postcss", {
            feature: "PostCSS/Tailwind support",
            install: "bun add -d postcss",
          })
        ).default
        return processor
      }

      const getPlugins = async (): Promise<readonly unknown[]> => {
        if (pluginList !== undefined) return pluginList
        const load =
          options.loadConfig ??
          (
            await requirePeer<{ default: PostcssConfigLoader }>("postcss-load-config", {
              feature: "loading postcss.config.js (or pass `plugins` explicitly)",
              install: "bun add -d postcss-load-config",
            })
          ).default
        const loaded = await load({}, options.config)
        pluginList = loaded.plugins ?? []
        return pluginList
      }

      build.onLoad({ filter: CSS_FILTER }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const source = await Bun.file(path).text()
        const postcss = await getProcessor()
        const plugins = await getPlugins()
        let css: string
        try {
          css = (await postcss(plugins).process(source, { from: path })).css
        } catch (err) {
          throw new Error(
            `[nifra/web] failed to process ${path}: ${(err as Error)?.message ?? err}`,
            { cause: err },
          )
        }

        if (isModuleRequest(path)) {
          // *.module.css → process, then scope class names through the shared CSS-modules transform.
          // Scope off the cwd-relative path so names are reproducible across machines/CI.
          const { exports, css: scopedCss } = transformCssModule(css, reproduciblePath(path))
          const js = `export default ${JSON.stringify(exports)}\n`
          return {
            contents: generate === "dom" ? js + stylesheet.emit(path, scopedCss) : js,
            loader: "js",
          }
        }

        // Plain CSS → side-effect import: bundle the CSS on dom, an empty module on ssr.
        return {
          contents: generate === "dom" ? stylesheet.emit(path, css) : "",
          loader: "js",
        }
      })
    },
  }
}
