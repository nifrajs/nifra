import { transformCssModule } from "../plugins/css-modules.ts"
import { reproduciblePath, type StylesheetEmitter } from "../plugins/kit.ts"

/**
 * The JS module a compiled stylesheet loads as. A CSS module exports its scoped class map, a plain
 * stylesheet nothing; on dom either one imports its CSS into the client bundle, and on ssr it brings no CSS.
 */
export function stylesheetModule(
  path: string,
  css: string,
  module: boolean,
  generate: "dom" | "ssr",
  stylesheet: StylesheetEmitter,
): { contents: string; loader: "js" } {
  if (!module)
    return { contents: generate === "dom" ? stylesheet.emit(path, css) : "", loader: "js" }
  // Hash scoped names off the cwd-relative path so they're reproducible across machines/CI.
  const { exports, css: scoped } = transformCssModule(css, reproduciblePath(path))
  const js = `export default ${JSON.stringify(exports)}\n`
  return { contents: generate === "dom" ? js + stylesheet.emit(path, scoped) : js, loader: "js" }
}
