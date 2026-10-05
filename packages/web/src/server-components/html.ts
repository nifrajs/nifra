import { Tokenizer } from "parse5"
import { ServerComponentError } from "./error.ts"
import { validateComponentTag } from "./html-policy.ts"
import { COMPONENT_LIMITS } from "./protocol.ts"

/** Tokenization validates attributes even in SVG/table contexts a document parser may discard. */
function tokenize(
  html: string,
  assets?: ReadonlySet<string>,
  hints?: Array<{ start: number; end: number }>,
): void {
  if (new TextEncoder().encode(html).length > COMPONENT_LIMITS.outputBytes)
    throw new ServerComponentError("component_limit", 413)
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: hints !== undefined },
    {
      onStartTag(token) {
        validateComponentTag(token.tagName, token.attrs, assets)
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
      onParseError() {
        throw new ServerComponentError("component_protocol", 400)
      },
    },
  )
  tokenizer.write(html, true)
}

export function validateComponentHTML(html: string, assets?: ReadonlySet<string>): void {
  tokenize(html, assets)
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
