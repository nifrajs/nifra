import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { commentBlockHasMarker } from "./comment-markers.ts"
import type { CheckRule, RuleContext } from "./index.ts"

/**
 * Route-table lints over the statically collected route registrations (`scanStaticRouteText` in
 * ../check.ts fills `ctx.project.staticRoutes` during the source walk - no second scan here).
 *
 * NF-C018 exists because the typed client's proxy intercepts a fixed set of property names before
 * path resolution (`resolveSegment` + the thenable guard in @nifrajs/client): the seven HTTP verbs
 * (case-insensitively), `subscribe`, `ws`, `index`, and `then`. A route whose path contains a
 * static segment spelling one of these is UNREACHABLE through the typed client - `api.delete.post`
 * is a runtime TypeError while `tsc` and every other gate stay green. That silent contract hole is
 * the exact failure nifra promises cannot happen, so it is a blocking error at the route
 * definition (the client type rejects the call site with the same collision, see treaty.ts).
 */
const RESERVED_VERB_SEGMENTS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
])
// Intercepted by exact match only (`key === "subscribe"` etc.), unlike the lowercased verbs.
const RESERVED_EXACT_SEGMENTS: ReadonlySet<string> = new Set(["subscribe", "ws", "index", "then"])
const RESERVED_READOUT =
  "get/post/put/patch/delete/head/options (any casing), subscribe, ws, index, then"

/** Opt-out pragma for a route deliberately served only to NON-typed-client consumers. */
const RESERVED_SEGMENT_PRAGMA = "nifra-expect reserved-segment"

interface StaticRouteFact {
  readonly file: string
  readonly line: number
  readonly method: string
  readonly path: string
}

/** Parse-don't-cast over the project fact: a malformed entry is dropped, never trusted. */
function routeFacts(ctx: RuleContext): StaticRouteFact[] {
  const raw = ctx.project.staticRoutes
  if (!Array.isArray(raw)) return []
  const out: StaticRouteFact[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    if (
      typeof record.file === "string" &&
      typeof record.line === "number" &&
      typeof record.method === "string" &&
      typeof record.path === "string"
    ) {
      out.push({ file: record.file, line: record.line, method: record.method, path: record.path })
    }
  }
  return out
}

/** The reserved key a static path segment collides with, or undefined. Params/wildcards never collide. */
function reservedCollision(segment: string): string | undefined {
  if (segment.startsWith(":") || segment.startsWith("*")) return undefined
  if (RESERVED_EXACT_SEGMENTS.has(segment)) return segment
  const lower = segment.toLowerCase()
  return RESERVED_VERB_SEGMENTS.has(lower) ? lower : undefined
}

export const reservedSegmentRule: CheckRule = {
  code: "NF-C018",
  title: "Route segment collides with a reserved client proxy key",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    const linesByFile = new Map<string, readonly string[]>()
    for (const route of routeFacts(ctx)) {
      for (const segment of route.path.split("/")) {
        if (segment === "") continue
        const collision = reservedCollision(segment)
        if (collision === undefined) continue
        let lines = linesByFile.get(route.file)
        if (lines === undefined) {
          lines = (ctx.sources.read(route.file) ?? "").split("\n")
          linesByFile.set(route.file, lines)
        }
        if (commentBlockHasMarker(lines, route.line, RESERVED_SEGMENT_PRAGMA)) continue
        findings.push(
          diagnostic({
            code: "NF-C018",
            severity: "error",
            file: route.file,
            line: route.line,
            message: `${route.method} ${route.path} - segment '${segment}' collides with the reserved client proxy key '${collision}' (reserved: ${RESERVED_READOUT}); the route is unreachable through the typed client - rename the segment (e.g. '/${segment}' → '/${segment}-item' or a verb-free noun), or mark an intentionally non-typed-client route with \`// ${RESERVED_SEGMENT_PRAGMA}\` above the registration`,
            evidence: [`${route.method} ${route.path}`, `segment: ${segment}`],
            verify: "nifra check --lints-only",
          }),
        )
        break // one finding per route, even if several segments collide
      }
    }
    return findings
  },
}

/**
 * NF-C019: the same method+path registered twice in one file - the later registration is dead or
 * shadowing, and which one serves is a router implementation detail nobody should depend on.
 * Scoped to a single file on purpose: two different apps in one repo (a monorepo with several
 * backends) legitimately both register `GET /health`, and this scanner cannot tell app instances
 * apart across files - so cross-file duplicates are NOT flagged rather than guessed at.
 */
export const duplicateRouteRule: CheckRule = {
  code: "NF-C019",
  title: "Duplicate route registration",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    const byFile = new Map<string, Map<string, StaticRouteFact>>()
    for (const route of routeFacts(ctx)) {
      let seen = byFile.get(route.file)
      if (seen === undefined) {
        seen = new Map()
        byFile.set(route.file, seen)
      }
      const key = `${route.method} ${route.path}`
      const first = seen.get(key)
      if (first === undefined) {
        seen.set(key, route)
        continue
      }
      findings.push(
        diagnostic({
          code: "NF-C019",
          severity: "error",
          file: route.file,
          line: route.line,
          message: `${key} is registered twice in this file (first at line ${first.line}) - remove or rename one; which registration serves is undefined`,
          evidence: [key, `first registration: line ${first.line}`],
          verify: "nifra check --lints-only",
        }),
      )
    }
    return findings
  },
}

export const routeRules = Object.freeze([reservedSegmentRule, duplicateRouteRule])
