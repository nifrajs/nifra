/**
 * Route assurance: reflection-time proof that every route is classified and carries the enforcement
 * evidence its policy requires. Evaluation is pure and never runs on the request hot path.
 */

import {
  type CapabilityAccess,
  type CapabilityAssuranceReport,
  type CapabilityDefinition,
  type CapabilityPolicy,
  type CapabilityZone,
  defineCapabilityPolicy,
} from "./capabilities.ts"
import {
  type DataClassification,
  classificationAtLeast as isClassificationAtLeast,
  isDataClassification,
} from "./classification.ts"
import type {
  AssuranceAttachment,
  AssuranceDeclaration,
  AssuranceEvidence,
  AssuranceScope,
} from "./internal/route-assurance.ts"
import {
  evidenceProvenance,
  NIFRA_ASSURANCE_IDS,
  normalizeAssuranceDeclarations,
  routeGlob,
  validEvidenceId,
  validMethod,
  withRouteAssurance,
} from "./internal/route-assurance.ts"
import type { SealedEffectLedger } from "./ledger.ts"
import type { NifraManifestSigner } from "./manifest.ts"
import { type ReflectedRoute, reflectRoutes } from "./reflection.ts"
import type { Method } from "./router/router.ts"

export {
  type SecurityBaselineLevel,
  type SecurityBaselineOptions,
  securityBaseline,
} from "./security/baseline.ts"
export type { AssuranceAttachment, AssuranceDeclaration, AssuranceEvidence, AssuranceScope }
export { withRouteAssurance }

/** Isolated request executor used by adversarial contract verification. */
export type InvariantExecutor = (request: Request) => Response | Promise<Response>

/** Canonical evidence ids emitted by Nifra's official middleware modules. */
export const NIFRA_ASSURANCE = NIFRA_ASSURANCE_IDS

/** The seam `assure()` writes through: an evidence-only middleware bundle, applied like any other. */
interface AssurableServer {
  use(middleware: object): unknown
}

/**
 * Publish enforcement evidence from OUTSIDE the plugin chain - the deployment shell that wraps the
 * app, the mount site, or the call that hands it to `serve`. When the thing doing the enforcing is
 * not a nifra plugin (a gateway, a service mesh, an outer framework), the alternative is switching
 * the affected rules off; this records what covers the routes instead, so the policy keeps running.
 *
 *   const app = buildApp()                 // no assurance-bearing plugin in its .use() chain
 *   assure(app, { id: NIFRA_ASSURANCE.AUTHENTICATED, source: "edge-gateway" })
 *   serve(app)
 *
 * `scope` defaults to `global`: the shell runs after every route is registered, so the evidence is
 * retroactive and app-wide. Narrow it with `methods`/`paths` (absolute globs), or pass
 * `scope: "subsequent"` to cover only routes registered after the call.
 *
 * Provenance is always `declared` - nifra did not install this enforcement and cannot observe it, so
 * a rule with `requireProvenance: "runtime"` still rejects the route, by design.
 */
export function assure(
  app: unknown,
  evidence: AssuranceAttachment | readonly AssuranceAttachment[],
): void {
  const values: readonly AssuranceAttachment[] = Array.isArray(evidence)
    ? (evidence as readonly AssuranceAttachment[])
    : [evidence as AssuranceAttachment]
  const declarations = normalizeAssuranceDeclarations(
    values.map((item) => ({
      ...item,
      scope: item.scope ?? "global",
      provenance: "declared" as const,
    })),
  )
  for (const declaration of declarations) {
    if (declaration.scope === "plugin") {
      throw new Error('assure(): scope "plugin" may only annotate a plugin function')
    }
  }
  const target = app as Partial<AssurableServer>
  if (typeof target.use !== "function") {
    throw new TypeError("assure(): expected a nifra server")
  }
  // An evidence-only bundle: `use()` already reads declarations off what it applies, and a bundle
  // with no hooks registers nothing on any lifecycle array - so the kernel needs no seam of its own,
  // the request path is untouched, and an app that never calls `assure()` carries none of this.
  target.use(withRouteAssurance({}, declarations))
}

