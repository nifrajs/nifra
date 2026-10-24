import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import {
  type ProjectEvidenceSnapshot,
  reflectedRoutesFromEvidence,
  snapshotProjectEvidence,
} from "@nifrajs/core/evidence"
import type { ReflectedRoute, SchemaReflection } from "@nifrajs/core/reflection"
import { BACKEND_APP_FILE } from "./app-files.ts"
import { codeUnitOrder } from "./internal/code-unit-order.ts"

/** One declared part of a route's contract: `body`, `query`, `params`, `headers`, `cookies`,
 * `response`, `sse` or `errors.<status>`. */
export interface ContractPart {
  /** Hash of the part's schema, or `null` where it is declared in a form nifra cannot read. */
  readonly digest: string | null
  /** The type of each top-level field, `name?` for an optional one, when the schema is an object. */
  readonly fields?: Readonly<Record<string, string>>
}

export interface ContractDigest {
  readonly request: string
  readonly response: string
  /** Each part the route declares. Absent in a lock written before parts were recorded: such a lock
   * compares by side, and never covered headers or cookies. */
  readonly parts?: Readonly<Record<string, ContractPart>>
}

export interface ContractsLock {
  readonly version: 1
  /** The {@link CONTRACT_DIGEST_FORMAT} that produced `routes`. Absent in a lock written before it was recorded. */
  readonly digest?: number
  readonly routes: Readonly<Record<string, ContractDigest>>
}

/**
 * Bumped whenever {@link digestRoute} hashes the same schema differently. The lock records it, so a
 * format change reads as "re-snapshot" instead of as drift on every route. 2: properties named like
 * annotation keywords are hashed (4.0.1).
 */
export const CONTRACT_DIGEST_FORMAT = 2

export const DEFAULT_CONTRACTS_LOCK = "contracts.lock.json"
const DIGEST = /^[a-f0-9]{64}$/

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

/** Annotation keywords: editing one is not a contract change. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "default",
  "example",
  "examples",
])
/** Keywords whose value maps user-chosen names to schemas, so a key there is a name, never a keyword. */
const NAME_MAPS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
])
/** Keywords whose value is instance data, compared whole. */
const DATA: ReadonlySet<string> = new Set(["const", "enum"])

function sortedRecord(
  record: Record<string, unknown>,
  entry: (name: string, item: unknown) => unknown,
): Record<string, unknown> {
  const entries: Array<[string, unknown]> = []
  for (const name of Object.keys(record).sort()) {
    const item = entry(name, record[name])
    if (item !== undefined) entries.push([name, item])
  }
  // `fromEntries` defines each key, where an assignment would run the `__proto__` setter instead.
  return Object.fromEntries(entries)
}

function canonicalData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalData(item))
  const record = recordOf(value)
  return record === undefined ? value : sortedRecord(record, (_name, item) => canonicalData(item))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item))
  const record = recordOf(value)
  if (record === undefined) return value
  return sortedRecord(record, (name, item) => {
    if (ANNOTATIONS.has(name)) return undefined
    if (DATA.has(name)) return canonicalData(item)
    const names = NAME_MAPS.has(name) ? recordOf(item) : undefined
    return names === undefined
      ? canonical(item)
      : sortedRecord(names, (_key, schema) => canonical(schema))
  })
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("")
}

function schemaValue(schema: ReflectedRoute["schema"], side: "request" | "response"): unknown {
  if (schema === undefined) return {}
  if (side === "request") {
    return {
      body: schema.body?.jsonSchema ?? schema.body?.fields ?? null,
      query: schema.query?.jsonSchema ?? schema.query?.fields ?? null,
      params: schema.params?.jsonSchema ?? schema.params?.fields ?? null,
    }
  }
  return {
    response: schema.response?.jsonSchema ?? schema.response?.fields ?? null,
    sse: schema.sse?.jsonSchema ?? schema.sse?.fields ?? null,
    errors: Object.fromEntries(
      Object.entries(schema.errors ?? {}).map(([status, value]) => [
        status,
        value.jsonSchema ?? value.fields ?? null,
      ]),
    ),
  }
}

