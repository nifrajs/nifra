import { METHODS, type Method } from "../router/router.ts"

/** Where enforcement evidence follows Nifra's route-registration semantics. */
export type AssuranceScope = "global" | "subsequent" | "plugin"

/** Reflection-safe proof that a named enforcement module covered a route. */
export interface AssuranceEvidence {
  readonly id: string
  readonly source: string
  /** Runtime-installed enforcement versus an author assertion on a route. Optional for legacy
   * reflected descriptors; evaluators infer legacy values from source when absent. */
  readonly provenance?: "runtime" | "declared"
}

/** Metadata installed on a middleware/plugin by {@link withRouteAssurance}. */
export interface AssuranceDeclaration extends AssuranceEvidence {
  readonly scope: AssuranceScope
  /** Restrict evidence to these HTTP methods. Omit for every method. */
  readonly methods?: readonly Method[]
  /** Restrict evidence to these absolute route globs. Omit for every path. */
  readonly paths?: readonly string[]
}

/**
 * Evidence published from OUTSIDE the plugin chain - a deployment shell, a mount site, the call that
 * hands the app to `serve`. `scope` defaults to `global` (retroactive, app-wide) because the shell
 * runs after every route is registered, and `provenance` is always stamped `declared`: nifra did not
 * install this enforcement and cannot see it, so a `requireProvenance: "runtime"` rule still rejects it.
 */
export type AssuranceAttachment = Omit<AssuranceDeclaration, "scope" | "provenance"> & {
  readonly scope?: AssuranceScope
}

const EVIDENCE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const METHOD_SET: ReadonlySet<string> = new Set(METHODS)
const declarations = new WeakMap<object, readonly AssuranceDeclaration[]>()

export const NIFRA_ASSURANCE_IDS = Object.freeze({
  AUTHENTICATED: "nifra.authenticated",
  BODY_BOUNDED: "nifra.body-bounded",
  CSRF: "nifra.csrf",
  DURABLE_COMMAND: "nifra.durable-command",
  IDEMPOTENCY_KEY: "nifra.idempotency-key",
  IP_RESTRICTED: "nifra.ip-restricted",
  RATE_LIMITED: "nifra.rate-limited",
  SECURITY_HEADERS: "nifra.security-headers",
  RESPONSE_CONTRACT: "nifra.response-contract",
} as const)

/** Create evidence with provenance stored non-enumerably so existing route descriptors remain
 * byte-compatible while strict assurance policies can reject author-only assertions. */
