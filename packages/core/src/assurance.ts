/**
 * Route assurance: reflection-time proof that every route is classified and carries the enforcement
 * evidence its policy requires. Evaluation is pure and never runs on the request hot path.
 */

import type {
  AssuranceDeclaration,
  AssuranceEvidence,
  AssuranceScope,
} from "./internal/route-assurance.ts"
import {
  NIFRA_ASSURANCE_IDS,
  routeGlob,
  validEvidenceId,
  validMethod,
  withRouteAssurance,
} from "./internal/route-assurance.ts"
import { type ReflectedRoute, reflectRoutes } from "./reflection.ts"
import type { Method } from "./router/router.ts"

export type { AssuranceDeclaration, AssuranceEvidence, AssuranceScope }
export { withRouteAssurance }

/** Canonical evidence ids emitted by Nifra's official middleware modules. */
export const NIFRA_ASSURANCE = NIFRA_ASSURANCE_IDS

export interface AssuranceRouteSelector {
  /** Omit for every method. */
  readonly methods?: readonly Method[]
  /** Absolute route globs. `*` matches one segment; final `**` matches zero or more. */
  readonly paths?: readonly string[]
  /** Restrict the rule to MCP tool routes (`true`) or non-tool routes (`false`). */
  readonly tools?: boolean
}

export interface AssuranceRule {
  /** Stable human-readable classification included in diagnostics. */
  readonly name: string
  readonly match: AssuranceRouteSelector
  /** Evidence ids the route must carry. */
  readonly require?: readonly string[]
  /** Evidence ids the route must not carry (useful for public webhooks and health routes). */
  readonly forbid?: readonly string[]
}

export interface AssurancePolicy {
  /** First matching rule owns a route. Put exceptions before broad defaults. */
  readonly rules: readonly AssuranceRule[]
  /** Default `error`: an unclassified route fails closed. */
  readonly unmatched?: "error" | "ignore"
  /** Default false: reject an empty reflected source so a wrong import cannot pass CI silently. */
  readonly allowEmpty?: boolean
}

export type AssuranceFindingCode =
  | "no-routes"
  | "unclassified-route"
  | "missing-evidence"
  | "forbidden-evidence"

export interface AssuranceFinding {
  readonly code: AssuranceFindingCode
  readonly method: string
  readonly path: string
  readonly rule?: string
  readonly evidence?: string
  readonly message: string
}

export interface AssuredRoute {
  readonly method: string
  readonly path: string
  readonly rule?: string
  readonly evidence: readonly AssuranceEvidence[]
  readonly missing: readonly string[]
  readonly forbidden: readonly string[]
}

export interface AssuranceReport {
  readonly ok: boolean
  readonly routes: readonly AssuredRoute[]
  readonly findings: readonly AssuranceFinding[]
}

export interface AssuranceConfig {
  readonly source: unknown
  readonly policy: AssurancePolicy
}

const nonEmpty = (value: string): boolean => value.trim() !== ""

function normalizeEvidenceIds(
  values: readonly string[] | undefined,
  label: string,
): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    if (!validEvidenceId(value)) {
      throw new Error(`route assurance: invalid ${label} evidence id ${JSON.stringify(value)}`)
    }
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return Object.freeze(out)
}

