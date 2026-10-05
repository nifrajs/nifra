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
 * The file must be one well-formed `<svg>` element; anything else is refused rather than guessed at.
 * Its text reaches JSX as text - a brace in a `<style>` rule or a `<title>` is a character, never an
 * expression. The transform camelCases hyphenated + `xlink:`/`xmlns:` attributes, maps `class` →
 * `className`, parses an inline `style="..."` into an object, and drops XML declarations/comments.
 */
import type { BunPlugin } from "bun"
import { normalizeFilePath, requirePeer } from "./kit.ts"

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

/**
 * Strip the XML declaration, comments, and DOCTYPE from an SVG source by index scan. Shared by every
 * adapter's SVG-component transform instead of chained regex `replace`s, for two reasons: the lazy
 * `[\s\S]*?` scans backtrack quadratically on an unterminated marker, and sequential single-pass
 * replaces can splice removed delimiters back together (`<<!---->!DOCTYPE …>` survives them). The
 * scan removes each block in one forward pass, so neither failure mode exists. An unterminated
 * marker swallows the rest of the input - the correct reading, matching an XML parser.
 */
export function stripSvgPreamble(xml: string): string {
  const parts: string[] = []
  let keepFrom = 0
  let i = 0
  while (i < xml.length) {
    let skipEnd = -1
    if (xml.startsWith("<?", i)) {
      const close = xml.indexOf("?>", i + 2)
      skipEnd = close === -1 ? xml.length : close + 2
    } else if (xml.startsWith("<!--", i)) {
      const close = xml.indexOf("-->", i + 4)
      skipEnd = close === -1 ? xml.length : close + 3
    } else if (xml.slice(i, i + 9).toLowerCase() === "<!doctype") {
      const close = xml.indexOf(">", i + 9)
      skipEnd = close === -1 ? xml.length : close + 1
    }
    if (skipEnd === -1) {
      i++
    } else {
      parts.push(xml.slice(keepFrom, i))
      i = skipEnd
      keepFrom = skipEnd
    }
  }
  parts.push(xml.slice(keepFrom))
  return parts.join("").trim()
}

/** How a framework's template must spell an SVG file's text and names, for {@link svgTemplateMarkup}. */
export interface SvgMarkupRules {
  /** Text content as the template must spell it; `cdata` text arrives as a CDATA section held it. */
  readonly text: (text: string, cdata: boolean) => string
  /** An attribute value (without its quotes) as the template must spell it. Default as written. */
  readonly attributeValue?: (value: string) => string
  /** Why the template would read an element or attribute name as more than markup, or `undefined`. */
  readonly refuse?: (name: string, kind: "element" | "attribute") => string | undefined
  /** Elements whose content the template reads as raw text, copied as it is. */
  readonly rawText?: ReadonlySet<string>
}

const svgMarkupError = (detail: string): Error =>
  new Error(`[nifra/web] an SVG component must be plain SVG markup: ${detail}`)

const TAG_NAME = /[A-Za-z_:][\w:.-]*/y
const SPACE = /\s*/y

/**
 * An SVG file's markup rewritten for a framework template: one `<svg>` root, its text and attribute
 * values put through `rules` so none of it reads as template syntax. Markup a well-formed SVG cannot
 * hold is refused rather than passed on - a brace, a bare name or an unquoted value in a tag, content
 * after the root - since each is a way for the file to reach the template as code.
 */
export function svgTemplateMarkup(xml: string, rules: SvgMarkupRules): string {
  const svg = stripSvgPreamble(xml)
  if (!/^<svg[\s/>]/.test(svg)) throw svgMarkupError("it does not start with an <svg> element")
  let out = ""
  let depth = 0
  let i = 0
  while (i < svg.length) {
    if (svg.startsWith("<![CDATA[", i)) {
      const close = svg.indexOf("]]>", i + 9)
      if (close === -1) throw svgMarkupError("a CDATA section is not closed")
      out += rules.text(svg.slice(i + 9, close), true)
      i = close + 3
      continue
    }
    if (svg[i] !== "<") {
      const next = svg.indexOf("<", i)
      const end = next === -1 ? svg.length : next
      out += rules.text(svg.slice(i, end), false)
      i = end
      continue
    }
    const tag = readSvgTag(svg, i, rules)
    out += tag.markup
    i = tag.end
    if (tag.closing) depth--
    else if (!tag.selfClosing) {
      depth++
      if (rules.rawText?.has(tag.name) === true) {
        // Wherever the template's own reading ends this element, in any case, raw text ends here too.
        const close = svg.toLowerCase().indexOf(`</${tag.name.toLowerCase()}`, i)
        const end = close === -1 ? svg.length : close
        out += svg.slice(i, end)
        i = end
      }
    }
    if (depth === 0) {
      if (svg.slice(i).trim() !== "") throw svgMarkupError("there is content after the root </svg>")
      return out
    }
  }
  throw svgMarkupError("the root <svg> element is not closed")
}