export interface AssuranceRouteSelector {
  /** Omit for every method. */
  readonly methods?: readonly Method[]
  /** Absolute route globs. `*` matches one segment; final `**` matches zero or more. */
  readonly paths?: readonly string[]
  /** Restrict the rule to MCP tool routes (`true`) or non-tool routes (`false`). */
  readonly tools?: boolean
  /**
   * Match routes declaring ANY of these capability tokens.
   *
   * Lets a policy be written about what a route DOES rather than where it lives: "anything that writes
   * to the database must be authenticated" survives a route being moved or renamed, which a path glob
   * does not. Reflection already carries the declared tokens, so this reads what the route said about
   * itself.
   *
   * Naming exact tokens is precise but closed: a rule listing `db.write` does not cover `storage.write`,
   * and a capability added next year escapes it in silence. Prefer `access`/`zone` for a rule that is
   * meant to hold for a CLASS of effect.
   */
  readonly capabilities?: readonly string[]
  /**
   * Match routes declaring any capability whose definition has this access.
   *
   * This is the selector to reach for when the rule is "anything that writes must prove who asked":
   * it is keyed on what the capability IS rather than what it is called, so a token introduced later
   * is covered the day it is declared instead of the day someone remembers to widen the rule.
   *
   * Requires capability definitions. A policy using it without them is refused rather than quietly
   * matching nothing - a selector that matches nothing lets the route fall through to a laxer rule.
   */
  readonly access?: CapabilityAccess
  /**
   * Match routes declaring any capability in this zone. Combined with `access`, both must hold for the
   * SAME capability, so `{ access: "write", zone: "domain" }` is "writes business state" and does not
   * match a route that only writes an audit log.
   */
  readonly zone?: CapabilityZone
  /** Match routes whose response classification is at least this sensitivity. */
  readonly classificationAtLeast?: DataClassification
  /**
   * Match routes by whether they declare a request-body schema. `true` selects routes that parse a
   * body (the buffered-read surface F-001 is about); `false` selects bodyless routes. Reflection
   * already carries `schema.body`, so this reads what the route declared, not where it lives.
   */
  readonly hasBody?: boolean
  /**
   * Match routes by their effective transport body policy. `"unlimited"` is the explicit
   * streaming/upload exemption; `"bounded"` is any finite cap (an explicit number or the inherited
   * server default); `"unset"` is a route that declared no `bodyLimit` at all. Lets a baseline say
   * "a body-schema route may never be unlimited" as a first-class, movable invariant rather than a
   * path list. A route with no schema reports `"unset"` unless it names a limit.
   */
  readonly bodyLimit?: "bounded" | "unlimited" | "unset"
}

/** Extra inputs an assurance evaluation needs beyond the routes themselves. */
export interface AssuranceEvaluationOptions {
  /**
   * Capability definitions, required by any rule selecting on `access`/`zone`. Normally
   * `config.capabilities.definitions`.
   */
  readonly definitions?: readonly CapabilityDefinition[]
}

/** Selector keys that cannot be resolved from reflection alone. */
const CLASS_SELECTOR_KEYS = ["access", "zone"] as const

const usesClassSelector = (selector: AssuranceRouteSelector): boolean =>
  selector.access !== undefined || selector.zone !== undefined

/** The rules whose selector needs capability definitions to mean anything. */
function rulesNeedingDefinitions(policy: AssurancePolicy): readonly string[] {
  return policy.rules.filter((rule) => usesClassSelector(rule.match)).map((rule) => rule.name)
}

function definitionMap(
  definitions: readonly CapabilityDefinition[] | undefined,
): ReadonlyMap<string, CapabilityDefinition> {
  return new Map((definitions ?? []).map((definition) => [definition.id, definition]))
}

export interface AssuranceRule {
  /** Stable human-readable classification included in diagnostics. */
  readonly name: string
  readonly match: AssuranceRouteSelector
  /** Evidence ids the route must carry. */
  readonly require?: readonly string[]
  /** Evidence ids the route must not carry (useful for public webhooks and health routes). */
  readonly forbid?: readonly string[]
  /**
   * Provenance required for every id in require. any (default) preserves compatibility with
   * existing policies; runtime rejects schema.assurance author assertions and accepts only
   * evidence installed by middleware/plugins or framework runtime policy. declared is useful for
   * explicitly reviewing in-handler assertions and should not be used as an enforcement gate.
   */
  readonly requireProvenance?: "any" | "runtime" | "declared"
  /**
   * When true, an authenticated route selected by this rule must also carry runtime CSRF evidence.
   * Enable this on rules covering cookie/session-authenticated browser routes; bearer-only APIs
   * should use a separate rule because they do not have browser ambient-authority exposure.
   */
  readonly requireCsrfWithAuthenticated?: boolean
}

