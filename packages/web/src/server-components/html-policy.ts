import { ServerComponentError } from "./error.ts"

const forbidden = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "style",
  "template",
  "noscript",
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
  "frame",
  "frameset",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
])
const urls = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "data",
  "codebase",
])
const fail = (): never => {
  throw new ServerComponentError("component_protocol", 400)
}

function css(value: string): string {
  return (
    value
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(
        /\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
        (_all, hex: string | undefined, char: string | undefined) =>
          hex === undefined
            ? (char ?? "")
            : String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)),
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: URL/CSS schemes must be checked after stripping ASCII controls.
      .replace(/[\u0000-\u0020\u007f]/g, "")
      .toLowerCase()
  )
}

/** The same decoded-attribute policy applies before SSR and before DOM insertion. */
export function validateComponentTag(
  tag: string,
  attributes: readonly { name: string; value: string }[],
  assets?: ReadonlySet<string>,
): void {
  if (tag.toLowerCase() === "link" && assets !== undefined) {
    const attrs = new Map(
      attributes.map((attribute) => [attribute.name.toLowerCase(), attribute.value]),
    )
    if (
      !["preload", "modulepreload"].includes(attrs.get("rel") ?? "") ||
      !assets.has(attrs.get("href") ?? "") ||
      [...attrs.keys()].some(
        (name) => !["rel", "href", "as", "crossorigin", "fetchpriority"].includes(name),
      )
    )
      fail()
    return
  }
  if (forbidden.has(tag.toLowerCase())) fail()
  for (const attribute of attributes) {
    const name = attribute.name.toLowerCase()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Browsers discard these controls when interpreting URL schemes.
    const value = attribute.value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase()
    if (name.startsWith("on") || ["srcdoc", "is", "srcset", "ping"].includes(name)) fail()
    if (urls.has(name) && /^(?:javascript|vbscript|data):/.test(value)) fail()
    if (
      name === "style" &&
      /expression\(|@import|(?:javascript|vbscript|data):|-moz-binding|behavior:/.test(
        css(attribute.value),
      )
    )
      fail()
  }
}
