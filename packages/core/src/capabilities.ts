/**
 * Route effect/capability assurance. Declarations are reflected at build/CI time; runtime beacons
 * are a fail-closed defence at owned effect seams. Static provenance remains the security anchor.
 */

import type { DataClassification } from "./classification.ts"
import {
  CAPABILITY_GUARD,
  type CapabilityGuard,
  type CapabilityUseEvent,
  validCapabilityId,
} from "./internal/capability-runtime.ts"
import { NIFRA_ASSURANCE_IDS } from "./internal/route-assurance.ts"
import { reflectRoutes } from "./reflection.ts"

export type { CapabilityUseEvent }

export type CapabilityZone = "domain" | "operational"
export type CapabilityAccess = "read" | "write"
export type CapabilityIdempotency = "none" | "request" | "durable"

export interface CapabilityDefinition {
  readonly id: string
  /** Domain state is subject to HTTP method semantics; operational writes (logs/metrics) are not. */
  readonly zone: CapabilityZone
  readonly access: CapabilityAccess
  /** Evidence required when this capability may execute. Default `none`. */
  readonly idempotency?: CapabilityIdempotency
}

export interface CapabilityImportRule {
  /** Exact module specifier, or a trailing `/*` prefix rule. */
  readonly specifier: string
  readonly capabilities: readonly string[]
}

export interface ForbiddenCapabilityImport {
  /** Exact module specifier, or a trailing `/*` prefix rule. */
  readonly specifier: string
  readonly reason: string
}

export interface CapabilityRouteSelector {
  readonly methods?: readonly string[]
  readonly paths?: readonly string[]
}

export interface CapabilityRouteModule {
  readonly match: CapabilityRouteSelector
  /** Project-relative modules that implement the selected routes. */
  readonly modules: readonly string[]
}

export interface CapabilityProvenancePolicy {
  readonly imports: readonly CapabilityImportRule[]
  readonly forbiddenImports: readonly ForbiddenCapabilityImport[]
  /** Explicit associations for contract/generated routes that source scanning cannot locate. */
  readonly routeModules?: readonly CapabilityRouteModule[]
}

export interface CapabilityPolicy {
  readonly definitions: readonly CapabilityDefinition[]
  /** Required: capability assurance without a static provenance firewall is incomplete. */
  readonly provenance: CapabilityProvenancePolicy
  /** Default `capabilities.lock.json`. */
  readonly lockfile?: string
}

export type CapabilityEvidenceKind = "static" | "runtime"

/** Token-only effect evidence. `source` is an adapter/module id, never request or business data. */
export interface CapabilityEvidence {
  readonly id: string
  readonly kind: CapabilityEvidenceKind
  readonly source: string
}

export interface RouteCapabilityEvidence {
  readonly method: string
  readonly path: string
  /** True only when the route's reachable module graph was actually scanned. */
  readonly covered: boolean
  readonly evidence: readonly CapabilityEvidence[]
}

export interface CapabilityEvidenceSet {
  readonly routes: readonly RouteCapabilityEvidence[]
}

export type CapabilityFindingCode =
  | "unknown-capability"
  | "provenance-uncovered"
  | "undeclared-capability-evidence"
  | "safe-method-domain-write"
  | "missing-request-idempotency"
  | "missing-durable-idempotency"
  | "forbidden-effect-import"

export interface CapabilityFinding {
  readonly code: CapabilityFindingCode
  readonly method: string
  readonly path: string
  readonly capability?: string
  readonly message: string
}

export interface AssuredCapabilityRoute {
  readonly method: string
  readonly path: string
  readonly declared: readonly string[]
  readonly evidence: readonly CapabilityEvidence[]
  /** Declared capabilities without static/runtime evidence. Informational, never treated as proof. */
  readonly unproven: readonly string[]
  readonly covered: boolean
  /** Highest data-sensitivity the response carries, when the route declares it. */
  readonly classification?: DataClassification
}

export interface CapabilityAssuranceReport {
  readonly ok: boolean
  readonly routes: readonly AssuredCapabilityRoute[]
  readonly findings: readonly CapabilityFinding[]
}

export interface CapabilitySnapshotRoute {
  readonly method: string
  readonly path: string
  readonly declared: readonly string[]
  readonly evidenced: readonly string[]
  readonly unproven: readonly string[]
  /** Recorded so a route that starts returning `pii`/`secret` flips the lockfile and forces a review. */
  readonly classification?: DataClassification
}

export interface CapabilitySnapshot {
  readonly nifraCapabilities: 1
  readonly routes: readonly CapabilitySnapshotRoute[]
}

const SAFE_METHODS = new Set(["GET", "HEAD"])

export { validCapabilityId }

function normalizedIds(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string" || !validCapabilityId(value)) {
      throw new Error(`capability assurance: invalid ${label} id ${JSON.stringify(value)}`)
    }
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return Object.freeze(out)
}

