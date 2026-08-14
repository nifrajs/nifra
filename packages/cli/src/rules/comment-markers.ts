/**
 * Marker recognition for in-source escape hatches (`@nifra-gate-reviewed`, `nifra-expect …`).
 *
 * A marker counts when it appears on the flagged line itself (trailing comment) or ANYWHERE in the
 * contiguous comment block directly above it - which is where a human naturally writes the
 * multi-line justification the hatch asks for. A blank line or a code line ends the block, so a
 * marker in an unrelated comment further up never leaks onto a finding below it.
 */

// Lines that continue a comment block when walking upward: line comments, block-comment
// open/body/close lines, and the JSX comment form.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/|\*|\{\/\*)/

export function commentBlockHasMarker(
  lines: readonly string[],
  line: number,
  marker: string,
): boolean {
  if ((lines[line - 1] ?? "").includes(marker)) return true
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i] ?? ""
    if (!COMMENT_LINE.test(text)) return false
    if (text.includes(marker)) return true
  }
  return false
}

/**
 * The justification a reason-carrying marker (`<marker>: <reason>`) supplies, or `undefined` when the
 * marker is absent or written with no reason after its colon. Searches the same trailing-comment /
 * comment-block-above region as {@link commentBlockHasMarker}, so a hatch that demands a written reason
 * can require this to be non-empty before it silences anything - an empty `<marker>:` never suppresses,
 * which is how "reason mandatory" is enforced without a second diagnostic.
 */
export function commentBlockMarkerReason(
  lines: readonly string[],
  line: number,
  marker: string,
): string | undefined {
  const reasonOn = (text: string): string | undefined => {
    const at = text.indexOf(marker)
    if (at < 0) return undefined
    const rest = text.slice(at + marker.length)
    const colon = rest.indexOf(":")
    if (colon < 0) return undefined
    // A block comment's `*/` closer is not part of the reason.
    const reason = rest
      .slice(colon + 1)
      .replace(/\*\/\s*$/, "")
      .trim()
    return reason.length > 0 ? reason : undefined
  }
  const onLine = reasonOn(lines[line - 1] ?? "")
  if (onLine !== undefined) return onLine
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i] ?? ""
    if (!COMMENT_LINE.test(text)) return undefined
    const reason = reasonOn(text)
    if (reason !== undefined) return reason
  }
  return undefined
}
