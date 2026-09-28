/**
 * Canonical, token-only project evidence.
 *
 * This is the offline seam shared by agent views and deploy artifacts. It deliberately contains
 * route contracts, assurance/capability decisions, and source locations only; validators, handlers,
 * request bodies, secrets, and other runtime payloads never cross this interface.
 */

import type { AssuranceEvidence, AssuranceFinding, AssuranceReport } from "./assurance.ts"
import type {
  AssuredCapabilityRoute,
  CapabilityAssuranceReport,
  CapabilityEvidence,
  CapabilityFinding,
} from "./capabilities.ts"
import type { ResponseClassification } from "./classification.ts"
import { evidenceProvenance } from "./internal/route-assurance.ts"
import {
  type JsonSchema,
  type ReflectedRoute,
  type ReflectedSchemaField,
  reflectRoutes,
  type SchemaReflection,
} from "./reflection.ts"

export interface ProjectEvidenceSchemaPart {
  readonly jsonSchema?: JsonSchema
  readonly fields?: readonly ReflectedSchemaField[]
}

export interface ProjectEvidenceSchema {
  readonly bodyLimit?: number | "unlimited"
  readonly bodyLimitReason?: string
  readonly headers?: ProjectEvidenceSchemaPart
  readonly body?: ProjectEvidenceSchemaPart
  readonly query?: ProjectEvidenceSchemaPart
  readonly params?: ProjectEvidenceSchemaPart
  readonly response?: ProjectEvidenceSchemaPart
  readonly errors?: Readonly<Record<string, ProjectEvidenceSchemaPart>>
  readonly sse?: ProjectEvidenceSchemaPart
}

export interface ProjectEvidenceSourceLocation {
  readonly file: string
  readonly line?: number
  readonly column?: number
}

export interface ProjectEvidenceRoute {
  readonly method: string
  readonly path: string
  readonly schema?: ProjectEvidenceSchema
  readonly responseContract?: "warn" | "enforce"
  readonly assurance?: readonly AssuranceEvidence[]
  readonly capabilities?: readonly string[]
  readonly family?: boolean
  readonly classification?: ResponseClassification
  readonly tool?: ReflectedRoute["tool"]
  readonly source?: readonly ProjectEvidenceSourceLocation[]
}

export interface ProjectEvidenceAssuranceRoute {
  readonly method: string
  readonly path: string
  readonly rule?: string
  readonly evidence: readonly AssuranceEvidence[]
  readonly missing: readonly string[]
  readonly forbidden: readonly string[]
}

export interface ProjectEvidenceAssurance {
  readonly ok: boolean
  readonly routes: readonly ProjectEvidenceAssuranceRoute[]
  readonly findings: readonly AssuranceFinding[]
}

export interface ProjectEvidenceCapabilityRoute {
  readonly method: string
  readonly path: string
  readonly declared: readonly string[]
  readonly evidence: readonly CapabilityEvidence[]
  readonly unproven: readonly string[]
  readonly covered: boolean
  readonly classification?: AssuredCapabilityRoute["classification"]
}

export interface ProjectEvidenceCapabilities {
  readonly ok: boolean
  readonly routes: readonly ProjectEvidenceCapabilityRoute[]
  readonly findings: readonly CapabilityFinding[]
}

/** One deterministic, persistence-safe view of a project's public and trust-relevant facts. */
export interface ProjectEvidenceSnapshot {
  readonly version: 1
  readonly routes: readonly ProjectEvidenceRoute[]
  readonly assurance?: ProjectEvidenceAssurance
  readonly capabilities?: ProjectEvidenceCapabilities
}

export interface ProjectEvidenceOptions {
  readonly assurance?: AssuranceReport
  readonly capabilities?: CapabilityAssuranceReport
  /**
   * An existing reflection pass. Supplying it lets several offline projections share one pass
   * without asking the runtime source for `.routes()` again. Validators are consumed only while
   * building the token-only snapshot and never cross this seam.
   */
  readonly routes?: readonly ReflectedRoute[]
  /** Optional static source locations keyed by `${METHOD}\n${path}`. */
  readonly sourceLocations?: ReadonlyMap<string, readonly ProjectEvidenceSourceLocation[]>
}

