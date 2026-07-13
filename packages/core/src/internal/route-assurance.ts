import { METHODS, type Method } from "../router/router.ts"

/** Where enforcement evidence follows Nifra's route-registration semantics. */
export type AssuranceScope = "global" | "subsequent" | "plugin"

/** Reflection-safe proof that a named enforcement module covered a route. */
export interface AssuranceEvidence {
  readonly id: string
  readonly source: string
}

/** Metadata installed on a middleware/plugin by {@link withRouteAssurance}. */
export interface AssuranceDeclaration extends AssuranceEvidence {
  readonly scope: AssuranceScope
  /** Restrict evidence to these HTTP methods. Omit for every method. */
  readonly methods?: readonly Method[]
  /** Restrict evidence to these absolute route globs. Omit for every path. */
  readonly paths?: readonly string[]
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
} as const)

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
  return Object.freeze({
    id: value.id,
    source: value.source.trim(),
    scope: value.scope,
    ...(methods !== undefined ? { methods: Object.freeze(methods as Method[]) } : {}),
    ...(paths !== undefined ? { paths: Object.freeze(paths) } : {}),
  })
}

/** Attach enforcement evidence to the middleware/plugin that installs it. */
export function withRouteAssurance<T extends object>(
  target: T,
  declaration: AssuranceDeclaration | readonly AssuranceDeclaration[],
): T {
  const values = Array.isArray(declaration) ? declaration : [declaration]
  if (values.length === 0) throw new Error("route assurance: at least one declaration is required")
  const previous = declarations.get(target) ?? []
  declarations.set(
    target,
    Object.freeze([...previous, ...values.map((value) => normalizeDeclaration(value))]),
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
    evidence.push(Object.freeze({ id: declaration.id, source: declaration.source }))
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
