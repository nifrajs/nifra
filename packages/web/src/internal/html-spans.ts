/** An HTML comment. A browser ends one at `-->`, and also at `--!>`. */
export const HTML_COMMENT = /<!--[\s\S]*?--!?>/g

/** `source` without the spans the global `pattern` matches, each handed to `onMatch` first. */
export function withoutMatches(
  source: string,
  pattern: RegExp,
  onMatch?: (match: RegExpMatchArray) => void,
): string {
  let kept = ""
  let from = 0
  for (const match of source.matchAll(pattern)) {
    onMatch?.(match)
    const start = match.index ?? 0
    kept += source.slice(from, start)
    from = start + match[0].length
  }
  return kept + source.slice(from)
}