export interface AssurancePolicy {
  /** First matching rule owns a route. Put exceptions before broad defaults. */
  readonly rules: readonly AssuranceRule[]
  /** Default `error`: an unclassified route fails closed. */
  readonly unmatched?: "error" | "ignore"
  /** Default false: reject an empty reflected source so a wrong import cannot pass CI silently. */
  readonly allowEmpty?: boolean
  /**
   * Default false. When true, a route matched by a **pure-classification** rule (no `require`, no `forbid`)
   * that carries NO enforcement evidence is reported (`classified-no-evidence`). This surfaces the gap the
   * feedback flagged: a classification-only policy silently degrades "proof" to a "label". Opt-in, because
   * a genuinely public route legitimately carries no evidence; enable it once your guards emit evidence
   * (inline `schema.assurance` or a `withRouteAssurance` middleware) to keep classification honest.
   */
  readonly flagClassifiedWithoutEvidence?: boolean
}

export type AssuranceFindingCode =
  | "no-routes"
  | "unclassified-route"
  | "missing-evidence"
  | "forbidden-evidence"
  | "classified-no-evidence"

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
  /** Present when the config enables capability/effect assurance. */
  readonly capabilities?: CapabilityAssuranceReport
}

/** Application-supplied verification rules. The CLI validates the executable rule shape at runtime. */
export interface AssuranceRulePack {
  readonly name: string
  readonly rules: readonly unknown[]
}

export interface IdempotencyWorkload {
  readonly name: string
  readonly run: () => Promise<SealedEffectLedger> | SealedEffectLedger
}

export interface AssuranceSizeBudget {
  readonly outDir?: string
  readonly maxBytes?: number
  readonly maxGzipBytes?: number
}

