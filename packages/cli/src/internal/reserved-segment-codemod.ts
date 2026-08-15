/**
 * Codemod for reserved-segment collisions in typed-client call sites.
 *
 * A route segment spelling a reserved proxy key (`get`…`options`, `subscribe`, `ws`, `index`, `then`)
 * cannot be reached by property access - the proxy resolves the reserved behavior first - so the client
 * type resolves that child to `ReservedSegmentCollision<"seg">` and every `api.foo.delete.post()` in the
 * project stops compiling at once. The fix is mechanical and identical at every site: call the parent
 * node with the segment instead, `api.foo("delete").post()`. Doing that by hand across a codebase is
 * pure toil, and it is toil the framework caused.
 *
 * The compiler is the site index. `tsc` already reports every broken access, and its message names the
 * segment (`Property 'post' does not exist on type 'ReservedSegmentCollision<"delete">'`), so the
 * rewrite needs no type graph of its own and cannot invent a site the compiler did not reject. That
 * also disambiguates the one case a textual search could not: `.delete` as a real DELETE verb call is
 * valid and never appears in this list.
 *
 * A site the scan cannot rewrite CONFIDENTLY is left alone and reported, never guessed at. Bracket
 * access, a collision node stored in a variable and used elsewhere, and any shape where the text before
 * the failing property is not `.<segment>` all fall into that bucket.
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

/** `path/to/file.ts(12,16): error TS2339: … 'ReservedSegmentCollision<"delete">'.` */
const TSC_POSITION = /^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s+TS\d+:\s*(.+)$/
const COLLISION_TYPE = /ReservedSegmentCollision<"([^"]+)">/

export interface CollisionSite {
  readonly file: string
  /** 1-based, as `tsc` reports them. */
  readonly line: number
  readonly column: number
  /** The colliding path segment, read out of the type the compiler named. */
  readonly segment: string
}

/** Every reserved-segment collision `tsc` reported, in the order it reported them. */
export function parseCollisionSites(tscOutput: string): readonly CollisionSite[] {
  const sites: CollisionSite[] = []
  for (const raw of tscOutput.split("\n")) {
    const position = TSC_POSITION.exec(raw.trim())
    if (position === null) continue
    const segment = COLLISION_TYPE.exec(position[4] as string)
    if (segment === null) continue
    sites.push({
      file: position[1] as string,
      line: Number(position[2]),
      column: Number(position[3]),
      segment: segment[1] as string,
    })
  }
  return sites
}

/** Byte offset of a 1-based (line, column) in `source`, or undefined when it is past the end. */
const offsetOf = (source: string, line: number, column: number): number | undefined => {
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf("\n", offset)
    if (next === -1) return undefined
    offset = next + 1
  }
  const target = offset + column - 1
  return target <= source.length ? target : undefined
}

const skipSpaceBack = (source: string, from: number): number => {
  let index = from
  while (index >= 0 && /\s/.test(source[index] as string)) index -= 1
  return index
}

/**
 * The span to replace for one site: the `.segment` immediately preceding the failing property access,
 * which becomes `("segment")`. Undefined when the text does not have that shape - the caller reports
 * those rather than rewriting something it did not recognise.
 *
 * The scan runs backwards over the whole source rather than one line, so a chain broken across lines
 * (`api.foo\n  .delete\n  .post()`) rewrites the same as a chain on one line.
 */
export function collisionSpan(
  source: string,
  site: CollisionSite,
): { readonly start: number; readonly end: number } | undefined {
  const offset = offsetOf(source, site.line, site.column)
  if (offset === undefined) return undefined

  // Back over the dot that introduces the FAILING property (`.post` in `…delete.post`).
  let index = skipSpaceBack(source, offset - 1)
  if (source[index] !== ".") return undefined

  // Back over the colliding segment itself.
  index = skipSpaceBack(source, index - 1)
  const segmentEnd = index
  const segmentStart = segmentEnd - site.segment.length + 1
  if (segmentStart < 0) return undefined
  if (source.slice(segmentStart, segmentEnd + 1) !== site.segment) return undefined

  // Back over the dot that introduces the segment. Anything else (bracket access, a bare identifier
  // holding the node) is a shape this rewrite does not understand.
  const dot = skipSpaceBack(source, segmentStart - 1)
  if (source[dot] !== ".") return undefined

  // Take any whitespace before that dot into the span too, so a chain broken across lines closes up
  // (`api.jobs\n  .subscribe` becomes `api.jobs("subscribe")`) instead of leaving the call argument
  // dangling on its own line.
  return { start: skipSpaceBack(source, dot - 1) + 1, end: segmentEnd }
}

export interface FileRewrite {
  readonly source: string
  /** Sites in this file the scan declined to rewrite, so the caller can report them. */
  readonly skipped: readonly CollisionSite[]
}

/**
 * Apply every site belonging to one file. Spans are applied back to front so an earlier rewrite never
 * shifts the offsets of one not yet applied, and a duplicate span (two failing properties resolving
 * through the same access) is applied once.
 */
export function rewriteFile(source: string, sites: readonly CollisionSite[]): FileRewrite {
  const skipped: CollisionSite[] = []
  const spans: { start: number; end: number; segment: string }[] = []
  for (const site of sites) {
    const span = collisionSpan(source, site)
    if (span === undefined) {
      skipped.push(site)
      continue
    }
    if (spans.some((other) => other.start === span.start && other.end === span.end)) continue
    spans.push({ ...span, segment: site.segment })
  }
  let out = source
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, span.start)}("${span.segment}")${out.slice(span.end + 1)}`
  }
  return { source: out, skipped }
}

/** The project's own `tsc` binary, found upward from `root`. Never installs one. */
export function resolveTscBin(root: string): string | undefined {
  let dir = root
  while (true) {
    const candidate = join(dir, "node_modules", "typescript", "bin", "tsc")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