/** Validate and freeze an ordered assurance policy. */
export function defineAssurancePolicy(policy: AssurancePolicy): AssurancePolicy {
  if (
    policy.unmatched !== undefined &&
    policy.unmatched !== "error" &&
    policy.unmatched !== "ignore"
  ) {
    throw new Error(`route assurance: invalid unmatched mode ${JSON.stringify(policy.unmatched)}`)
  }
  if (policy.allowEmpty !== undefined && typeof policy.allowEmpty !== "boolean") {
    throw new Error(`route assurance: allowEmpty must be boolean`)
  }
  const names = new Set<string>()
  const rules = policy.rules.map((rule): AssuranceRule => {
    if (typeof rule.name !== "string" || !nonEmpty(rule.name)) {
      throw new Error("route assurance: rule name must be non-empty")
    }
    const name = rule.name.trim()
    if (names.has(name))
      throw new Error(`route assurance: duplicate rule name ${JSON.stringify(name)}`)
    names.add(name)
    if (rule.match.tools !== undefined && typeof rule.match.tools !== "boolean") {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} tools selector must be boolean`,
      )
    }
    const methods = rule.match.methods?.map((method) => method.toUpperCase())
    for (const method of methods ?? []) {
      if (!validMethod(method)) {
        throw new Error(`route assurance: unsupported HTTP method ${JSON.stringify(method)}`)
      }
    }
    const paths = rule.match.paths?.map((path) => {
      routeGlob(path)
      return path
    })
    const required = normalizeEvidenceIds(rule.require, "required")
    const forbidden = normalizeEvidenceIds(rule.forbid, "forbidden")
    const overlap = required.find((id) => forbidden.includes(id))
    if (overlap !== undefined) {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} both requires and forbids ${overlap}`,
      )
    }
    return Object.freeze({
      name,
      match: Object.freeze({
        ...(methods !== undefined ? { methods: Object.freeze(methods as Method[]) } : {}),
        ...(paths !== undefined ? { paths: Object.freeze(paths) } : {}),
        ...(rule.match.tools !== undefined ? { tools: rule.match.tools } : {}),
      }),
      require: required,
      forbid: forbidden,
    })
  })
  return Object.freeze({
    rules: Object.freeze(rules),
    unmatched: policy.unmatched ?? "error",
    allowEmpty: policy.allowEmpty ?? false,
  })
}

/** Identity helper for a `nifra.assurance.ts` default export. */
export function defineAssuranceConfig(config: AssuranceConfig): AssuranceConfig {
  return Object.freeze({ source: config.source, policy: defineAssurancePolicy(config.policy) })
}

/** Shared selector semantics for policy rules and framework adapters. */
export function matchesAssuranceSelector(
  route: Pick<ReflectedRoute, "method" | "path" | "tool">,
  selector: AssuranceRouteSelector,
): boolean {
  const { methods, paths, tools } = selector
  if (methods !== undefined && !methods.includes(route.method as Method)) return false
  if (paths !== undefined && !paths.some((pattern) => routeGlob(pattern).test(route.path)))
    return false
  if (tools !== undefined && (route.tool !== undefined) !== tools) return false
  return true
}

/** Evaluate reflected route evidence against the first matching policy rule. */
export function evaluateRouteAssurance(
  source: unknown,
  policyInput: AssurancePolicy,
): AssuranceReport {
  const policy = defineAssurancePolicy(policyInput)
  const findings: AssuranceFinding[] = []
  const routes: AssuredRoute[] = []
  const reflected = reflectRoutes(source)

  if (reflected.length === 0 && policy.allowEmpty !== true) {
    findings.push({
      code: "no-routes",
      method: "*",
      path: "*",
      message: "route assurance source reflected zero routes (set allowEmpty: true if intentional)",
    })
  }

  for (const route of reflected) {
    const rule = policy.rules.find((candidate) => matchesAssuranceSelector(route, candidate.match))
    const evidence = route.assurance ?? []
    const evidenceIds = new Set(evidence.map((item) => item.id))
    if (rule === undefined) {
      if (policy.unmatched !== "ignore") {
        findings.push({
          code: "unclassified-route",
          method: route.method,
          path: route.path,
          message: `${route.method} ${route.path} is not classified by an assurance rule`,
        })
      }
      routes.push({ method: route.method, path: route.path, evidence, missing: [], forbidden: [] })
      continue
    }

    const missing = (rule.require ?? []).filter((id) => !evidenceIds.has(id))
    const forbidden = (rule.forbid ?? []).filter((id) => evidenceIds.has(id))
    for (const id of missing) {
      findings.push({
        code: "missing-evidence",
        method: route.method,
        path: route.path,
        rule: rule.name,
        evidence: id,
        message: `${route.method} ${route.path} (${rule.name}) is missing ${id}`,
      })
    }
    for (const id of forbidden) {
      findings.push({
        code: "forbidden-evidence",
        method: route.method,
        path: route.path,
        rule: rule.name,
        evidence: id,
        message: `${route.method} ${route.path} (${rule.name}) carries forbidden ${id}`,
      })
    }
    routes.push({
      method: route.method,
      path: route.path,
      rule: rule.name,
      evidence,
      missing: Object.freeze(missing),
      forbidden: Object.freeze(forbidden),
    })
  }

  return Object.freeze({
    ok: findings.length === 0,
    routes: Object.freeze(routes),
    findings: Object.freeze(findings),
  })
}