export function evidenceWithProvenance(
  id: string,
  source: string,
  provenance: "runtime" | "declared",
): AssuranceEvidence {
  const evidence: { id: string; source: string; provenance?: "runtime" | "declared" } = {
    id,
    source,
  }
  Object.defineProperty(evidence, "provenance", {
    value: provenance,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return Object.freeze(evidence)
}

export function evidenceProvenance(value: AssuranceEvidence): "runtime" | "declared" {
  return value.provenance ?? (value.source === "declared" ? "declared" : "runtime")
}

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&")

/** Compile an absolute route glob. `*` is one segment; `**` is zero or more segments. */
export function routeGlob(pattern: string): RegExp {
  if (!pattern.startsWith("/") || pattern.includes("?") || pattern.includes("#")) {
    throw new Error(
      `route assurance: path glob must be an absolute path: ${JSON.stringify(pattern)}`,
    )
  }
  if (pattern === "/") return /^\/$/
  const segments = pattern.slice(1).split("/")
  let source = "^"
  for (const [index, segment] of segments.entries()) {
    if (segment === "**") {
      if (index !== segments.length - 1) {
        throw new Error(
          `route assurance: ** must be the final path segment: ${JSON.stringify(pattern)}`,
        )
      }
      source += "(?:/.*)?"
    } else if (segment === "*") {
      source += "/[^/]+"
    } else {
      if (segment.includes("*")) {
        throw new Error(
          `route assurance: * must occupy a whole path segment: ${JSON.stringify(pattern)}`,
        )
      }
      source += `/${escapeRegex(segment)}`
    }
  }
  return new RegExp(`${source}$`)
}

function normalizeDeclaration(value: AssuranceDeclaration): AssuranceDeclaration {
  if (!EVIDENCE_ID.test(value.id)) {
    throw new Error(
      `route assurance: invalid evidence id ${JSON.stringify(value.id)} (use lowercase dot/dash segments)`,
    )
  }
  if (typeof value.source !== "string" || value.source.trim() === "") {
    throw new Error("route assurance: evidence source must be a non-empty string")
  }
  if (value.scope !== "global" && value.scope !== "subsequent" && value.scope !== "plugin") {
    throw new Error(`route assurance: invalid scope ${JSON.stringify(value.scope)}`)
  }
  const methods = value.methods?.map((method) => method.toUpperCase())
  for (const method of methods ?? []) {
    if (!METHOD_SET.has(method)) {
      throw new Error(`route assurance: unsupported HTTP method ${JSON.stringify(method)}`)
    }
  }
  const paths = value.paths?.map((path) => {
    routeGlob(path)
    return path
  })
  if (
    value.provenance !== undefined &&
    value.provenance !== "runtime" &&
    value.provenance !== "declared"
  ) {
    throw new Error(`route assurance: invalid provenance ${JSON.stringify(value.provenance)}`)
  }
  return Object.freeze({
    id: value.id,
    source: value.source.trim(),
    scope: value.scope,
    // Carried, not defaulted: evidence attached by an author (rather than installed by a running
    // hook) must stay distinguishable so `requireProvenance: "runtime"` rules can still reject it.
    ...(value.provenance !== undefined ? { provenance: value.provenance } : {}),
    ...(methods !== undefined ? { methods: Object.freeze(methods as Method[]) } : {}),
    ...(paths !== undefined ? { paths: Object.freeze(paths) } : {}),
  })
}

/** Validate and freeze declarations, one or many. */
export function normalizeAssuranceDeclarations(
  declaration: AssuranceDeclaration | readonly AssuranceDeclaration[],
): readonly AssuranceDeclaration[] {
  const values: readonly AssuranceDeclaration[] = Array.isArray(declaration)
    ? (declaration as readonly AssuranceDeclaration[])
    : [declaration as AssuranceDeclaration]
  if (values.length === 0) throw new Error("route assurance: at least one declaration is required")
  return Object.freeze(values.map((value) => normalizeDeclaration(value)))
}

/** Attach enforcement evidence to the middleware/plugin that installs it. */
export function withRouteAssurance<T extends object>(
  target: T,
  declaration: AssuranceDeclaration | readonly AssuranceDeclaration[],
): T {
  const previous = declarations.get(target) ?? []
  declarations.set(
    target,
    Object.freeze([...previous, ...normalizeAssuranceDeclarations(declaration)]),
  )
  return target
}

export function assuranceDeclarationsOf(value: object): readonly AssuranceDeclaration[] {
  return declarations.get(value) ?? []
}

export function declarationApplies(
  declaration: AssuranceDeclaration,
  method: string,
  path: string,
): boolean {
  if (declaration.methods !== undefined && !declaration.methods.includes(method as Method))
    return false
  return (
    declaration.paths === undefined ||
    declaration.paths.some((pattern) => routeGlob(pattern).test(path))
  )
}

export function assuranceEvidenceFor(
  declarationsToApply: readonly AssuranceDeclaration[],
  method: string,
  path: string,
): readonly AssuranceEvidence[] {
  const seen = new Set<string>()
  const evidence: AssuranceEvidence[] = []
  for (const declaration of declarationsToApply) {
    if (!declarationApplies(declaration, method, path)) continue
    const key = `${declaration.id}\n${declaration.source}`
    if (seen.has(key)) continue
    seen.add(key)
    evidence.push(
      evidenceWithProvenance(
        declaration.id,
        declaration.source,
        declaration.provenance === "declared" ? "declared" : "runtime",
      ),
    )
  }
  return Object.freeze(evidence)
}

export function validEvidence(value: unknown): value is AssuranceEvidence {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<AssuranceEvidence>
  return (
    typeof candidate.id === "string" &&
    EVIDENCE_ID.test(candidate.id) &&
    typeof candidate.source === "string" &&
    candidate.source.trim() !== ""
  )
}

export function validEvidenceId(value: string): boolean {
  return EVIDENCE_ID.test(value)
}

export function validMethod(value: string): value is Method {
  return METHOD_SET.has(value.toUpperCase())
}
