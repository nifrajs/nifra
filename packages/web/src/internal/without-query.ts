/** A module id or specifier up to its first `?` or `#`. An index scan, since `/[?#].*$/` retries
 * from every `#` and runs in quadratic time on a long run of them before a line break. */
export function withoutQuery(value: string): string {
  const query = value.indexOf("?")
  const hash = value.indexOf("#")
  const cut = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash)
  return cut === -1 ? value : value.slice(0, cut)
}
