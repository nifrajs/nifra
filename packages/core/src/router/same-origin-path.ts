/**
 * Is `value` a destination that stays on this origin?
 *
 * True only for an absolute path: one leading `/`, never `//` (protocol-relative → another origin),
 * and free of any character a URL parser turns into an origin escape. A leading `/` alone is not
 * enough: under a special scheme `\` parses as `/`, and tab/CR/LF are STRIPPED before parsing, so
 * `/\evil.example` and `/<TAB>/evil.example` both resolve to the external host `evil.example` while
 * passing a `//` test. Rejecting CR/LF here also keeps a validated destination out of the
 * response-splitting sink it usually flows into.
 *
 * One implementation, because every caller is the same open-redirect gate: `redirect()` and
 * `rawHref()` in `@nifrajs/web`, the `redirectTo` of the `@nifrajs/auth` and `@nifrajs/better-auth` guards. Three
 * copies of a security predicate is three chances for one of them to be hardened alone.
 *
 * It answers about a PATH, not a URL: an absolute `https://this.host/x` is false even for the
 * current origin, because the whole point is that the value never got to name a host.
 *
 * It sits in a leaf with no imports, so browser code (`rawHref` in `@nifrajs/web`) can use it without
 * the server entry; `@nifrajs/core/server` and `@nifrajs/core/pattern` both export it.
 */
export function isSameOriginPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false
  // Scanned by character code rather than matched by regex: no control characters have to be written
  // into a pattern, and the check is a single pass over a short string.
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x5c /* \ */ || code <= 0x1f || code === 0x7f) return false
  }
  // `/.//host` and `/a/..//host` (or their `%2e` forms) resolve to the path `//host`, which any
  // relative reference later built from that path - a client router's redirect - reads as a host.
  // A path-absolute reference against a valid base always parses, so this cannot throw.
  return (
    !(value.includes(".") || value.includes("%")) ||
    !new URL(value, "http://n.invalid").pathname.startsWith("//")
  )
}
