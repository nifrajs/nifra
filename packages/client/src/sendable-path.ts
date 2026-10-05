/**
 * Whether a request path has a `.` or `..` segment.
 *
 * Such a path cannot be sent as written. URL parsing removes those segments before the request
 * leaves - the percent-encoded spellings (`%2e`, `%2E`) included - so the server would be asked for
 * a different path than the call names: `/users/../posts` arrives as `/posts`. No encoding survives
 * that step, so the client refuses the call instead of sending it somewhere else. A backslash counts
 * as a separator because an `http(s)` URL reads it as one.
 */
const DOT_SEGMENT = /(?:^|[/\\])(?:\.|%2e){1,2}(?:[/\\]|$)/i

export function hasDotSegment(path: string): boolean {
  return DOT_SEGMENT.test(path)
}
