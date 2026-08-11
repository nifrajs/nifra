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
  /** Optional static source locations keyed by `${METHOD}\n${path}`. */
  readonly sourceLocations?: ReadonlyMap<string, readonly ProjectEvidenceSourceLocation[]>
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

/** Build the canonical snapshot from reflection and already-evaluated offline reports. */
export function snapshotProjectEvidence(
  source: unknown,
  options: ProjectEvidenceOptions = {},
): ProjectEvidenceSnapshot {
  const locations = options.sourceLocations
  const assurance = assuranceOf(options.assurance)
  const capabilities = capabilitiesOf(options.capabilities)
  const routes = sortByRoute(
    // Importantly, this is the only reflection pass for this snapshot. Every projection can consume
    // the result instead of independently asking the app for `.routes()` and re-shaping schemas.
    reflectRoutes(source).map((route) =>
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
