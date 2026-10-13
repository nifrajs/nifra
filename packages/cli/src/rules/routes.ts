import { RESERVED_KEY_READOUT, reservedKeyFor } from "@nifrajs/client"
import { RoutePatternOverlapLimitError, routePatternOverlap } from "@nifrajs/core"
import { expandOptionalParams, paramConstraint } from "@nifrajs/core/pattern"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { commentBlockExpectation, MISSING_EXPECTATION_REASON } from "./comment-markers.ts"
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

/** What marks a route deliberately served only to NON-typed-client consumers. */
const RESERVED_SEGMENT_EXPECTATION = ["NF-C018", "reserved-segment"]
// An intended overlap answers both findings about the pair: proven (NF-C024) or unprovable (NF-C025).
const ROUTE_OVERLAP_EXPECTATION = ["NF-C024", "NF-C025", "route-overlap"]
const PARAM_MODIFIER_EXPECTATION = ["NF-C026", "param-modifier"]
// A deliberately computed path is accepted with or without a reason: the finding is information.
const DYNAMIC_PATH_EXPECTATION = ["NF-C036"]

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

/** One fact per registration site, so `all()` or `method([...])` reports its path once, not per method. */
function pathSites(routes: readonly StaticRouteFact[]): StaticRouteFact[] {
  const seen = new Set<string>()
  return routes.filter((route) => {
    const site = `${route.file}\n${route.line}\n${route.path}`
    if (seen.has(site)) return false
    seen.add(site)
    return true
  })
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
    for (const route of pathSites(routeFacts(ctx))) {
      for (const segment of route.path.split("/")) {
        if (segment === "") continue
        const collision = reservedKeyFor(segment)
        if (collision === undefined) continue
        let lines = linesByFile.get(route.file)
        if (lines === undefined) {
          lines = (ctx.project.source.read(route.file) ?? "").split("\n")
          linesByFile.set(route.file, lines)
        }
        if (commentBlockExpectation(lines, route.line, RESERVED_SEGMENT_EXPECTATION) !== undefined)
          continue
        findings.push(
          diagnostic({
            code: "NF-C018",
            severity: "warn",
            file: route.file,
            line: route.line,
            message: `${route.method} ${route.path} - segment '${segment}' collides with the reserved client proxy key '${collision}' (reserved: ${RESERVED_KEY_READOUT}); dot access cannot reach it - call the parent node with the segment instead (\`${routeEscapeHint(route.path, segment)}\`), rename the segment, or mark an intentionally non-typed-client route with \`// nifra-expect NF-C018: <reason>\` above the registration. \`nifra fix --code NF-C018\` rewrites the broken call sites for you`,
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
    // Two calls that each register several methods collide once per shared method; that is one
    // pair of lines to fix, so it is reported once.
    const reported = new Set<string>()
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
      const pair = `${route.file}\n${route.line}\n${first.line}\n${route.path}`
      if (reported.has(pair)) continue
      reported.add(pair)
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

/** A segment the router reads as exactly its own text. */
const PLAIN_SEGMENT = /^[A-Za-z0-9_.~-]+$/

/** Routes keyed by their leading plain segments: two routes can overlap only if one's lead prefixes the other's. */
interface LeadNode {
  readonly routes: number[]
  readonly children: Map<string, LeadNode>
}

function leadOf(path: string): readonly string[] {
  const lead: string[] = []
  for (const segment of path.split("/").slice(1)) {
    if (!PLAIN_SEGMENT.test(segment)) break
    lead.push(segment)
  }
  return lead
}

/** The routes in `root` whose lead is compatible with `lead`, in registration order. */
function routesSharingLead(root: LeadNode, lead: readonly string[]): number[] {
  const found: number[] = []
  let node: LeadNode | undefined = root
  for (const segment of lead) {
    for (const route of node.routes) found.push(route)
    node = node.children.get(segment)
    if (node === undefined) return found.sort((a, b) => a - b)
  }
  const below = [node]
  for (const next of below) {
    for (const route of next.routes) found.push(route)
    for (const child of next.children.values()) below.push(child)
  }
  return found.sort((a, b) => a - b)
}

function addLead(root: LeadNode, lead: readonly string[], route: number): void {
  let node = root
  for (const segment of lead) {
    let child = node.children.get(segment)
    if (child === undefined) {
      child = { routes: [], children: new Map() }
      node.children.set(segment, child)
    }
    node = child
  }
  node.routes.push(route)
}

/**
 * NF-C024: two different same-method route patterns in one source file accept at least one of the
 * same paths. This is deliberately file-scoped, like NF-C019: the static scanner cannot prove
 * which application instance owns routes collected from different files in a monorepo.
 */
export const overlappingRouteRule: CheckRule = {
  code: "NF-C024",
  title: "Overlapping route registration",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    const linesByFile = new Map<string, readonly string[]>()
    const byFile = new Map<string, StaticRouteFact[]>()
    for (const route of routeFacts(ctx)) {
      const routes = byFile.get(route.file)
      if (routes === undefined) byFile.set(route.file, [route])
      else routes.push(route)
    }

    // As in NF-C019: two multi-method calls overlap once per shared method, reported once.
    const reported = new Set<string>()
    for (const [file, routes] of byFile) {
      const lines = (): readonly string[] => {
        let value = linesByFile.get(file)
        if (value === undefined) {
          value = (ctx.project.source.read(file) ?? "").split("\n")
          linesByFile.set(file, value)
        }
        return value
      }

      const expectationByLine = new Map<number, ReturnType<typeof commentBlockExpectation>>()
      const expectationAt = (line: number): ReturnType<typeof commentBlockExpectation> => {
        if (!expectationByLine.has(line))
          expectationByLine.set(
            line,
            commentBlockExpectation(lines(), line, ROUTE_OVERLAP_EXPECTATION),
          )
        return expectationByLine.get(line)
      }
      const leads = new Map<string, LeadNode>()
      for (let laterIndex = 0; laterIndex < routes.length; laterIndex += 1) {
        const later = routes[laterIndex]!
        const laterKey = `${later.method} ${later.path}`
        const lead = leadOf(later.path)
        let methodLeads = leads.get(later.method)
        if (methodLeads === undefined) {
          methodLeads = { routes: [], children: new Map() }
          leads.set(later.method, methodLeads)
        }
        const candidates = routesSharingLead(methodLeads, lead)
        addLead(methodLeads, lead, laterIndex)
        for (const earlierIndex of candidates) {
          const earlier = routes[earlierIndex]!
          if (`${earlier.method} ${earlier.path}` === laterKey) continue
          // Both are errors, so the comment silences only with a reason.
          const expectations = [later.line, earlier.line].map(expectationAt)
          if (expectations.some((expected) => expected?.reason !== undefined)) continue
          const unreasoned = expectations.some((expected) => expected !== undefined)

          let witness: string | undefined
          try {
            witness = routePatternOverlap(earlier.path, later.path)
          } catch (error) {
            if (error instanceof RoutePatternOverlapLimitError) {
              findings.push(
                diagnostic({
                  code: "NF-C025",
                  severity: "error",
                  file: later.file,
                  line: later.line,
                  message: `${laterKey} could not be proven disjoint from ${earlier.method} ${earlier.path}; bounded route-overlap analysis exceeded its safety budget - simplify the patterns or add a \`// nifra-expect NF-C025: <reason>\` comment only after manual review${unreasoned ? `; ${MISSING_EXPECTATION_REASON}` : ""}`,
                  evidence: [
                    `${earlier.method} ${earlier.path}`,
                    `${later.method} ${later.path}`,
                    `first registration: line ${earlier.line}`,
                  ],
                  verify: "nifra check --lints-only",
                }),
              )
            }
            // The primary route parser diagnostic owns malformed route patterns. A secondary lint
            // must remain total and never turn an invalid route into a checker crash.
            continue
          }
          if (witness === undefined) continue
          const pair = `${file}\n${later.line}\n${later.path}\n${earlier.line}\n${earlier.path}`
          if (reported.has(pair)) break
          reported.add(pair)

          findings.push(
            diagnostic({
              code: "NF-C024",
              severity: "error",
              file: later.file,
              line: later.line,
              message: `${laterKey} overlaps ${earlier.method} ${earlier.path} (first at line ${earlier.line}); witness path: ${witness} - make the patterns disjoint, or add a \`// nifra-expect NF-C024: <reason>\` comment above either registration${unreasoned ? `; ${MISSING_EXPECTATION_REASON}` : ""}`,
              evidence: [
                `${earlier.method} ${earlier.path}`,
                `${later.method} ${later.path}`,
                `witness: ${witness}`,
                `first registration: line ${earlier.line}`,
              ],
              verify: "nifra check --lints-only",
            }),
          )
          break
        }
      }
    }
    return findings
  },
}

/** A param name directly followed by a character other routers read as a modifier. */
const PARAM_MODIFIER = /:[A-Za-z_][A-Za-z0-9_]*[?*+{(<]/g

/**
 * The first param in `path` whose modifier the router reads as literal text. A `{...}` group the
 * router reads as a constraint (`:id{[0-9]+}`, `:ext{png|jpg}`) is syntax, so it is passed over.
 */
function literalModifier(path: string): string | undefined {
  PARAM_MODIFIER.lastIndex = 0
  for (let found = PARAM_MODIFIER.exec(path); found !== null; found = PARAM_MODIFIER.exec(path)) {
    const text = found[0]
    if (!text.endsWith("{")) return text
    const constraint = paramConstraint(path.slice(PARAM_MODIFIER.lastIndex - 1))
    if (constraint === undefined) return text
    const end = PARAM_MODIFIER.lastIndex + constraint.source.length + 1
    // A modifier after the constraint is literal text like any other (`:id{[0-9]+}?/posts`).
    if ("?*+{(<".includes(path[end] ?? "/")) return path.slice(found.index, end + 1)
    PARAM_MODIFIER.lastIndex = end
  }
  return undefined
}

/**
 * NF-C026: a param followed by `?`, `*`, `+`, `{`, `(` or `<` that the router reads as literal text
 * (`/users/:id?/posts`, `/users/:id{int}`). Only a trailing `?` run and a valid `{...}` are syntax.
 */
export const paramModifierRule: CheckRule = {
  code: "NF-C026",
  title: "Route param followed by an unsupported modifier",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    const linesByFile = new Map<string, readonly string[]>()
    for (const route of pathSites(routeFacts(ctx))) {
      const forms = expandOptionalParams(route.path)
      const text = literalModifier(forms[forms.length - 1] ?? route.path)
      if (text === undefined) continue
      let lines = linesByFile.get(route.file)
      if (lines === undefined) {
        lines = (ctx.project.source.read(route.file) ?? "").split("\n")
        linesByFile.set(route.file, lines)
      }
      if (commentBlockExpectation(lines, route.line, PARAM_MODIFIER_EXPECTATION) !== undefined)
        continue
      const character = text[text.length - 1]!
      findings.push(
        diagnostic({
          code: "NF-C026",
          severity: "warn",
          file: route.file,
          line: route.line,
          message: `${route.method} ${route.path} - '${character}' after '${text.slice(0, -1)}' is matched as literal text, not as a param modifier${character === "?" ? "; a request path never contains '?', so this route cannot be reached" : ""}. Optional params are supported as the trailing whole segments of a path (\`/users/:id?\`, \`/d/:year?/:month?\`), and a constraint as one character class with an optional count (\`:id{[0-9]+}\`, \`:code{[A-Z]{2}}\`) or a list of two or more values (\`:ext{png|jpg}\`); for anything else register each path, or mark a deliberate literal with \`// nifra-expect NF-C026: <reason>\` above the registration`,
          evidence: [`${route.method} ${route.path}`, `literal: ${text}`],
          verify: "nifra check --lints-only",
        }),
      )
    }
    return findings
  },
}

/**
 * NF-C036: a registration whose path the static scan cannot read. The route still serves; what it
 * loses is every source-level analysis keyed by path - the route lints above, and the scan's half of
 * capability provenance (the other half is the registering module recorded when the app loads) - so
 * it is reported as information, naming the expression.
 */
export const unresolvedRoutePathRule: CheckRule = {
  code: "NF-C036",
  title: "Route path the static scan cannot read",
  async scan(ctx) {
    const findings: Diagnostic[] = []
    const linesByFile = new Map<string, readonly string[]>()
    for (const route of ctx.project.sourceFindings.routePaths) {
      let lines = linesByFile.get(route.file)
      if (lines === undefined) {
        lines = (ctx.project.source.read(route.file) ?? "").split("\n")
        linesByFile.set(route.file, lines)
      }
      if (commentBlockExpectation(lines, route.line, DYNAMIC_PATH_EXPECTATION) !== undefined)
        continue
      findings.push(
        diagnostic({
          code: "NF-C036",
          severity: "info",
          file: route.file,
          line: route.line,
          message: `${route.method} ${route.expression} - the static scan cannot read this route path, so the route lints do not see the route, and capability provenance finds its module only from the app \`nifra.assurance.ts\` loads. Write the path as a string literal, or as a module-level \`const\` (optionally \`as const\`) in this file or exported from a project file it imports; mark a deliberately computed path with a \`// nifra-expect NF-C036: <reason>\` comment above the registration`,
          evidence: [`${route.method} ${route.expression}`],
          verify: "nifra check --lints-only",
        }),
      )
    }
    return findings
  },
}

export const routeRules = Object.freeze([
  reservedSegmentRule,
  duplicateRouteRule,
  overlappingRouteRule,
  paramModifierRule,
  unresolvedRoutePathRule,
])