/** One token-only evidence snapshot in a composed application surface. */
export interface ProjectEvidenceCompositionPart {
  readonly evidence: ProjectEvidenceSnapshot
  /** Public pathname prefix to add when the child receives a stripped mount request. */
  readonly pathPrefix?: string
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

function schemaPart(value: SchemaReflection | undefined): ProjectEvidenceSchemaPart | undefined {
  if (value === undefined) return undefined
  return Object.freeze({
    ...(value.jsonSchema !== undefined ? { jsonSchema: value.jsonSchema } : {}),
    ...(value.fields !== undefined ? { fields: Object.freeze([...value.fields]) } : {}),
  })
}

function schemaOf(route: ReflectedRoute): ProjectEvidenceSchema | undefined {
  const source = route.schema
  if (source === undefined) return undefined
  const headers = schemaPart(source.headers)
  const body = schemaPart(source.body)
  const query = schemaPart(source.query)
  const params = schemaPart(source.params)
  const response = schemaPart(source.response)
  const sse = schemaPart(source.sse)
  const errors: Record<string, ProjectEvidenceSchemaPart> = {}
  for (const [status, value] of Object.entries(source.errors ?? {})) {
    const part = schemaPart(value)
    if (part !== undefined) errors[status] = part
  }
  const schema: ProjectEvidenceSchema = {
    ...(source.bodyLimit !== undefined ? { bodyLimit: source.bodyLimit } : {}),
    ...(source.bodyLimitReason !== undefined ? { bodyLimitReason: source.bodyLimitReason } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(params !== undefined ? { params } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(Object.keys(errors).length > 0 ? { errors: Object.freeze(errors) } : {}),
    ...(sse !== undefined ? { sse } : {}),
  }
  return Object.freeze(schema)
}

const keyOf = (method: string, path: string): string => `${method.toUpperCase()}\n${path}`

function assuranceEvidenceOf(values: readonly AssuranceEvidence[]): readonly AssuranceEvidence[] {
  return Object.freeze(
    values
      .map((item) =>
        Object.freeze({
          id: item.id,
          source: item.source,
          provenance: evidenceProvenance(item),
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source)),
  )
}

function capabilityEvidenceOf(
  values: readonly CapabilityEvidence[],
): readonly CapabilityEvidence[] {
  return Object.freeze(
    [...values]
      .map((item) => Object.freeze({ id: item.id, kind: item.kind, source: item.source }))
      .sort(
        (a, b) =>
          a.id.localeCompare(b.id) ||
          a.kind.localeCompare(b.kind) ||
          a.source.localeCompare(b.source),
      ),
  )
}

const sortByRoute = <T extends { readonly method: string; readonly path: string }>(
  values: readonly T[],
): readonly T[] =>
  Object.freeze(
    [...values].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
  )

function evidenceRouteOf(
  route: ReflectedRoute,
  locations: readonly ProjectEvidenceSourceLocation[] | undefined,
): ProjectEvidenceRoute {
  const schema = schemaOf(route)
  return Object.freeze({
    method: route.method.toUpperCase(),
    path: route.path,
    ...(schema !== undefined ? { schema } : {}),
    ...(route.responseContract === undefined ? {} : { responseContract: route.responseContract }),
    ...(route.assurance !== undefined ? { assurance: assuranceEvidenceOf(route.assurance) } : {}),
    ...(route.capabilities !== undefined
      ? { capabilities: Object.freeze([...route.capabilities].sort()) }
      : {}),
    ...(route.family === true ? { family: true } : {}),
    ...(route.classification !== undefined ? { classification: route.classification } : {}),
    ...(route.tool !== undefined ? { tool: route.tool } : {}),
    ...(locations !== undefined && locations.length > 0
      ? { source: Object.freeze([...locations]) }
      : {}),
  })
}

function assuranceOf(report: AssuranceReport | undefined): ProjectEvidenceAssurance | undefined {
  if (report === undefined) return undefined
  return Object.freeze({
    ok: report.ok,
    routes: sortByRoute(
      report.routes.map((route) =>
        Object.freeze({
          method: route.method,
          path: route.path,
          ...(route.rule !== undefined ? { rule: route.rule } : {}),
          evidence: assuranceEvidenceOf(route.evidence),
          missing: Object.freeze([...route.missing].sort()),
          forbidden: Object.freeze([...route.forbidden].sort()),
        }),
      ),
    ),
    findings: Object.freeze(
      [...report.findings].sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.method.localeCompare(b.method) ||
          a.code.localeCompare(b.code),
      ),
    ),
  })
}

function capabilitiesOf(
  report: CapabilityAssuranceReport | undefined,
): ProjectEvidenceCapabilities | undefined {
  if (report === undefined) return undefined
  return Object.freeze({
    ok: report.ok,
    routes: sortByRoute(
      report.routes.map((route) =>
        Object.freeze({
          method: route.method,
          path: route.path,
          declared: Object.freeze([...route.declared].sort()),
          evidence: capabilityEvidenceOf(route.evidence),
          unproven: Object.freeze([...route.unproven].sort()),
          covered: route.covered,
          ...(route.classification !== undefined ? { classification: route.classification } : {}),
        }),
      ),
    ),
    findings: Object.freeze(
      [...report.findings].sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.method.localeCompare(b.method) ||
          a.code.localeCompare(b.code),
      ),
    ),
  })
}

const composedPath = (prefix: string, path: string): string => {
  if (path === "*") return path
  if (!path.startsWith("/"))
    throw new TypeError(`project evidence: route path must start with "/": ${path}`)
  if (prefix === "") return path
  if (!prefix.startsWith("/")) {
    throw new TypeError(`project evidence: path prefix must start with "/": ${prefix}`)
  }
  const normalized = prefix === "/" ? "" : prefix.replace(/\/+$/, "")
  return normalized === "" ? path : path === "/" ? normalized : `${normalized}${path}`
}

function remapEvidenceSnapshot(
  evidence: ProjectEvidenceSnapshot,
  pathPrefix: string,
): ProjectEvidenceSnapshot {
  if (evidence.version !== 1) throw new Error("project evidence: unsupported snapshot version")
  const route = (
    method: string,
    path: string,
  ): { readonly method: string; readonly path: string } => ({
    method: method.toUpperCase(),
    path: composedPath(pathPrefix, path),
  })
  const routes = evidence.routes.map((item) => {
    const key = route(item.method, item.path)
    return Object.freeze({ ...item, ...key })
  })
  const assurance =
    evidence.assurance === undefined
      ? undefined
      : Object.freeze({
          ok: evidence.assurance.ok,
          routes: Object.freeze(
            evidence.assurance.routes.map((item) =>
              Object.freeze({ ...item, ...route(item.method, item.path) }),
            ),
          ),
          findings: Object.freeze(
            evidence.assurance.findings.map((item) =>
              Object.freeze({ ...item, ...route(item.method, item.path) }),
            ),
          ),
        })
  const capabilities =
    evidence.capabilities === undefined
      ? undefined
      : Object.freeze({
          ok: evidence.capabilities.ok,
          routes: Object.freeze(
            evidence.capabilities.routes.map((item) =>
              Object.freeze({ ...item, ...route(item.method, item.path) }),
            ),
          ),
          findings: Object.freeze(
            evidence.capabilities.findings.map((item) =>
              Object.freeze({ ...item, ...route(item.method, item.path) }),
            ),
          ),
        })
  return Object.freeze({
    version: 1,
    routes: Object.freeze(routes),
    ...(assurance === undefined ? {} : { assurance }),
    ...(capabilities === undefined ? {} : { capabilities }),
  })
}

function routeKeyForEvidence(method: string, path: string): string {
  return `${method.toUpperCase()}\n${path}`
}

function validateComposedReportRoutes(
  report: ProjectEvidenceAssurance | ProjectEvidenceCapabilities,
  routeKeys: ReadonlySet<string>,
  kind: "assurance" | "capabilities",
): void {
  for (const route of report.routes) {
    if (!routeKeys.has(routeKeyForEvidence(route.method, route.path))) {
      throw new Error(
        `project evidence: ${kind} route ${route.method} ${route.path} is not present in the composed route set`,
      )
    }
  }
}

/**
 * Compose page and mounted-app evidence into one deterministic snapshot.
 *
 * This is an offline operation. It carries route contracts, assurance/capability tokens, and source
 * locations only; it never invokes handlers or copies request/business data. A duplicate public
 * method+path or a report that no longer describes a composed route is rejected rather than silently
 * dropping one side of the trust boundary.
 */
export function composeProjectEvidence(
  parts: readonly ProjectEvidenceCompositionPart[],
): ProjectEvidenceSnapshot {
  const routes: ProjectEvidenceRoute[] = []
  const routeKeys = new Set<string>()
  const assuranceReports: ProjectEvidenceAssurance[] = []
  const capabilityReports: ProjectEvidenceCapabilities[] = []

  for (const part of parts) {
    const prefix = part.pathPrefix ?? ""
    const mapped = remapEvidenceSnapshot(part.evidence, prefix)
    for (const route of mapped.routes) {
      const key = routeKeyForEvidence(route.method, route.path)
      if (routeKeys.has(key)) {
        throw new Error(`project evidence: duplicate composed route ${route.method} ${route.path}`)
      }
      routeKeys.add(key)
      routes.push(route)
    }
    if (mapped.assurance !== undefined) assuranceReports.push(mapped.assurance)
    if (mapped.capabilities !== undefined) capabilityReports.push(mapped.capabilities)
  }

  const assurance =
    assuranceReports.length === 0
      ? undefined
      : Object.freeze({
          ok: assuranceReports.every((report) => report.ok),
          routes: sortByRoute(assuranceReports.flatMap((report) => report.routes)),
          findings: Object.freeze(
            assuranceReports
              .flatMap((report) => report.findings)
              .sort(
                (a, b) =>
                  a.path.localeCompare(b.path) ||
                  a.method.localeCompare(b.method) ||
                  a.code.localeCompare(b.code),
              ),
          ),
        })
  const capabilities =
    capabilityReports.length === 0
      ? undefined
      : Object.freeze({
          ok: capabilityReports.every((report) => report.ok),
          routes: sortByRoute(capabilityReports.flatMap((report) => report.routes)),
          findings: Object.freeze(
            capabilityReports
              .flatMap((report) => report.findings)
              .sort(
                (a, b) =>
                  a.path.localeCompare(b.path) ||
                  a.method.localeCompare(b.method) ||
                  a.code.localeCompare(b.code),
              ),
          ),
        })
  if (assurance !== undefined) validateComposedReportRoutes(assurance, routeKeys, "assurance")
  if (capabilities !== undefined)
    validateComposedReportRoutes(capabilities, routeKeys, "capabilities")

  return Object.freeze({
    version: 1,
    routes: sortByRoute(routes),
    ...(assurance === undefined ? {} : { assurance }),
    ...(capabilities === undefined ? {} : { capabilities }),
  })
}

function schemaPartToReflection(
  value: ProjectEvidenceSchemaPart | undefined,
): SchemaReflection | undefined {
  return value === undefined
    ? undefined
    : { standard: undefined, jsonSchema: value.jsonSchema, fields: value.fields }
}

function schemaFromEvidence(schema: ProjectEvidenceSchema | undefined): ReflectedRoute["schema"] {
  if (schema === undefined) return undefined
  const errors = Object.fromEntries(
    Object.entries(schema.errors ?? {}).map(([status, value]) => [
      status,
      schemaPartToReflection(value) as SchemaReflection,
    ]),
  )
  const headers = schemaPartToReflection(schema.headers)
  const body = schemaPartToReflection(schema.body)
  const query = schemaPartToReflection(schema.query)
  const params = schemaPartToReflection(schema.params)
  const response = schemaPartToReflection(schema.response)
  const sse = schemaPartToReflection(schema.sse)
  return {
    ...(schema.bodyLimit !== undefined ? { bodyLimit: schema.bodyLimit } : {}),
    ...(schema.bodyLimitReason !== undefined ? { bodyLimitReason: schema.bodyLimitReason } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(params !== undefined ? { params } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
    ...(sse !== undefined ? { sse } : {}),
  }
}

/**
 * Adapt the canonical token-only snapshot to the runtime-reflection shape used by projections.
 * The returned schemas deliberately have no `standard` validator: this adapter is for offline
 * contract views, not request validation or mock generation.
 */
export function reflectedRoutesFromEvidence(
  evidence: ProjectEvidenceSnapshot,
): readonly ReflectedRoute[] {
  if (evidence.version !== 1) throw new Error("project evidence: unsupported snapshot version")
  return evidence.routes.map((route) => {
    const schema = schemaFromEvidence(route.schema)
    return {
      method: route.method,
      path: route.path,
      ...(schema !== undefined ? { schema } : {}),
      ...(route.responseContract === undefined ? {} : { responseContract: route.responseContract }),
      ...(route.assurance !== undefined ? { assurance: route.assurance } : {}),
      ...(route.capabilities !== undefined ? { capabilities: route.capabilities } : {}),
      ...(route.family === true ? { family: true } : {}),
      ...(route.classification !== undefined ? { classification: route.classification } : {}),
      ...(route.tool !== undefined ? { tool: route.tool } : {}),
    }
  })
}

/** Build the canonical snapshot from reflection and already-evaluated offline reports. */
export function snapshotProjectEvidence(
  source: unknown,
  options: ProjectEvidenceOptions = {},
): ProjectEvidenceSnapshot {
  const locations = options.sourceLocations
  const assurance = assuranceOf(options.assurance)
  const capabilities = capabilitiesOf(options.capabilities)
  const reflected = options.routes ?? reflectRoutes(source)
  const routes = sortByRoute(
    // Importantly, this is the only reflection pass for this snapshot. Every projection can consume
    // the result instead of independently asking the app for `.routes()` and re-shaping schemas.
    reflected.map((route) =>
      evidenceRouteOf(route, locations?.get(keyOf(route.method, route.path))),
    ),
  )
  return Object.freeze({
    version: 1,
    routes,
    ...(assurance !== undefined ? { assurance } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  })
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("project evidence cannot encode non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(",")}]`
  const record = recordOf(value)
  if (record !== undefined) {
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(",")}}`
  }
  throw new TypeError(`project evidence cannot encode ${typeof value}`)
}

/** Stable JSON for logs, MCP, generated artifacts, and snapshot tests. */
export function serializeProjectEvidence(snapshot: ProjectEvidenceSnapshot): string {
  return canonicalValue(snapshot)
}

/** SHA-256 of the canonical snapshot, useful as a cheap freshness/reference token. */
export async function digestProjectEvidence(snapshot: ProjectEvidenceSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(serializeProjectEvidence(snapshot))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
