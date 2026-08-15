import { RESERVED_KEY_READOUT, reservedKeyFor } from "@nifrajs/client"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { commentBlockHasMarker } from "./comment-markers.ts"
import type { CheckRule, RuleContext } from "./index.ts"

/**
 * Route-table lints over the statically collected route registrations (`ProjectFacts.routes` is built
 * once before the registry runs - no rule re-walks source).
 *
 * NF-C018 exists because the typed client's proxy intercepts a fixed set of property names before
 * path resolution (`resolveSegment` + the thenable guard in @nifrajs/client). A route whose path
 * contains a static segment spelling one of these cannot be reached by DOT ACCESS -
 * `api.delete.post` resolves the DELETE verb, not the path. The typed spelling is a call on the
 * parent node (`api.api("delete").post()`, treaty.ts `SegmentCall`), and the client type rejects
 * the dot access with the same guidance - so the collision is a warning that teaches the call
 * spelling, not a blocking error: the route IS reachable, just not by the spelling its name
 * suggests.
 *
 * The set itself is NOT copied here. It comes from `@nifrajs/client`'s `reserved.ts`, which is the
 * one place it is written down and the one place the freeze policy lives - a lint that carried its
 * own copy is a lint that can disagree with the compiler it is explaining.
 */

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
  const raw: readonly unknown[] = ctx.project.routes
  const out: StaticRouteFact[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const record = Object.fromEntries(Object.entries(item))
    if (
      typeof record.file !== "string" ||
      typeof record.line !== "number" ||
      typeof record.method !== "string" ||
      typeof record.path !== "string"
    )
      continue
    out.push({ file: record.file, line: record.line, method: record.method, path: record.path })
  }
  return out
}

/**
 * The typed escape spelling for a colliding segment, e.g. `/api/delete` + `delete` →
 * `api("delete").post()` shown as the chain up to the collision. Best-effort readability: earlier
 * segments render as dot access, the colliding one as the parent-node call.
 */
function routeEscapeHint(path: string, colliding: string): string {
  const segments = path.split("/").filter((segment) => segment !== "")
  const before = segments.slice(0, Math.max(segments.indexOf(colliding), 0))
  return `${["api", ...before].join(".")}("${colliding}")`
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
        const collision = reservedKeyFor(segment)
        if (collision === undefined) continue
        let lines = linesByFile.get(route.file)
        if (lines === undefined) {
          lines = (ctx.project.source.read(route.file) ?? "").split("\n")
          linesByFile.set(route.file, lines)
        }
        if (commentBlockHasMarker(lines, route.line, RESERVED_SEGMENT_PRAGMA)) continue
        findings.push(
          diagnostic({
            code: "NF-C018",
            severity: "warn",
            file: route.file,
            line: route.line,
            message: `${route.method} ${route.path} - segment '${segment}' collides with the reserved client proxy key '${collision}' (reserved: ${RESERVED_KEY_READOUT}); dot access cannot reach it - call the parent node with the segment instead (\`${routeEscapeHint(route.path, segment)}\`), rename the segment, or mark an intentionally non-typed-client route with \`// ${RESERVED_SEGMENT_PRAGMA}\` above the registration. \`nifra fix --code NF-C018\` rewrites the broken call sites for you`,
            evidence: [`${route.method} ${route.path}`, `segment: ${segment}`],
            // The route is fine; what needs editing is every typed-client call site the collision
            // broke, which the recipe finds from the compiler rather than from this one finding.
            fix: { recipe: "client.reserved-segment", command: "nifra fix --code NF-C018" },
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