export async function digestRoute(route: ReflectedRoute): Promise<ContractDigest> {
  const request = JSON.stringify(canonical(schemaValue(route.schema, "request")))
  const response = JSON.stringify(canonical(schemaValue(route.schema, "response")))
  return { request: await sha256(request), response: await sha256(response) }
}

/** The digest a route with NO declared schema produces on both sides - `sha256("{}")`. A lock whose
 * every route hashes to this is guarding nothing: drift detection can only ever compare empty schema to
 * empty schema. Computed through the same canonical/stringify path as {@link digestRoute} so it tracks
 * that path rather than a hard-coded literal. */
export async function emptySchemaDigest(): Promise<string> {
  return sha256(JSON.stringify(canonical(schemaValue(undefined, "request"))))
}

const PART_ORDER = ["body", "query", "params", "headers", "cookies", "response", "sse"] as const
const REQUEST_PARTS: ReadonlySet<string> = new Set([
  "body",
  "query",
  "params",
  "headers",
  "cookies",
])
const sideOf = (part: string): "request" | "response" =>
  REQUEST_PARTS.has(part) ? "request" : "response"

function partRank(part: string): number {
  const at = PART_ORDER.findIndex((name) => name === part)
  return at === -1 ? PART_ORDER.length : at
}

const partOrder = (a: string, b: string): number => partRank(a) - partRank(b) || codeUnitOrder(a, b)

function declaredParts(schema: ReflectedRoute["schema"]): Array<[string, SchemaReflection]> {
  if (schema === undefined) return []
  const parts: Array<[string, SchemaReflection]> = []
  for (const part of PART_ORDER) {
    const value = schema[part]
    if (value !== undefined) parts.push([part, value])
  }
  for (const [status, value] of Object.entries(schema.errors ?? {}))
    parts.push([`errors.${status}`, value])
  return parts.sort(([a], [b]) => partOrder(a, b))
}

const MAX_ENUM_LABEL = 6

/** A short type name for one field schema, for the lock and a check message to show. */
function typeLabel(schema: unknown): string {
  if (schema === true) return "unknown"
  if (schema === false) return "never"
  const record = recordOf(schema)
  if (record === undefined) return "unknown"
  if (Object.hasOwn(record, "const")) return JSON.stringify(record.const) ?? "unknown"
  const values = record.enum
  if (Array.isArray(values))
    return values.length > MAX_ENUM_LABEL
      ? `enum(${values.length})`
      : values.map((value) => JSON.stringify(value)).join(" | ")
  const union = record.anyOf ?? record.oneOf
  if (Array.isArray(union)) return union.map((item) => typeLabel(item)).join(" | ")
  const ref = record.$ref
  if (typeof ref === "string") return ref.slice(ref.lastIndexOf("/") + 1)
  const type = record.type
  const types = Array.isArray(type) ? type : [type]
  const labels: string[] = []
  for (const name of types) {
    if (typeof name !== "string") continue
    if (name !== "array") labels.push(name)
    else {
      const item = typeLabel(record.items)
      labels.push(item.includes(" | ") ? `(${item})[]` : `${item}[]`)
    }
  }
  return labels.length === 0 ? "unknown" : labels.join(" | ")
}

/** Each part `route` declares, hashed alone, with its top-level fields. */
export async function contractParts(route: ReflectedRoute): Promise<Record<string, ContractPart>> {
  const entries = await Promise.all(
    declaredParts(route.schema).map(async ([part, value]): Promise<[string, ContractPart]> => {
      const schema = value.jsonSchema ?? value.fields
      if (schema === undefined) return [part, { digest: null }]
      const digest = await sha256(JSON.stringify(canonical(schema)))
      if (value.fields === undefined) return [part, { digest }]
      const fields = value.fields
        .map((field): [string, string] => [
          field.required ? field.name : `${field.name}?`,
          typeLabel(field.schema),
        ])
        .sort(([a], [b]) => codeUnitOrder(a, b))
      return [part, { digest, fields: Object.fromEntries(fields) }]
    }),
  )
  return Object.fromEntries(entries)
}