/** One tag of {@link svgTemplateMarkup}'s input, rebuilt with each attribute value through `rules`. */
function readSvgTag(
  svg: string,
  start: number,
  rules: SvgMarkupRules,
): { markup: string; end: number; name: string; closing: boolean; selfClosing: boolean } {
  const closing = svg[start + 1] === "/"
  let i = start + (closing ? 2 : 1)
  TAG_NAME.lastIndex = i
  const name = TAG_NAME.exec(svg)?.[0]
  if (name === undefined) throw svgMarkupError(`a "<" at offset ${start} opens no tag`)
  const refused = rules.refuse?.(name, "element")
  if (refused !== undefined) throw svgMarkupError(refused)
  i += name.length
  let markup = `<${closing ? "/" : ""}${name}`
  for (;;) {
    SPACE.lastIndex = i
    const space = SPACE.exec(svg)?.[0] ?? ""
    i += space.length
    if (svg[i] === ">")
      return { markup: `${markup}>`, end: i + 1, name, closing, selfClosing: false }
    if (!closing && svg.startsWith("/>", i)) {
      return { markup: `${markup}/>`, end: i + 2, name, closing, selfClosing: true }
    }
    if (i >= svg.length) throw svgMarkupError(`the tag <${name}> is not closed`)
    TAG_NAME.lastIndex = i
    const attribute = closing || space === "" ? undefined : TAG_NAME.exec(svg)?.[0]
    if (attribute === undefined) {
      throw svgMarkupError(`<${name}> holds ${JSON.stringify(svg[i])} where an attribute belongs`)
    }
    const refusedAttribute = rules.refuse?.(attribute, "attribute")
    if (refusedAttribute !== undefined) throw svgMarkupError(refusedAttribute)
    i += attribute.length
    SPACE.lastIndex = i
    i += SPACE.exec(svg)?.[0].length ?? 0
    if (svg[i] !== "=") throw svgMarkupError(`the attribute ${attribute} on <${name}> has no value`)
    SPACE.lastIndex = i + 1
    i += 1 + (SPACE.exec(svg)?.[0].length ?? 0)
    const quote = svg[i]
    const close = quote === '"' || quote === "'" ? svg.indexOf(quote, i + 1) : -1
    if (close === -1) {
      throw svgMarkupError(`the value of ${attribute} on <${name}> is not a quoted string`)
    }
    const value = svg.slice(i + 1, close)
    markup += ` ${attribute}=${quote}${rules.attributeValue?.(value) ?? value}${quote}`
    i = close + 1
  }
}

/** Text as JSX text: a brace, `>` or `=` as a character reference, so none of it is an expression. */
const jsxText = (text: string, cdata: boolean): string =>
  (cdata ? text.replaceAll("&", "&amp;").replaceAll("<", "&lt;") : text).replace(
    /[{}>=]/g,
    (char) => `&#${char.charCodeAt(0)};`,
  )

/** JSX reads `<a.b>` and `<Name>` as a value in scope, called as a component - never an SVG element. */
const jsxRefuse = (name: string, kind: "element" | "attribute"): string | undefined =>
  kind === "element" && (name.includes(".") || /^[A-Z]/.test(name))
    ? `JSX reads the element <${name}> as a value in scope, not an SVG element`
    : undefined

/** Convert an SVG XML string into a JSX-safe `<svg>…</svg>` element with `{...props}` spread on the root. */
export function svgToJsx(xml: string, options: SvgToJsxOptions = {}): string {
  const classProp = options.classProp ?? "className"
  // Text is escaped first, `=` included, so the attribute rewrites below match inside tags only.
  let out = svgTemplateMarkup(xml, { text: jsxText, refuse: jsxRefuse })

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
        const path = normalizeFilePath(args.path)
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