function validSpecifier(value: string): boolean {
  return value.trim() === value && value !== "" && !hasControlCharacter(value)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

/** Validate and freeze a capability/provenance policy. */
export function defineCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicy {
  if (policy.provenance === undefined || policy.provenance === null) {
    throw new Error("capability assurance: provenance policy is required")
  }
  const ids = new Set<string>()
  const definitions = policy.definitions.map((definition): CapabilityDefinition => {
    if (!validCapabilityId(definition.id)) {
      throw new Error(
        `capability assurance: invalid capability id ${JSON.stringify(definition.id)}`,
      )
    }
    if (ids.has(definition.id)) {
      throw new Error(`capability assurance: duplicate capability ${JSON.stringify(definition.id)}`)
    }
    ids.add(definition.id)
    if (definition.zone !== "domain" && definition.zone !== "operational") {
      throw new Error(`capability assurance: invalid zone for ${definition.id}`)
    }
    if (definition.access !== "read" && definition.access !== "write") {
      throw new Error(`capability assurance: invalid access for ${definition.id}`)
    }
    const idempotency = definition.idempotency ?? "none"
    if (idempotency !== "none" && idempotency !== "request" && idempotency !== "durable") {
      throw new Error(`capability assurance: invalid idempotency for ${definition.id}`)
    }
    if (definition.access === "read" && idempotency !== "none") {
      throw new Error(
        `capability assurance: read capability ${definition.id} cannot require idempotency`,
      )
    }
    return Object.freeze({ ...definition, idempotency })
  })
  const imports = policy.provenance.imports.map((rule): CapabilityImportRule => {
    if (!validSpecifier(rule.specifier))
      throw new Error("capability assurance: invalid import specifier")
    const capabilities = normalizedIds(rule.capabilities, "import capability")
    for (const id of capabilities) {
      if (!ids.has(id)) throw new Error(`capability assurance: import references unknown ${id}`)
    }
    return Object.freeze({ specifier: rule.specifier, capabilities })
  })
  const forbiddenImports = policy.provenance.forbiddenImports.map(
    (rule): ForbiddenCapabilityImport => {
      if (!validSpecifier(rule.specifier) || rule.reason.trim() === "") {
        throw new Error("capability assurance: forbidden import needs a specifier and reason")
      }
      return Object.freeze({ specifier: rule.specifier, reason: rule.reason.trim() })
    },
  )
  const routeModules = policy.provenance.routeModules?.map((rule): CapabilityRouteModule => {
    if (!Array.isArray(rule.modules) || rule.modules.length === 0) {
      throw new Error("capability assurance: routeModules entry needs at least one module")
    }
    const modules = rule.modules.map((module) => {
      if (!validSpecifier(module)) throw new Error("capability assurance: invalid route module")
      return module.replace(/^\.\//, "")
    })
    return Object.freeze({
      match: Object.freeze({
        ...(rule.match.methods !== undefined
          ? { methods: Object.freeze(rule.match.methods.map((method) => method.toUpperCase())) }
          : {}),
        ...(rule.match.paths !== undefined ? { paths: Object.freeze([...rule.match.paths]) } : {}),
      }),
      modules: Object.freeze(modules),
    })
  })
  return Object.freeze({
    definitions: Object.freeze(definitions),
    provenance: Object.freeze({
      imports: Object.freeze(imports),
      forbiddenImports: Object.freeze(forbiddenImports),
      ...(routeModules !== undefined ? { routeModules: Object.freeze(routeModules) } : {}),
    }),
    lockfile: policy.lockfile ?? "capabilities.lock.json",
  })
}

function evidenceSourceValid(source: string): boolean {
  return source.length > 0 && source.length <= 256 && !hasControlCharacter(source)
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()}\n${path}`
}

/** Compare declared route capabilities against coverage-qualified static/runtime evidence. */
export function evaluateCapabilityAssurance(
  source: unknown,
  policyInput: CapabilityPolicy,
  evidenceSet: CapabilityEvidenceSet,
): CapabilityAssuranceReport {
  const policy = defineCapabilityPolicy(policyInput)
  const definitions = new Map(policy.definitions.map((definition) => [definition.id, definition]))
  const evidenceByRoute = new Map(
    evidenceSet.routes.map((route) => [routeKey(route.method, route.path), route]),
  )
  const findings: CapabilityFinding[] = []
  const routes: AssuredCapabilityRoute[] = []

  for (const route of reflectRoutes(source)) {
    const declared = route.capabilities ?? []
    const supplied = evidenceByRoute.get(routeKey(route.method, route.path))
    const covered = supplied?.covered === true
    const evidence: CapabilityEvidence[] = []
    const evidenceIds = new Set<string>()
    for (const item of supplied?.evidence ?? []) {
      if (
        !validCapabilityId(item.id) ||
        (item.kind !== "static" && item.kind !== "runtime") ||
        !evidenceSourceValid(item.source)
      ) {
        continue
      }
      const key = `${item.id}\n${item.kind}\n${item.source}`
      if (
        evidence.some(
          (candidate) => `${candidate.id}\n${candidate.kind}\n${candidate.source}` === key,
        )
      )
        continue
      evidence.push(Object.freeze({ id: item.id, kind: item.kind, source: item.source }))
      evidenceIds.add(item.id)
    }

    for (const id of declared) {
      if (!definitions.has(id)) {
        findings.push({
          code: "unknown-capability",
          method: route.method,
          path: route.path,
          capability: id,
          message: `${route.method} ${route.path} declares unknown capability ${id}`,
        })
      }
    }
    if (!covered) {
      findings.push({
        code: "provenance-uncovered",
        method: route.method,
        path: route.path,
        message: `${route.method} ${route.path} has no static provenance coverage`,
      })
    }
    for (const id of evidenceIds) {
      if (!declared.includes(id)) {
        findings.push({
          code: "undeclared-capability-evidence",
          method: route.method,
          path: route.path,
          capability: id,
          message: `${route.method} ${route.path} evidence exceeds its declaration: ${id}`,
        })
      }
    }

    const effective = new Set([...declared, ...evidenceIds])
    const assuranceIds = new Set((route.assurance ?? []).map((item) => item.id))
    for (const id of effective) {
      const definition = definitions.get(id)
      if (definition === undefined) continue
      if (
        SAFE_METHODS.has(route.method) &&
        definition.zone === "domain" &&
        definition.access === "write"
      ) {
        findings.push({
          code: "safe-method-domain-write",
          method: route.method,
          path: route.path,
          capability: id,
          message: `${route.method} ${route.path} cannot carry domain write capability ${id}`,
        })
      }
      if (
        definition.idempotency === "request" &&
        !assuranceIds.has(NIFRA_ASSURANCE_IDS.IDEMPOTENCY_KEY)
      ) {
        findings.push({
          code: "missing-request-idempotency",
          method: route.method,
          path: route.path,
          capability: id,
          message: `${route.method} ${route.path} capability ${id} requires request idempotency evidence`,
        })
      }
      if (
        definition.idempotency === "durable" &&
        !assuranceIds.has(NIFRA_ASSURANCE_IDS.DURABLE_COMMAND)
      ) {
        findings.push({
          code: "missing-durable-idempotency",
          method: route.method,
          path: route.path,
          capability: id,
          message: `${route.method} ${route.path} capability ${id} requires durable command/provider-key evidence`,
        })
      }
    }
    routes.push(
      Object.freeze({
        method: route.method,
        path: route.path,
        declared: Object.freeze([...declared]),
        evidence: Object.freeze(evidence),
        unproven: Object.freeze(declared.filter((id) => !evidenceIds.has(id))),
        covered,
        ...(route.classification !== undefined ? { classification: route.classification } : {}),
      }),
    )
  }
  return Object.freeze({
    ok: findings.length === 0,
    routes: Object.freeze(routes),
    findings: Object.freeze(findings),
  })
}

/**
 * Runtime effect beacon for owned adapters. It fails closed when the route omitted the capability or
 * when no route guard is present. Static provenance is still required: code can bypass a beacon.
 */
export function useCapability(context: object, capability: string): void {
  if (!validCapabilityId(capability)) {
    throw new Error(
      `capability assurance: invalid runtime capability ${JSON.stringify(capability)}`,
    )
  }
  const guard = (context as { readonly [CAPABILITY_GUARD]?: CapabilityGuard })[CAPABILITY_GUARD]
  if (guard === undefined) {
    throw new Error(
      `capability assurance: ${capability} used on a route with no capability declaration`,
    )
  }
  if (!guard.allowed.includes(capability)) {
    throw new Error(
      `capability assurance: ${capability} is not declared for ${guard.method} ${guard.path}`,
    )
  }
  guard.onUse?.({ capability, method: guard.method, path: guard.path })
}

/** Deterministic, PII-free lockfile material. */
export function snapshotCapabilities(report: CapabilityAssuranceReport): CapabilitySnapshot {
  const routes = report.routes
    .map(
      (route): CapabilitySnapshotRoute => ({
        method: route.method,
        path: route.path,
        declared: Object.freeze([...route.declared].sort()),
        evidenced: Object.freeze([...new Set(route.evidence.map((item) => item.id))].sort()),
        unproven: Object.freeze([...route.unproven].sort()),
        ...(route.classification !== undefined ? { classification: route.classification } : {}),
      }),
    )
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  return Object.freeze({ nifraCapabilities: 1, routes: Object.freeze(routes) })
}