/** Per side, the digests of a route whose schema says nothing on that side: none declared, or every
 * part declared in a form reflection cannot read (hashed as `null`). A lock entry holding one never
 * guarded that side. */
async function blindDigests(): Promise<Record<"request" | "response", ReadonlySet<string>>> {
  const of = async (side: "request" | "response") =>
    new Set([
      await sha256(JSON.stringify(canonical(schemaValue(undefined, side)))),
      await sha256(JSON.stringify(canonical(schemaValue({}, side)))),
    ])
  return { request: await of("request"), response: await of("response") }
}

const unread = (value: SchemaReflection | undefined): boolean =>
  value !== undefined && value.jsonSchema === undefined && value.fields === undefined

/** The parts of `route` that declare a schema reflection cannot read: hashed as `null`, as if absent,
 * so the lock never notices a change to them. */
export function unreflectedParts(route: ReflectedRoute): string[] {
  const schema = route.schema
  if (schema === undefined) return []
  const parts: string[] = []
  for (const part of PART_ORDER) if (unread(schema[part])) parts.push(part)
  for (const [status, value] of Object.entries(schema.errors ?? {}))
    if (unread(value)) parts.push(`errors.${status}`)
  return parts
}

/** Whether every route in `lock` hashes to the empty-schema digest (so no route declares a schema). An
 * empty `routes` map is NOT vacuous in this sense - there is no route whose contract went unguarded. */
export async function isVacuousLock(lock: ContractsLock): Promise<boolean> {
  const digests = Object.values(lock.routes)
  if (digests.length === 0) return false
  const empty = await emptySchemaDigest()
  return digests.every((d) => d.request === empty && d.response === empty)
}

export async function buildContractsLock(
  source: unknown,
  evidence?: ProjectEvidenceSnapshot,
): Promise<ContractsLock> {
  const reflected = reflectedRoutesFromEvidence(evidence ?? snapshotProjectEvidence(source))
  const routes = Object.fromEntries(
    await Promise.all(
      reflected.map(
        async (route) =>
          [
            `${route.method} ${route.path}`,
            { ...(await digestRoute(route)), parts: await contractParts(route) },
          ] as const,
      ),
    ),
  )
  return {
    version: 1,
    digest: CONTRACT_DIGEST_FORMAT,
    routes: Object.fromEntries(Object.entries(routes).sort(([a], [b]) => codeUnitOrder(a, b))),
  }
}

async function loadBackend(cwd: string): Promise<unknown> {
  const backendPath = resolve(cwd, BACKEND_APP_FILE)
  if (!existsSync(backendPath)) throw new Error(`[nifra] no ${BACKEND_APP_FILE} in ${cwd}`)
  const loadedValue: unknown = await import(backendPath)
  const loaded = recordOf(loadedValue)
  if (loaded?.backend === undefined)
    throw new Error(`[nifra] ${backendPath} does not export backend`)
  return loaded.backend
}

const INPUT_PARTS = ["body", "query", "headers", "cookies", "params"] as const

/**
 * A route that in-process auth guards, but through a hook that runs after its declared input is
 * validated: an unauthenticated caller reaches the body parser and reads the validation issues.
 * Gateway auth (declared provenance) never lets that caller in, and an explicit `validationOrder`
 * is the author's choice.
 */
export function validatesBeforeAuthentication(route: ReflectedRoute): boolean {
  const schema = route.schema
  if (schema === undefined || schema.validationOrder !== undefined) return false
  if (!INPUT_PARTS.some((part) => schema[part] !== undefined)) return false
  const auth = (route.assurance ?? []).filter(
    (evidence) =>
      evidence.id === NIFRA_ASSURANCE.AUTHENTICATED &&
      (evidence.provenance ?? (evidence.source === "declared" ? "declared" : "runtime")) ===
        "runtime",
  )
  return auth.length > 0 && auth.every((evidence) => evidence.source !== "nifra.authenticate")
}

/** A route whose declared schema the lock records as `null` in `parts`. */
export interface UnreflectedRoute {
  readonly route: string
  readonly parts: readonly string[]
}

export async function snapshotContracts(
  cwd: string,
  out = DEFAULT_CONTRACTS_LOCK,
): Promise<ContractsLock> {
  return (await snapshotContractsReport(cwd, out)).lock
}

