import { Tokenizer } from "parse5"
import { ServerComponentError } from "./error.ts"
import { validateComponentTag } from "./html-policy.ts"
import { scanComponentHTML } from "./html-scan.ts"
import { COMPONENT_LIMITS } from "./protocol.ts"

/**
 * A browser reads `title` and `textarea` content as RCDATA, where `<!--` and tags are text, but
 * only in an HTML context; a bare tokenizer never switches. Content holding no `<` before its own
 * end tag tokenizes the same either way, so requiring that keeps this check exact wherever the
 * HTML is inserted. Every other text-mode element is forbidden outright.
 */
function closesAsText(html: string, tag: string, from: number): boolean {
  const next = html.indexOf("<", from)
  const after = next + 2 + tag.length
  return (
    next !== -1 &&
    html.slice(next, after).toLowerCase() === `</${tag}` &&
    /^[\t\n\f />]$/.test(html[after] ?? "")
  )
}

function assertOutputSize(html: string): void {
  // UTF-8 takes at most three bytes per UTF-16 unit, so only a long string is encoded to measure it.
  if (
    html.length * 3 > COMPONENT_LIMITS.outputBytes &&
    new TextEncoder().encode(html).length > COMPONENT_LIMITS.outputBytes
  )
    throw new ServerComponentError("component_limit", 413)
}

/** Tokenization validates attributes even in SVG/table contexts a document parser may discard. */
function tokenize(
  html: string,
  assets?: ReadonlySet<string>,
  hints?: Array<{ start: number; end: number }>,
): void {
  assertOutputSize(html)
  const tokenizer = new Tokenizer(
    // Offsets are read only for hints and for `title`/`textarea`, whose names a tokenizer lowercases
    // from ASCII alone; tracking them costs every other string about a tenth of its check.
    { sourceCodeLocationInfo: hints !== undefined || /<(?:title|textarea)/i.test(html) },
    {
      onStartTag(token) {
        validateComponentTag(token.tagName, token.attrs, assets)
        if (
          (token.tagName === "title" || token.tagName === "textarea") &&
          (token.location === null || !closesAsText(html, token.tagName, token.location.endOffset))
        )
          throw new ServerComponentError("component_protocol", 400)
        if (token.tagName === "link" && token.location !== null)
          hints?.push({ start: token.location.startOffset, end: token.location.endOffset })
      },
      onEndTag() {},
      onComment() {},
      onEof() {},
      onCharacter() {},
      onWhitespaceCharacter() {},
      onNullCharacter() {
        throw new ServerComponentError("component_protocol", 400)
      },
      onDoctype() {
        throw new ServerComponentError("component_protocol", 400)
      },
      onParseError(error) {
        // `<!>` (Solid's template markers, `<!$>` and `<!/>` too) is a comment to the tokenizer and to
        // every browser alike; any other parse error is refused.
        if (error.code !== "incorrectly-opened-comment")
          throw new ServerComponentError("component_protocol", 400)
      },
    },
  )
  tokenizer.write(html, true)
}

export function validateComponentHTML(html: string, assets?: ReadonlySet<string>): void {
  assertOutputSize(html)
  const tags = scanComponentHTML(html)
  if (tags === undefined) tokenize(html, assets)
  else for (const tag of tags) validateComponentTag(tag.tagName, tag.attrs, assets)
}

/** React may produce resource hints while decoding Flight. They are not owned range nodes. */
export function componentRangeHTML(html: string, assets: ReadonlySet<string>): string {
  const hints: Array<{ start: number; end: number }> = []
  tokenize(html, assets, hints)
  const parts: string[] = []
  let offset = 0
  for (const hint of hints) {
    parts.push(html.slice(offset, hint.start))
    offset = hint.end
  }
  parts.push(html.slice(offset))
  return parts.join("")
}
