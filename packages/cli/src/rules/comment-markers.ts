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