/** {@link snapshotContracts}, plus each route whose declared schema the lock records as `null`. */
export async function snapshotContractsReport(
  cwd: string,
  out = DEFAULT_CONTRACTS_LOCK,
): Promise<{ lock: ContractsLock; unreflected: UnreflectedRoute[] }> {
  const evidence = snapshotProjectEvidence(await loadBackend(cwd))
  const lock = await buildContractsLock(undefined, evidence)
  await Bun.write(resolve(cwd, out), `${JSON.stringify(lock, null, 2)}\n`)
  const unreflected = reflectedRoutesFromEvidence(evidence)
    .map((route) => ({ route: `${route.method} ${route.path}`, parts: unreflectedParts(route) }))
    .filter((entry) => entry.parts.length > 0)
    .sort((a, b) => codeUnitOrder(a.route, b.route))
  return { lock, unreflected }
}

/** The lock entries of `lock` whose request or response digest says that side was never guarded. */
export async function blindLockEntries(
  lock: ContractsLock,
): Promise<Array<{ route: string; sides: Array<"request" | "response"> }>> {
  const blind = await blindDigests()
  const entries: Array<{ route: string; sides: Array<"request" | "response"> }> = []
  for (const [route, digest] of Object.entries(lock.routes)) {
    const sides = (["request", "response"] as const).filter((side) => blind[side].has(digest[side]))
    if (sides.length > 0) entries.push({ route, sides })
  }
  return entries
}

function parseFields(value: unknown): Record<string, string> | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const fields: Array<[string, string]> = []
  for (const [name, label] of Object.entries(record)) {
    if (typeof label !== "string") return undefined
    fields.push([name, label])
  }
  return Object.fromEntries(fields)
}

function parseParts(route: string, value: unknown): Record<string, ContractPart> {
  const record = recordOf(value)
  if (record === undefined) throw new TypeError(`invalid contract parts for ${route}`)
  const parts: Array<[string, ContractPart]> = []
  for (const [name, raw] of Object.entries(record)) {
    const part = recordOf(raw)
    const digest = part?.digest
    if (digest !== null && !(typeof digest === "string" && DIGEST.test(digest)))
      throw new TypeError(`invalid contract part ${name} for ${route}`)
    const fields = part?.fields === undefined ? undefined : parseFields(part.fields)
    if (part?.fields !== undefined && fields === undefined)
      throw new TypeError(`invalid contract part ${name} fields for ${route}`)
    parts.push([name, fields === undefined ? { digest } : { digest, fields }])
  }
  return Object.fromEntries(parts)
}

export function parseContractsLock(value: unknown): ContractsLock {
  const record = recordOf(value)
  if (record === undefined) throw new TypeError("contracts lock must be an object")
  const routesValue = record.routes
  const routesRecord = recordOf(routesValue)
  if (record.version !== 1 || routesRecord === undefined)
    throw new TypeError("contracts lock must have version 1 and routes")
  const digest = record.digest
  if (digest !== undefined && !(Number.isSafeInteger(digest) && Number(digest) > 0))
    throw new TypeError("contracts lock digest must be a positive integer")
  const routes: Record<string, ContractDigest> = {}
  for (const [key, raw] of Object.entries(routesRecord)) {
    const item = recordOf(raw)
    const request = item?.request
    const response = item?.response
    if (
      request === undefined ||
      typeof request !== "string" ||
      response === undefined ||
      typeof response !== "string" ||
      !DIGEST.test(request) ||
      !DIGEST.test(response)
    )
      throw new TypeError(`invalid contract ${key}`)
    const parts = item?.parts === undefined ? undefined : parseParts(key, item.parts)
    routes[key] = parts === undefined ? { request, response } : { request, response, parts }
  }
  return typeof digest === "number" ? { version: 1, digest, routes } : { version: 1, routes }
}

/** One lock mismatch. `sides` names what differs for a `changed` or `newly-covered` route, and
 * `parts` which declared parts, when the lock records them (empty when only an edited side digest
 * moved). */