export interface AssuranceConfig {
  readonly source: unknown
  readonly policy: AssurancePolicy
  readonly capabilities?: CapabilityPolicy
  /** Off-request-path manifest artifact/signing integration. Private keys remain behind `signer`. */
  readonly manifest?: {
    /** Default `nifra.manifest.json`. */
    readonly path?: string
    /** Resolve an operator key reference to a signer (KMS/HSM/local WebCrypto). */
    readonly signer?: (keyRef: string) => NifraManifestSigner | Promise<NifraManifestSigner>
  }
  /** Dynamic invariant execution is opt-in and must use a disposable/sandboxed target. */
  readonly invariants?: {
    readonly executor: InvariantExecutor
  }
  /** Optional application-supplied rule packs appended after built-in verification rules. */
  readonly rulePacks?: readonly AssuranceRulePack[]
  /** Optional sink for an assurance bundle. The CLI validates the callable shape at runtime. */
  readonly assureSink?: unknown
  /** Optional deterministic effect workloads for the tests gate. */
  readonly idempotency?: readonly IdempotencyWorkload[]
  /** Optional output-size budget for the assurance bundle's size gate. */
  readonly size?: AssuranceSizeBudget
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
  if (
    policy.flagClassifiedWithoutEvidence !== undefined &&
    typeof policy.flagClassifiedWithoutEvidence !== "boolean"
  ) {
    throw new Error(`route assurance: flagClassifiedWithoutEvidence must be boolean`)
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
    // The selector is rebuilt from known keys below, so an unrecognised one would be dropped in
    // silence - and a selector that loses its only constraint matches EVERY route, making the rule
    // swallow everything after it. A misspelled key is a policy hole, so it is refused here.
    const unknown = Object.keys(rule.match).filter(
      (key) =>
        ![
          "methods",
          "paths",
          "tools",
          "capabilities",
          ...CLASS_SELECTOR_KEYS,
          "classificationAtLeast",
          "hasBody",
          "bodyLimit",
        ].includes(key),
    )
    if (unknown.length > 0) {
      throw new Error(
        `route assurance: rule ${JSON.stringify(rule.name)} has unknown selector key(s) ${unknown
          .map((key) => JSON.stringify(key))
          .join(", ")} - a dropped selector would match every route`,
      )
    }
    if (rule.match.tools !== undefined && typeof rule.match.tools !== "boolean") {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} tools selector must be boolean`,
      )
    }
    if (rule.match.hasBody !== undefined && typeof rule.match.hasBody !== "boolean") {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} hasBody selector must be boolean`,
      )
    }
    if (
      rule.match.bodyLimit !== undefined &&
      rule.match.bodyLimit !== "bounded" &&
      rule.match.bodyLimit !== "unlimited" &&
      rule.match.bodyLimit !== "unset"
    ) {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} bodyLimit selector must be "bounded", "unlimited", or "unset"`,
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
    const capabilities = rule.match.capabilities
    if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.length === 0)) {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} capabilities selector must be a non-empty array`,
      )
    }
    const access = rule.match.access
    if (access !== undefined && access !== "read" && access !== "write") {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} access selector must be "read" or "write"`,
      )
    }
    const zone = rule.match.zone
    if (zone !== undefined && zone !== "domain" && zone !== "operational") {
      throw new Error(
        `route assurance: rule ${JSON.stringify(name)} zone selector must be "domain" or "operational"`,
      )
    }
    if (
      rule.match.classificationAtLeast !== undefined &&
      !isDataClassification(rule.match.classificationAtLeast)
    ) {
      throw new Error(
        "route assurance: rule " +
          JSON.stringify(name) +
          ' classificationAtLeast must be "public", "pii", or "secret"',
      )
    }
    const required = normalizeEvidenceIds(rule.require, "required")
    const forbidden = normalizeEvidenceIds(rule.forbid, "forbidden")
    if (
      rule.requireProvenance !== undefined &&
      rule.requireProvenance !== "any" &&
      rule.requireProvenance !== "runtime" &&
      rule.requireProvenance !== "declared"
    ) {
      throw new Error(
        "route assurance: rule " +
          JSON.stringify(name) +
          ' requireProvenance must be "any", "runtime", or "declared"',
      )
    }
    if (
      rule.requireCsrfWithAuthenticated !== undefined &&
      typeof rule.requireCsrfWithAuthenticated !== "boolean"
    ) {
      throw new Error(
        "route assurance: rule " +
          JSON.stringify(name) +
          " requireCsrfWithAuthenticated must be boolean",
      )
    }
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
        ...(capabilities !== undefined ? { capabilities: Object.freeze([...capabilities]) } : {}),
        ...(access !== undefined ? { access } : {}),
        ...(zone !== undefined ? { zone } : {}),
        ...(rule.match.classificationAtLeast !== undefined
          ? { classificationAtLeast: rule.match.classificationAtLeast }
          : {}),
        ...(rule.match.hasBody !== undefined ? { hasBody: rule.match.hasBody } : {}),
        ...(rule.match.bodyLimit !== undefined ? { bodyLimit: rule.match.bodyLimit } : {}),
      }),
      require: required,
      forbid: forbidden,
      ...(rule.requireProvenance !== undefined
        ? { requireProvenance: rule.requireProvenance }
        : {}),
      ...(rule.requireCsrfWithAuthenticated === true ? { requireCsrfWithAuthenticated: true } : {}),
    })
  })
  return Object.freeze({
    rules: Object.freeze(rules),
    unmatched: policy.unmatched ?? "error",
    allowEmpty: policy.allowEmpty ?? false,
    flagClassifiedWithoutEvidence: policy.flagClassifiedWithoutEvidence ?? false,
  })
}

/** Identity helper for a `nifra.assurance.ts` default export. */
export function defineAssuranceConfig(config: AssuranceConfig): AssuranceConfig {
  if (config.manifest?.path !== undefined && config.manifest.path.trim() === "") {
    throw new Error("route assurance: manifest path must be non-empty")
  }
  if (config.manifest?.signer !== undefined && typeof config.manifest.signer !== "function") {
    throw new Error("route assurance: manifest signer must be a function")
  }
  if (config.invariants !== undefined && typeof config.invariants.executor !== "function") {
    throw new Error("route assurance: invariant executor must be a function")
  }
  if (config.rulePacks !== undefined) {
    if (!Array.isArray(config.rulePacks))
      throw new TypeError("route assurance: rulePacks must be an array")
    const names = new Set<string>()
    for (const pack of config.rulePacks) {
      if (typeof pack.name !== "string" || pack.name.trim() === "")
        throw new TypeError("route assurance: rule pack name must be non-empty")
      if (names.has(pack.name)) throw new Error(`route assurance: duplicate rule pack ${pack.name}`)
      names.add(pack.name)
      if (!Array.isArray(pack.rules))
        throw new TypeError(`route assurance: invalid rules in ${pack.name}`)
    }
  }
  if (config.assureSink !== undefined) {
    if (
      typeof config.assureSink !== "object" ||
      config.assureSink === null ||
      Array.isArray(config.assureSink)
    )
      throw new TypeError("route assurance: assureSink must be an object")
    const record = Object.fromEntries(Object.entries(config.assureSink))
    if (typeof record.record !== "function")
      throw new TypeError("route assurance: assureSink.record must be a function")
  }
  if (config.idempotency !== undefined) {
    if (!Array.isArray(config.idempotency))
      throw new TypeError("route assurance: idempotency must be an array")
    for (const workload of config.idempotency) {
      if (
        typeof workload.name !== "string" ||
        workload.name.trim() === "" ||
        typeof workload.run !== "function"
      )
        throw new TypeError("route assurance: idempotency workloads require name and run")
    }
  }
  if (config.size !== undefined) {
    if (typeof config.size !== "object" || config.size === null || Array.isArray(config.size))
      throw new TypeError("route assurance: size must be an object")
    for (const [name, value] of Object.entries(config.size)) {
      if (name !== "outDir" && name !== "maxBytes" && name !== "maxGzipBytes")
        throw new TypeError(`route assurance: unknown size key ${name}`)
      if (name === "outDir" && typeof value !== "string")
        throw new TypeError("route assurance: size.outDir must be a string")
      if (
        (name === "maxBytes" || name === "maxGzipBytes") &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      )
        throw new TypeError(`route assurance: size.${name} must be a non-negative number`)
    }
  }
  const policy = defineAssurancePolicy(config.policy)
  const capabilities =
    config.capabilities !== undefined ? defineCapabilityPolicy(config.capabilities) : undefined
  // An `access`/`zone` selector is resolved through the capability definitions. Without them it can
  // only ever match nothing, and a rule that matches nothing does not fail - the route falls past it
  // to whatever laxer rule comes next. Refuse the config here rather than ship a policy whose
  // strictest rule is inert.
  const needDefinitions = rulesNeedingDefinitions(policy)
  if (needDefinitions.length > 0 && (capabilities?.definitions.length ?? 0) === 0) {
    throw new Error(
      `route assurance: rule(s) ${needDefinitions
        .map((name) => JSON.stringify(name))
        .join(
          ", ",
        )} select on ${CLASS_SELECTOR_KEYS.join("/")}, which needs capability definitions - add a \`capabilities\` policy defining the tokens your routes declare`,
    )
  }
  return Object.freeze({
    source: config.source,
    policy,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(config.manifest !== undefined
      ? {
          manifest: Object.freeze({
            ...(config.manifest.path !== undefined ? { path: config.manifest.path } : {}),
            ...(config.manifest.signer !== undefined ? { signer: config.manifest.signer } : {}),
          }),
        }
      : {}),
    ...(config.invariants !== undefined
      ? { invariants: Object.freeze({ executor: config.invariants.executor }) }
      : {}),
    ...(config.rulePacks !== undefined ? { rulePacks: Object.freeze([...config.rulePacks]) } : {}),
    ...(config.assureSink !== undefined ? { assureSink: config.assureSink } : {}),
    ...(config.idempotency !== undefined
      ? { idempotency: Object.freeze([...config.idempotency]) }
      : {}),
    ...(config.size !== undefined ? { size: Object.freeze({ ...config.size }) } : {}),
  })
}

