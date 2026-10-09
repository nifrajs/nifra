/**
 * Marker recognition for in-source escape hatches (`nifra-expect <code>: <reason>`).
 *
 * A marker counts when it appears on the flagged line itself (trailing comment) or ANYWHERE in the
 * contiguous comment block directly above it - which is where a human naturally writes the
 * multi-line justification the hatch asks for. A blank line or a code line ends the block, so a
 * marker in an unrelated comment further up never leaks onto a finding below it.
 */

// Lines that continue a comment block when walking upward: line comments, block-comment
// open/body/close lines, and the JSX comment form.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/|\*|\{\/\*)/

/** The trailing comment on a code line: from its first `//` or `/*` outside a string literal to the
 * end, else `""`. A marker in a string the code passes is data, not a comment. */
function trailingComment(text: string): string {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote !== undefined) {
      if (char === "\\") i++
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) return text.slice(i)
  }
  return ""
}

export function commentBlockHasMarker(
  lines: readonly string[],
  line: number,
  marker: string,
): boolean {
  if (trailingComment(lines[line - 1] ?? "").includes(marker)) return true
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i] ?? ""
    if (!COMMENT_LINE.test(text)) return false
    if (text.includes(marker)) return true
  }
  return false
}

/**
 * The 1-based line a marker comment on `line` applies to: `line` itself when code precedes the comment
 * there, else the first line after its comment block, or `undefined` when a blank line ends the block.
 */
export function markerTarget(lines: readonly string[], line: number): number | undefined {
  if (!COMMENT_LINE.test(lines[line - 1] ?? "")) return line
  for (let i = line; i < lines.length; i++) {
    const text = lines[i] ?? ""
    if (COMMENT_LINE.test(text)) continue
    return text.trim() === "" ? undefined : i + 1
  }
  return undefined
}

/** What a finding adds when a `nifra-expect` comment names it but leaves out the reason it needs. */
export const MISSING_EXPECTATION_REASON =
  "the nifra-expect comment here gives no reason after its colon, so it does not silence this"

/**
 * A `nifra-expect <name>: <reason>` comment for the finding on `line`, where `<name>` is one of
 * `names`: the finding's NF code, or a slug it also answers to. It counts in the same trailing-comment /
 * comment-block-above region as {@link commentBlockHasMarker}. `undefined` when no such comment is
 * there; `reason` is `undefined` when none follows the name's colon. A hatch that silences an error
 * requires the reason, so an empty `nifra-expect NF-C006:` never suppresses one.
 */
export function commentBlockExpectation(
  lines: readonly string[],
  line: number,
  names: readonly string[],
): { readonly reason: string | undefined } | undefined {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = new RegExp(`nifra-expect\\s+(?:${escaped.join("|")})(?![\\w-])(.*)`)
  let found = false
  const reasonOn = (text: string): string | undefined => {
    const match = pattern.exec(text)
    if (match === null) return undefined
    found = true
    const rest = (match[1] ?? "").trimStart()
    if (!rest.startsWith(":")) return undefined
    // A block comment's `*/` closer is not part of the reason.
    const reason = rest
      .slice(1)
      .replace(/\*\/\s*$/, "")
      .trim()
    return reason.length > 0 ? reason : undefined
  }
  const onLine = reasonOn(trailingComment(lines[line - 1] ?? ""))
  if (onLine !== undefined) return { reason: onLine }
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i] ?? ""
    if (!COMMENT_LINE.test(text)) break
    const reason = reasonOn(text)
    if (reason !== undefined) return { reason }
  }
  return found ? { reason: undefined } : undefined
}
