/**
 * `@nifrajs/web/plugins/svg` - import an SVG as a component: `import Icon from "./icon.svg?component"`,
 * then `<Icon className="w-6 h-6 text-blue-500" />`. Props spread onto the root `<svg>`, matching the
 * standard Vite `svgr` workflow. In its OWN module so the SSR preload registers it before any SVG
 * loads; pass `"dom"` for the client bundle and preload `"ssr"` for the server (both emit the same
 * isomorphic component).
 *
 * SCOPE: emits an **automatic-JSX-runtime** component, so it works out of the box for the frameworks
 * whose build supplies a `jsxImportSource` - **React and Preact**. Solid (needs `babel-preset-solid`),
 * Svelte, and Vue are not JSX and are intentionally out of v1; a plain `import "./icon.svg"` (asset URL)
 * is untouched - only the `?component` marker is intercepted.
 *
 * Optimization is optional: pass `svgo` (or install the `svgo` peer) to minify/clean the SVG first.
 * The transform is regex-based and targets the common icon-set shape (well-formed, self-closed tags);
 * it camelCases hyphenated + `xlink:`/`xmlns:` attributes, maps `class` → `className`, parses an inline
 * `style="..."` into an object, and drops XML declarations/comments so the result is valid JSX.
 */
import type { BunPlugin } from "bun"
import { requirePeer } from "./kit.ts"

/** The subset of the `svgo` API this plugin uses (structural, so no hard dependency on its types). */
export interface SvgOptimizer {
  optimize(input: string, options?: Record<string, unknown>): { readonly data: string }
}

export interface SvgPluginOptions {
  /** Optimize each SVG first. `true` loads the `svgo` peer; pass an optimizer to inject one (or a stub). */
  readonly svgo?: boolean | SvgOptimizer
}

/** SVG/HTML attribute names that JSX expects camelCased (the common subset on icons). */
const CAMEL_ATTRS = new Map(
  [
    "clip-path",
    "clip-rule",
    "fill-opacity",
    "fill-rule",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-miterlimit",
    "font-family",
    "font-size",
    "font-weight",
    "text-anchor",
    "stop-color",
    "stop-opacity",
    "color-interpolation-filters",
    "flood-color",
    "flood-opacity",
    "vector-effect",
  ].map((name) => [name, name.replace(/-([a-z])/g, (_m, c) => (c as string).toUpperCase())]),
)

function styleToObject(style: string): string {
  const entries = style
    .split(";")
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const idx = decl.indexOf(":")
      const prop = decl
        .slice(0, idx)
        .trim()
        .replace(/-([a-z])/g, (_m, c) => (c as string).toUpperCase())
      const value = decl.slice(idx + 1).trim()
      return `${JSON.stringify(prop)}:${JSON.stringify(value)}`
    })
  return `{{${entries.join(",")}}}`
}

export interface SvgToJsxOptions {
  /** The JSX prop name for `class`. `"className"` for React/Preact; `"class"` for Solid. */
  readonly classProp?: string
}

/** Convert an SVG XML string into a JSX-safe `<svg>…</svg>` element with `{...props}` spread on the root. */
export function svgToJsx(xml: string, options: SvgToJsxOptions = {}): string {
  const classProp = options.classProp ?? "className"
  let out = xml
    .replace(/<\?xml[\s\S]*?\?>/g, "") // XML declaration
    .replace(/<!--[\s\S]*?-->/g, "") // comments
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .trim()

  // Namespaced attributes → camelCase (xlink:href → xlinkHref, xmlns:xlink → xmlnsXlink).
  out = out.replace(/\b([a-z]+):([a-z]+)=/gi, (_m, ns: string, name: string) => {
    return `${ns.toLowerCase()}${name.charAt(0).toUpperCase()}${name.slice(1)}=`
  })
  // Known hyphenated attributes → camelCase.
  for (const [kebab, camel] of CAMEL_ATTRS) {
    out = out.replace(new RegExp(`\\b${kebab}=`, "g"), `${camel}=`)
  }
  // class → the framework's prop (className for React/Preact, class for Solid).
  if (classProp !== "class") out = out.replace(/\bclass=/g, `${classProp}=`)
  // Inline style string → JSX object.
  out = out.replace(/\bstyle="([^"]*)"/g, (_m, css: string) => `style=${styleToObject(css)}`)
  // Spread props onto the root <svg> tag (after the tag name, before its attributes).
  out = out.replace(/^<svg\b/, "<svg {...props}")
  return out
}

/** Emit the component module source for a `?component` SVG import. Identical on dom + ssr (isomorphic). */
export function svgComponentSource(xml: string, options: SvgToJsxOptions = {}): string {
  return `export default function SvgComponent(props){return (${svgToJsx(xml, options)})}\n`
}

/** The Bun `onLoad` filter every adapter's SVG-component plugin matches: `*.svg?component`. */
export const SVG_COMPONENT_FILTER = /\.svg\?component(&|$)/
const SVG_FILTER = SVG_COMPONENT_FILTER

/**
 * The SVG-as-component Bun plugin (React/Preact). `generate` is accepted for parity with the other
 * plugin pairs; the emitted component is the same on `"dom"` and `"ssr"`.
 */
export function svgComponentBunPlugin(
  _generate: "dom" | "ssr",
  options: SvgPluginOptions = {},
): BunPlugin {
  return {
    name: "nifra-svg-component",
    setup(build) {
      let optimizer: SvgOptimizer | undefined =
        typeof options.svgo === "object" ? options.svgo : undefined
      const wantOptimize = options.svgo !== undefined && options.svgo !== false
      const getOptimizer = async (): Promise<SvgOptimizer | undefined> => {
        if (!wantOptimize) return undefined
        optimizer ??= await requirePeer<SvgOptimizer>("svgo", {
          feature: "SVG optimization (svgo)",
          install: "bun add -d svgo",
        })
        return optimizer
      }

      build.onLoad({ filter: SVG_FILTER }, async (args) => {
        const path = args.path.split("?")[0] ?? args.path
        let xml = await Bun.file(path).text()
        const svgo = await getOptimizer()
        if (svgo !== undefined) {
          try {
            xml = svgo.optimize(xml, { path }).data
          } catch (err) {
            throw new Error(
              `[nifra/web] failed to optimize ${path}: ${(err as Error)?.message ?? err}`,
              { cause: err },
            )
          }
        }
        return { contents: svgComponentSource(xml), loader: "jsx" }
      })
    },
  }
}