/**
 * Shared selector semantics for policy rules and framework adapters.
 *
 * `definitions` is only consulted by the `access`/`zone` selectors; every other selector reads
 * reflection alone. A caller that omits it while the selector needs it gets no match, so callers that
 * accept user policy must reject that combination up front - `defineAssuranceConfig` does.
 */
/**
 * The effective transport body policy a `bodyLimit` selector matches on. A route that named no limit
 * reports `"unset"` (it inherits the server default, which a policy that cares about explicit caps
 * should treat distinctly); a finite number is `"bounded"`; the streaming/upload exemption is
 * `"unlimited"`. Kept total so a future `bodyLimit` shape cannot fall through to a silent match.
 */
function effectiveBodyLimit(schema: ReflectedRoute["schema"]): "bounded" | "unlimited" | "unset" {
  const limit = schema?.bodyLimit
  if (limit === "unlimited") return "unlimited"
  if (typeof limit === "number") return "bounded"
  return "unset"
}

export function matchesAssuranceSelector(
  route: Pick<
    ReflectedRoute,
    "method" | "path" | "tool" | "capabilities" | "classification" | "schema"
  >,
  selector: AssuranceRouteSelector,
  definitions?: ReadonlyMap<string, CapabilityDefinition>,
): boolean {
  const { methods, paths, tools, capabilities, access, zone, classificationAtLeast } = selector
  const { hasBody, bodyLimit } = selector
  if (methods !== undefined && !methods.includes(route.method as Method)) return false
  if (paths !== undefined && !paths.some((pattern) => routeGlob(pattern).test(route.path)))
    return false
  if (tools !== undefined && (route.tool !== undefined) !== tools) return false
  if (hasBody !== undefined && (route.schema?.body !== undefined) !== hasBody) return false
  if (bodyLimit !== undefined && effectiveBodyLimit(route.schema) !== bodyLimit) return false
  if (
    classificationAtLeast !== undefined &&
    (route.classification === undefined ||
      !isClassificationAtLeast(route.classification.max, classificationAtLeast))
  )
    return false
  const declared = route.capabilities ?? []
  if (capabilities !== undefined && !capabilities.some((token) => declared.includes(token)))
    return false
  if (access !== undefined || zone !== undefined) {
    // Both constraints must hold for the SAME capability: a route that reads the database and writes
    // an audit log must not satisfy "writes business state" by combining halves of two tokens.
    const matched = declared.some((token) => {
      const definition = definitions?.get(token)
      if (definition === undefined) return false
      if (access !== undefined && definition.access !== access) return false
      if (zone !== undefined && definition.zone !== zone) return false
      return true
    })
    if (!matched) return false
  }
  return true
}

