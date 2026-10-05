// The comment and delimiter readers scan instead of matching one lazy RegExp: a pattern like
// `<!--[\s\S]*?-->` reads to the end of the source again from every opener that never closes.

/**
 * `source` without its HTML comments. A browser ends one at `-->`, and also at `--!>`; an opener
 * with no end after it is kept as text.
 */
export function withoutComments(source: string): string {
  const end = /--!?>/g
  let kept = ""
  let from = 0
  for (let start = source.indexOf("<!--"); start !== -1; start = source.indexOf("<!--", from)) {
    end.lastIndex = start + 4
    const close = end.exec(source)
    // No later opener has an end after it either.
    if (close === null) break
    kept += source.slice(from, start)
    from = close.index + close[0].length
  }
  return kept + source.slice(from)
}

/** The text between each `open` and the first `close` after it, read on from that `close`. */
export function delimitedSpans(source: string, open: string, close: string): string[] {
  const spans: string[] = []
  for (let start = source.indexOf(open); start !== -1; ) {
    const end = source.indexOf(close, start + open.length)
    if (end === -1) break
    spans.push(source.slice(start + open.length, end))
    start = source.indexOf(open, end + close.length)
  }
  return spans
}

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