export interface ContractDiagnostic {
  readonly route?: string
  readonly kind?: "added" | "removed" | "changed" | "newly-covered"
  readonly sides?: readonly ("request" | "response")[]
  readonly parts?: readonly string[]
  readonly message: string
}

const own = (record: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

/** `+ added: type, - removed: type, kept: was -> now` between two field summaries. */
function fieldChanges(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(codeUnitOrder)
  const changes: string[] = []
  for (const name of names) {
    const was = own(before, name)
    const now = own(after, name)
    if (was === now) continue
    if (was === undefined) changes.push(`+ ${name}: ${now}`)
    else if (now === undefined) changes.push(`- ${name}: ${was}`)
    else changes.push(`${name}: ${was} -> ${now}`)
  }
  return changes
}

interface PartDrift {
  readonly part: string
  /** Locked as `null` and read now: the lock never guarded it. */
  readonly uncovered: boolean
  readonly detail: string
}

function partDrift(
  before: Readonly<Record<string, ContractPart>>,
  after: Readonly<Record<string, ContractPart>>,
): PartDrift[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(partOrder)
  const drift: PartDrift[] = []
  for (const part of names) {
    const was = Object.hasOwn(before, part) ? before[part] : undefined
    const now = Object.hasOwn(after, part) ? after[part] : undefined
    if (was?.digest === now?.digest) continue
    if (was === undefined || now === undefined) {
      const added = now === undefined ? [] : fieldChanges({}, now.fields ?? {})
      drift.push({
        part,
        uncovered: false,
        detail:
          was !== undefined
            ? `${part} no longer declared`
            : now?.digest === null
              ? `${part} declared, in a form nifra cannot read`
              : `${part} ${["declared", ...added].join(", ")}`,
      })
      continue
    }
    if (was.digest === null) {
      drift.push({ part, uncovered: true, detail: part })
      continue
    }
    const fields =
      now.digest === null || was.fields === undefined || now.fields === undefined
        ? []
        : fieldChanges(was.fields, now.fields)
    drift.push({
      part,
      uncovered: false,
      detail:
        now.digest === null
          ? `${part} now in a form nifra cannot read`
          : fields.length > 0
            ? `${part} ${fields.join(", ")}`
            : was.fields !== undefined && now.fields !== undefined
              ? `${part} changed below its top-level fields`
              : `${part} changed`,
    })
  }
  return drift
}

const sidesOf = (parts: readonly string[]): Array<"request" | "response"> =>
  (["request", "response"] as const).filter((side) => parts.some((part) => sideOf(part) === side))

export async function checkContractsLock(
  cwd: string,
  file = DEFAULT_CONTRACTS_LOCK,
): Promise<{
  present: boolean
  vacuous: boolean
  diagnostics: Array<ContractDiagnostic>
  /** `METHOD /path` of every route the backend serves, read when the lock made the check load it. */
  served?: readonly string[]
  /** `METHOD /path` of each route {@link validatesBeforeAuthentication} names, read alongside `served`. */
  inputBeforeAuth?: readonly string[]
}> {
  const path = resolve(cwd, file)
  if (!existsSync(path)) return { present: false, vacuous: false, diagnostics: [] }
  const parsed = parseContractsLock(JSON.parse(await Bun.file(path).text()))
  const evidence = snapshotProjectEvidence(await loadBackend(cwd))
  const current = await buildContractsLock(undefined, evidence)
  const vacuous = await isVacuousLock(current)
  const served = Object.keys(current.routes)
  const inputBeforeAuth = reflectedRoutesFromEvidence(evidence)
    .filter(validatesBeforeAuthentication)
    .map((route) => `${route.method} ${route.path}`)
  const diagnostics: ContractDiagnostic[] = []
  // Digests of two formats never compare, so this still fails; it just names the real cause.
  if (parsed.digest !== undefined && parsed.digest !== CONTRACT_DIGEST_FORMAT) {
    const newer = parsed.digest > CONTRACT_DIGEST_FORMAT
    diagnostics.push({
      message: `${file} was written with contract digest format ${parsed.digest}, but this nifra computes format ${CONTRACT_DIGEST_FORMAT}${newer ? " (a newer @nifrajs/cli wrote it; upgrade this one)" : ""}, so no route could be compared. Review the route schema changes since the lock was written, then run \`nifra contracts snapshot\` and commit the lock.`,
    })
    return { present: true, vacuous, diagnostics, served, inputBeforeAuth }
  }
  const blind = await blindDigests()
  const keys = new Set([...Object.keys(parsed.routes), ...Object.keys(current.routes)])
  for (const key of [...keys].sort()) {
    const before = parsed.routes[key]
    const after = current.routes[key]
    if (before === undefined || after === undefined) {
      diagnostics.push({
        route: key,
        kind: before === undefined ? "added" : "removed",
        message:
          before === undefined
            ? `${key} is served but not in ${file}; if intentional run \`nifra contracts snapshot\` and include the lock update in the same change.`
            : `${key} is in ${file} but no longer served; if intentional run \`nifra contracts snapshot\` and include the lock update in the same change.`,
      })
      continue
    }
    // Between two digests that guard nothing there is nothing to compare.
    const sides = (["request", "response"] as const).filter(
      (side) =>
        before[side] !== after[side] &&
        !(blind[side].has(before[side]) && blind[side].has(after[side])),
    )
    if (before.parts !== undefined && after.parts !== undefined) {
      const drift = partDrift(before.parts, after.parts)
      const changed = drift.filter((item) => !item.uncovered)
      // A side digest that moved with no part to show for it (an edited lock) still fails.
      const unexplained = sides.filter((side) => !drift.some((item) => sideOf(item.part) === side))
      if (changed.length > 0 || unexplained.length > 0) {
        const parts = changed.map((item) => item.part)
        const changedSides = sidesOf(parts)
        const all = (["request", "response"] as const).filter(
          (side) => changedSides.includes(side) || unexplained.includes(side),
        )
        const detail =
          changed.length > 0 ? `: ${changed.map((item) => item.detail).join("; ")}` : ""
        diagnostics.push({
          route: key,
          kind: "changed",
          sides: all,
          parts,
          message: `contract changed for ${key} (${all.join(" and ")})${detail}; if intentional run \`nifra contracts snapshot\` and include the lock update in the same change.`,
        })
      }
      const uncovered = drift.filter((item) => item.uncovered).map((item) => item.part)
      if (uncovered.length > 0)
        diagnostics.push({
          route: key,
          kind: "newly-covered",
          sides: sidesOf(uncovered),
          parts: uncovered,
          message: `${key} ${uncovered.join(", ")}: ${file} locked the schema declared there as null (nifra could not read it), and this nifra reads it, so the lock never guarded it. Review the schema, then run \`nifra contracts snapshot\` to start guarding it.`,
        })
      continue
    }
    if (sides.length === 0) continue
    // The lock cannot tell an older nifra that could not read a schema from a route that declared
    // none, so this still fails: passing it would leave the side unguarded until someone snapshots.
    const uncovered = sides.filter((side) => blind[side].has(before[side]))
    const changed = sides.filter((side) => !blind[side].has(before[side]))
    if (changed.length > 0)
      diagnostics.push({
        route: key,
        kind: "changed",
        sides: changed,
        message: `contract changed for ${key} (${changed.join(" and ")}); if intentional run \`nifra contracts snapshot\` and include the lock update in the same change.`,
      })
    if (uncovered.length > 0)
      diagnostics.push({
        route: key,
        kind: "newly-covered",
        sides: uncovered,
        message: `${key} ${uncovered.join(" and ")}: ${file} records no schema there (the route declared none, or an older nifra could not read it), and the route now has one, so the lock never guarded it. Review the schema, then run \`nifra contracts snapshot\` to start guarding it.`,
      })
  }
  if (diagnostics.length > 0 && parsed.digest === undefined) {
    diagnostics.push({
      message: `${file} records no contract digest format. A lock written before nifra 4.0.1 hashed schemas differently, so a route reported above may not have changed. Review them, then run \`nifra contracts snapshot\` to record the format.`,
    })
  }
  return { present: true, vacuous, diagnostics, served, inputBeforeAuth }
}