/** Evaluate reflected route evidence against the first matching policy rule. */
export function evaluateRouteAssurance(
  source: unknown,
  policyInput: AssurancePolicy,
  options?: AssuranceEvaluationOptions,
): AssuranceReport {
  const policy = defineAssurancePolicy(policyInput)
  const definitions = definitionMap(options?.definitions)
  // Same reasoning as `defineAssuranceConfig`, repeated for callers that evaluate a bare policy: a
  // class selector with nothing to resolve against is an inert rule, not a lenient one.
  const needDefinitions = rulesNeedingDefinitions(policy)
  if (needDefinitions.length > 0 && definitions.size === 0) {
    throw new Error(
      `route assurance: rule(s) ${needDefinitions
        .map((name) => JSON.stringify(name))
        .join(
          ", ",
        )} select on ${CLASS_SELECTOR_KEYS.join("/")} but no capability definitions were supplied`,
    )
  }
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
    const rule = policy.rules.find((candidate) =>
      matchesAssuranceSelector(route, candidate.match, definitions),
    )
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

    const requiredProvenance = rule.requireProvenance ?? "any"
    let missing = (rule.require ?? []).filter((id) => {
      if (!evidenceIds.has(id)) return true
      if (requiredProvenance === "any") return false
      return !evidence.some(
        (item) => item.id === id && evidenceProvenance(item) === requiredProvenance,
      )
    })
    const forbidden = (rule.forbid ?? []).filter((id) => evidenceIds.has(id))
    if (
      rule.requireCsrfWithAuthenticated === true &&
      evidenceIds.has(NIFRA_ASSURANCE_IDS.AUTHENTICATED) &&
      !evidence.some(
        (item) => item.id === NIFRA_ASSURANCE_IDS.CSRF && evidenceProvenance(item) === "runtime",
      )
    ) {
      const id = NIFRA_ASSURANCE_IDS.CSRF
      if (!missing.includes(id)) missing = [...missing, id]
    }
    for (const id of missing) {
      findings.push({
        code: "missing-evidence",
        method: route.method,
        path: route.path,
        rule: rule.name,
        evidence: id,
        message:
          requiredProvenance === "any"
            ? `${route.method} ${route.path} (${rule.name}) is missing ${id}`
            : `${route.method} ${route.path} (${rule.name}) is missing ${requiredProvenance} evidence for ${id}`,
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
    // Opt-in visibility: a pure-classification rule (no require + no forbid) matching a route with zero
    // evidence is a "label without proof". Surface it so the gap isn't silently green. A rule that expects
    // or forbids evidence already speaks for itself via the loops above, so it's excluded here.
    if (
      policy.flagClassifiedWithoutEvidence === true &&
      evidence.length === 0 &&
      (rule.require ?? []).length === 0 &&
      (rule.forbid ?? []).length === 0
    ) {
      findings.push({
        code: "classified-no-evidence",
        method: route.method,
        path: route.path,
        rule: rule.name,
        message: `${route.method} ${route.path} (${rule.name}) is classified but carries no enforcement evidence`,
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
