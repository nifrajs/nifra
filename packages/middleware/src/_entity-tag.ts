/**
 * Whether an `If-None-Match` value names `tag` or is `*`, by weak comparison (RFC 9110 section
 * 13.1.2). A comma inside a quoted entity-tag is part of the tag, so the list splits only outside
 * quotes; an unquoted member runs to the next comma.
 */
export function ifNoneMatchIncludes(value: string, tag: string): boolean {
  const wanted = tag.startsWith("W/") ? tag.slice(2) : tag
  let at = 0
  while (at < value.length) {
    const char = value[at]
    if (char === "," || char === " " || char === "\t") {
      at++
      continue
    }
    const start = value.startsWith("W/", at) ? at + 2 : at
    let end: number
    if (value[start] === '"') {
      const close = value.indexOf('"', start + 1)
      end = close === -1 ? value.length : close + 1
    } else {
      const comma = value.indexOf(",", start)
      end = comma === -1 ? value.length : comma
    }
    const member = value.slice(start, end).trim()
    if (member === wanted || (member === "*" && start === at)) return true
    at = end
  }
  return false
}
