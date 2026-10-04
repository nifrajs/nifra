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
