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
const IMAGE_HINT = new Set([
  "rel",
  "as",
  "href",
  "imagesrcset",
  "imagesizes",
  "crossorigin",
  "fetchpriority",
  "referrerpolicy",
])
const fail = (): never => {
  throw new ServerComponentError("component_protocol", 400)
}

const unsafeUrl = (value: string): boolean =>
  /^(?:javascript|vbscript|data):/.test(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Browsers discard these controls when interpreting URL schemes.
    value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase(),
  )

const isSpace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r"

/**
 * The image candidate URLs of a `srcset`, split as the HTML standard's "parse a srcset attribute"
 * splits them, so each is the URL a browser would fetch: a URL is a run without whitespace, and its
 * descriptors end at the first comma outside parentheses.
 */
function srcsetUrls(value: string): string[] {
  const found: string[] = []
  let at = 0
  while (at < value.length) {
    while (at < value.length && (isSpace(value[at] ?? "") || value[at] === ",")) at++
    const start = at
    while (at < value.length && !isSpace(value[at] ?? "")) at++
    const url = value.slice(start, at)
    if (url === "") break
    if (url.endsWith(",")) {
      found.push(url.replace(/,+$/, ""))
      continue
    }
    found.push(url)
    let inParens = false
    for (; at < value.length; at++) {
      const char = value[at]
      if (char === "(") inParens = true
      else if (char === ")") inParens = false
      else if (char === "," && !inParens) break
    }
  }
  return found
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
    // React writes an image's preload hint ahead of each `<img>` it renders without a document. Like
    // every hint here it is cut from the range, so it only has to be a well-formed image hint.
    if (attrs.get("rel") === "preload" && attrs.get("as") === "image") {
      if (
        [...attrs.keys()].some((name) => !IMAGE_HINT.has(name)) ||
        unsafeUrl(attrs.get("href") ?? "") ||
        srcsetUrls(attrs.get("imagesrcset") ?? "").some(unsafeUrl)
      )
        fail()
      return
    }
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
    if (name.startsWith("on") || ["srcdoc", "is", "ping"].includes(name)) fail()
    if (urls.has(name) && unsafeUrl(attribute.value)) fail()
    if (name === "srcset" && srcsetUrls(attribute.value).some(unsafeUrl)) fail()
    if (
      name === "style" &&
      /expression\(|@import|(?:javascript|vbscript|data):|-moz-binding|behavior:/.test(
        css(attribute.value),
      )
    )
      fail()
  }
}
