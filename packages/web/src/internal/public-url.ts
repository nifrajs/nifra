import { sep } from "node:path"

/**
 * Percent-encode one path segment exactly the way a browser encodes it into a request URL.
 *
 * NOT `encodeURIComponent`. That escapes the sub-delimiters `, @ + = & ; $`, which a browser sends raw -
 * so a file named `report,2026.csv` would be recorded as `/report%2C2026.csv` while the request arrives
 * as `/report,2026.csv`, the allowlist lookup misses, and the file 404s in production only. `encodeURI`
 * agrees with `URL.pathname` on every character except `?` and `#`, which terminate a path and so must
 * be escaped explicitly here.
 */
function encodePathSegment(segment: string): string {
  return encodeURI(segment).replace(
    /[?#]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** The URL path a browser requests for a file at `rel` (OS separators) under the public directory. */
export function publicUrlPath(rel: string): string {
  return `/${rel.split(sep).map(encodePathSegment).join("/")}`
}

/**
 * Whether a path under the public directory crosses a dot-segment other than `.well-known`. Serving,
 * the build copy and the parity listing all apply it, so an editor or VCS artifact left in `public/`
 * (`.env`, `.git/`, `.DS_Store`) is neither served in development nor shipped by a build. Both
 * separators split: a request path uses `/`, a relative file path the OS separator.
 */
export function isHiddenPublicPath(rel: string): boolean {
  for (const segment of rel.split(/[\\/]/)) {
    if (segment.startsWith(".") && segment !== ".well-known") return true
  }
  return false
}
