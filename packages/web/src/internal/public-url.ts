import { sep } from "node:path"
import { browserPathSegment, encodePathSegment } from "@nifrajs/core/pattern"

/**
 * The request paths a file at `rel` (OS separators) under the public directory is served at.
 *
 * The static mount compares the raw request path to this list, and a page may link the file in either
 * spelling: the canonical one, or the one a browser sends for a name holding `; [ ] |`. A name without
 * those characters has one path; otherwise both are listed, once, at build time.
 */
export function publicUrlPaths(rel: string): string[] {
  const names = rel.split(sep)
  const canonical = `/${names.map(encodePathSegment).join("/")}`
  const browser = `/${names.map(browserPathSegment).join("/")}`
  return canonical === browser ? [canonical] : [canonical, browser]
}
