/**
 * `@nifrajs/web/plugins/scss` — a SASS/SCSS (`*.scss`, `*.sass`) Bun plugin, in its OWN module so the SSR
 * preload registers it BEFORE any Sass file loads. Mirrors the `@nifrajs/web-vue/plugin` seam: pass
 * `"dom"` for the client bundle (`buildClient({ plugins: [...] })`) and preload `"ssr"` for the server
 * (`bun --preload`).
 *
 * The Dart Sass compiler is an **optional peer** (`sass`, or the faster `sass-embedded` — same API), not
 * a hard dependency: it's loaded on first Sass file and fails loud with an install hint if absent. Pass
 * your own `compiler` to override (e.g. `sass-embedded`, or a stub in tests).
 *
 * Composes with CSS Modules: a `*.module.scss` / `*.module.sass` file is compiled to CSS and then run
 * through the same scoped-class transform as `@nifrajs/web/plugins/css-modules`, so its `import styles`
 * yields the `{ original: scoped }` map (SSR/dom class-map parity included). A plain `*.scss` is a
 * side-effect import — its CSS is bundled (dom) and it resolves to an empty module (ssr).
 */
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import type { BunPlugin } from "bun"
import { transformCssModule } from "./css-modules.ts"
import { createStylesheetEmitter, reproduciblePath, requirePeer } from "./kit.ts"

const STYLE_NS = "nifra-scss"

/** The subset of the `sass` / `sass-embedded` API this plugin uses. Both packages satisfy it. */
export interface SassCompiler {
  compileString(
    source: string,
    options?: {
      readonly syntax?: "scss" | "indented"
      readonly style?: "expanded" | "compressed"
      readonly loadPaths?: readonly string[]
      readonly url?: URL
    },
  ): { readonly css: string }
}

export interface ScssPluginOptions {
  /** Inject the compiler (default: the `sass` optional peer, loaded lazily). Pass `sass-embedded` or a stub. */
  readonly compiler?: SassCompiler
  /** Output style handed to Sass. Default `"expanded"` (Bun minifies the final CSS bundle anyway). */
  readonly style?: "expanded" | "compressed"
  /** Extra import search paths for `@use`/`@import`, in addition to the source file's own directory. */
  readonly loadPaths?: readonly string[]
}

const isModuleRequest = (cleanPath: string): boolean => /\.module\.s[ac]ss$/.test(cleanPath)

/**
 * The SASS/SCSS Bun plugin. `"dom"` → bundles the compiled CSS (and, for `*.module.scss`, exports the
 * scoped class map); `"ssr"` → the class map only for `*.module.scss`, an empty module for plain Sass.
 * Tolerates a trailing `?query` (dev servers append one to bust Bun's import cache).
 */
export function scssBunPlugin(generate: "dom" | "ssr", options: ScssPluginOptions = {}): BunPlugin {
  return {
    name: `nifra-scss-${generate}`,
    setup(build) {
      const stylesheet = createStylesheetEmitter(build, STYLE_NS)
      let compiler = options.compiler
      const getCompiler = async (): Promise<SassCompiler> => {
        compiler ??= await requirePeer<SassCompiler>("sass", {
          feature: "SASS/SCSS support",
          install: "bun add -d sass",
        })
        return compiler
      }

      build.onLoad({ filter: /\.s[ac]ss(\?|$)/ }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        const source = await Bun.file(path).text()
        const sass = await getCompiler()
        let css: string
        try {
          css = sass.compileString(source, {
            syntax: path.endsWith(".sass") ? "indented" : "scss",
            style: options.style ?? "expanded",
            loadPaths: [dirname(path), ...(options.loadPaths ?? [])],
            url: pathToFileURL(path),
          }).css
        } catch (err) {
          // Attribute the Sass compile error to the file + package (Dart Sass errors carry line info).
          throw new Error(
            `[nifra/web] failed to compile ${path}: ${(err as Error)?.message ?? err}`,
            {
              cause: err,
            },
          )
        }

        if (isModuleRequest(path)) {
          // *.module.scss → compile, then scope class names through the shared CSS-modules transform.
          // Scope off the cwd-relative path so names are reproducible across machines/CI.
          const { exports, css: scopedCss } = transformCssModule(css, reproduciblePath(path))
          const js = `export default ${JSON.stringify(exports)}\n`
          return {
            contents: generate === "dom" ? js + stylesheet.emit(path, scopedCss) : js,
            loader: "js",
          }
        }

        // Plain *.scss → side-effect import: bundle the CSS on dom, an empty module on ssr.
        return {
          contents: generate === "dom" ? stylesheet.emit(path, css) : "",
          loader: "js",
        }
      })
    },
  }
}
