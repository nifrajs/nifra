/**
 * Contract-derived adversarial tests.
 *
 * A contract witness is a request known to satisfy a route's input schemas. From that witness this
 * module derives small hostile mutations, proves each mutation invalid with the route's own Standard
 * Schema validator, and then drives it through one or more real fetch runtimes. Declared success
 * responses are validated off the hot path as part of the same laboratory run.
 */

import {
  type JsonSchema,
  type ReflectedRoute,
  reflectRoutes,
  type SchemaReflection,
} from "@nifrajs/core/reflection"
import { generateMockValue } from "@nifrajs/mock"

const DEFAULT_ORIGIN = "http://nifra.contract"
const DEFAULT_SEED = 0x4e_49_46_52
const DEFAULT_MAX_MUTATIONS = 32
const DEFAULT_MAX_SHRINK_ATTEMPTS = 12
const DEFAULT_MAX_WITNESS_BYTES = 256 * 1024
const NO_BODY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"])
type HeaderSource = ConstructorParameters<typeof Headers>[0]

type InputTarget = "body" | "query"
export type ContractTarget = "body" | "query" | "response"
export type ContractCaseKind = "input-rejection" | "response-conformance"

/** Anything that exposes reflected routes and a Web-standard in-process fetch handler. */
export interface ContractTestApp {
  routes(): readonly unknown[]
  fetch(request: Request): Response | Promise<Response>
}

/** A runtime target for the same generated contract cases (for example Bun, Node, and Workers). */
export interface ContractRuntime {
  readonly name: string
  fetch(request: Request): Response | Promise<Response>
}

/** A known-good request. Missing body/query values are synthesized from inspectable JSON Schema. */
export interface ContractWitness {
  readonly params?: Readonly<Record<string, string>>
  readonly query?: unknown
  readonly body?: unknown
  readonly headers?: HeaderSource
}

/** Stable context passed to request/rejection hooks. It contains no request payloads or secrets. */
export interface ContractCaseContext {
  readonly seed: number
  readonly caseId: string
  readonly route: ReflectedRoute
  readonly runtime: string
  readonly kind: ContractCaseKind
  readonly target: ContractTarget
  readonly mutation?: string
}

export interface AdversarialContractOptions {
  /** Base origin for generated requests. Default `http://nifra.contract`. */
  readonly origin?: string
  /** Replayable seed used for deterministic witness generation. */
  readonly seed?: number
  /** Known-good request values keyed by `"METHOD /path"`. Required for opaque Standard Schemas. */
  readonly witnesses?: Readonly<Record<string, ContractWitness>>
  /** Select a subset of reflected routes. */
  readonly include?: (route: ReflectedRoute) => boolean
  /** Execute every case against these targets. Default: the supplied app, named `in-process`. */
  readonly runtimes?: readonly ContractRuntime[]
  /** Maximum validator-proven mutations per body/query schema. Default 32. */
  readonly maxMutationsPerInput?: number
  /** Maximum serialized witness size. Default 256 KiB. */
  readonly maxWitnessBytes?: number
  /** Statuses that prove an invalid input was rejected. Default `[422]`. */
  readonly expectedValidationStatuses?: readonly number[]
  /**
   * Attach auth, tenant, or runtime-specific state. Return a new Request; the input Request is already
   * fresh for this case and runtime.
   */
  readonly prepareRequest?: (
    request: Request,
    context: ContractCaseContext,
  ) => Request | Promise<Request>
  /** Override rejection semantics (for apps with a custom validation response). */
  readonly isRejected?: (
    response: Response,
    context: ContractCaseContext,
  ) => boolean | Promise<boolean>
  /** Validate a real successful response for every declared response schema. Default true. */
  readonly validateResponses?: boolean
  /** Fail the report when a contracted target cannot be exercised. Default true. */
  readonly requireCoverage?: boolean
  /** Greedily minimize an invalid input that unexpectedly reaches the app. Default true. */
  readonly shrinkFailures?: boolean
  /** Cap shrink probes for one failure. Default 12. */
  readonly maxShrinkAttempts?: number
  /** Replay only these stable case IDs. Coverage gaps are advisory when this is set. */
  readonly only?: string | readonly string[]
}

export type ContractCoverageGapCode =
  | "NO_CONTRACT_TARGETS"
  | "NO_VALIDATOR"
  | "NO_WITNESS"
  | "INVALID_WITNESS"
  | "WITNESS_TOO_LARGE"
  | "UNSUPPORTED_BODY_METHOD"
  | "NO_REJECTED_MUTATION"
  | "NO_RUNTIME"
  | "INVALID_RUNTIME"
  | "CASE_NOT_FOUND"

export interface ContractCoverageGap {
  readonly route?: string
  readonly target?: ContractTarget
  readonly code: ContractCoverageGapCode
  readonly message: string
}

export interface ContractReplay {
  readonly seed: number
  readonly caseId: string
  readonly runtime: string
}

export interface AdversarialContractResult {
  readonly id: string
  readonly route: string
  readonly runtime: string
  readonly kind: ContractCaseKind
  readonly target: ContractTarget
  readonly mutation?: string
  readonly ok: boolean
  readonly status?: number
  readonly message: string
  /** Number of successful greedy reductions applied to a failing hostile input. */
  readonly shrinkSteps?: number
  readonly replay: ContractReplay
}

export interface AdversarialContractReport {
  readonly ok: boolean
  readonly seed: number
  readonly routeCount: number
  readonly targetCount: number
  readonly runtimeCount: number
  readonly results: readonly AdversarialContractResult[]
  readonly failures: readonly AdversarialContractResult[]
  readonly gaps: readonly ContractCoverageGap[]
  readonly counts: {
    readonly passed: number
    readonly failed: number
    readonly gaps: number
  }
}

export class AdversarialContractError extends Error {
  constructor(readonly report: AdversarialContractReport) {
    const details = [
      ...report.failures
        .slice(0, 5)
        .map(
          (failure) =>
            `${failure.runtime}: ${failure.id} — ${failure.message} (replay seed ${report.seed})`,
        ),
      ...report.gaps
        .slice(0, 5)
        .map(
          (gap) =>
            `${gap.route ?? "contract"}${gap.target ? ` ${gap.target}` : ""}: ${gap.message}`,
        ),
    ]
    super(
      `Adversarial contract failed: ${report.failures.length} failure(s), ${report.gaps.length} coverage gap(s)${details.length > 0 ? `\n${details.join("\n")}` : ""}`,
    )
    this.name = "AdversarialContractError"
  }
}

interface Mutation {
  readonly value: unknown
  readonly path: readonly (string | number)[]
  readonly reason: string
}

interface ResolvedInput {
  readonly value: unknown
  readonly reflection: SchemaReflection
}

type ResolveInput =
  | { readonly ok: true; readonly input: ResolvedInput }
  | { readonly ok: false; readonly gap: ContractCoverageGap }

interface RouteLaboratory {
  readonly route: ReflectedRoute
  readonly routeKey: string
  readonly witness: ContractWitness
  readonly body?: ResolvedInput
  readonly query?: ResolvedInput
  readonly bodyMutations: readonly Mutation[]
  readonly queryMutations: readonly Mutation[]
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key)

const routeKeyOf = (route: ReflectedRoute): string => `${route.method.toUpperCase()} ${route.path}`

const normalizeSeed = (seed: number | undefined): number =>
  Number.isFinite(seed) ? Math.trunc(seed as number) >>> 0 : DEFAULT_SEED

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : fallback

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const hash = (value: string): number => {
  let out = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    out ^= value.charCodeAt(index)
    out = Math.imul(out, 16_777_619)
  }
  return out >>> 0
}

const jsonClone = (value: unknown): unknown => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError("value is not JSON serializable")
  return JSON.parse(serialized) as unknown
}

const valueSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length

const displayPath = (target: InputTarget, path: readonly (string | number)[]): string =>
  path.reduce<string>(
    (out, segment) => (typeof segment === "number" ? `${out}[${segment}]` : `${out}.${segment}`),
    target,
  )

const mutationId = (routeKey: string, target: InputTarget, mutation: Mutation): string =>
  `${routeKey} :: ${displayPath(target, mutation.path)} :: ${mutation.reason}`

const responseId = (routeKey: string): string => `${routeKey} :: response-conformance`

const typeKind = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value === "object" ? "object" : typeof value
}

const replacementValues = (value: unknown): readonly unknown[] => {
  const current = typeKind(value)
  const values: readonly unknown[] = [null, "", 0, false, [], {}]
  return values.filter((candidate) => typeKind(candidate) !== current)
}

const replaceAt = (
  value: unknown,
  path: readonly (string | number)[],
  replacement: unknown,
  remove = false,
): unknown => {
  if (path.length === 0) return replacement
  const [head, ...tail] = path
  if (Array.isArray(value)) {
    const clone = value.slice()
    if (typeof head !== "number") return value
    if (tail.length === 0 && remove) clone.splice(head, 1)
    else clone[head] = replaceAt(clone[head], tail, replacement, remove)
    return clone
  }
  const record = recordOf(value)
  if (record === undefined || typeof head !== "string") return value
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, item] of Object.entries(record)) clone[key] = item
  if (tail.length === 0 && remove) delete clone[head]
  else clone[head] = replaceAt(clone[head], tail, replacement, remove)
  return clone
}

const schemaRecord = (
  schema: JsonSchema | undefined,
): Readonly<Record<string, unknown>> | undefined =>
  schema === false || schema === true ? undefined : schema

function candidateMutations(
  root: unknown,
  schema: JsonSchema | undefined,
  maxCandidates: number,
): Mutation[] {
  const candidates: Mutation[] = []
  const add = (path: readonly (string | number)[], reason: string, value: unknown): void => {
    if (candidates.length < maxCandidates * 6) candidates.push({ path, reason, value })
  }

  const visit = (
    current: unknown,
    currentSchema: JsonSchema | undefined,
    path: readonly (string | number)[],
    depth: number,
  ): void => {
    if (depth > 8 || candidates.length >= maxCandidates * 6) return
    for (const replacement of replacementValues(current)) {
      add(path, `wrong-type-${typeKind(replacement)}`, replaceAt(root, path, replacement))
    }

    const raw = schemaRecord(currentSchema)
    if (raw !== undefined) {
      if (own(raw, "const")) {
        add(path, "const", replaceAt(root, path, "__nifra_not_const__"))
      }
      if (Array.isArray(raw.enum)) {
        add(path, "enum", replaceAt(root, path, "__nifra_not_enum__"))
      }
      if (typeof current === "string") {
        if (typeof raw.minLength === "number" && raw.minLength > 0 && raw.minLength <= 4096) {
          add(
            path,
            "below-minLength",
            replaceAt(root, path, "a".repeat(Math.max(0, raw.minLength - 1))),
          )
        }
        if (typeof raw.maxLength === "number" && raw.maxLength >= 0 && raw.maxLength < 4096) {
          add(path, "above-maxLength", replaceAt(root, path, "a".repeat(raw.maxLength + 1)))
        }
        if (typeof raw.pattern === "string") add(path, "pattern", replaceAt(root, path, ""))
        if (typeof raw.format === "string") {
          add(path, `format-${raw.format}`, replaceAt(root, path, "not-a-valid-format"))
        }
      }
      if (typeof current === "number") {
        if (typeof raw.minimum === "number") {
          add(path, "below-minimum", replaceAt(root, path, raw.minimum - 1))
        }
        if (typeof raw.maximum === "number") {
          add(path, "above-maximum", replaceAt(root, path, raw.maximum + 1))
        }
        if (typeof raw.exclusiveMinimum === "number") {
          add(path, "exclusive-minimum", replaceAt(root, path, raw.exclusiveMinimum))
        }
        if (typeof raw.exclusiveMaximum === "number") {
          add(path, "exclusive-maximum", replaceAt(root, path, raw.exclusiveMaximum))
        }
        if (raw.type === "integer") add(path, "non-integer", replaceAt(root, path, current + 0.5))
      }
      if (Array.isArray(current)) {
        if (typeof raw.minItems === "number" && raw.minItems > 0) {
          add(path, "below-minItems", replaceAt(root, path, current.slice(0, raw.minItems - 1)))
        }
        if (typeof raw.maxItems === "number" && raw.maxItems < 128) {
          const expanded = current.slice()
          const item = current[0] ?? null
          while (expanded.length <= raw.maxItems) expanded.push(item)
          add(path, "above-maxItems", replaceAt(root, path, expanded))
        }
        if (raw.uniqueItems === true && current.length > 0) {
          add(path, "duplicate-item", replaceAt(root, path, [current[0], current[0]]))
        }
      }
    }

    const currentRecord = recordOf(current)
    if (currentRecord !== undefined) {
      const properties = recordOf(raw?.properties)
      const required = Array.isArray(raw?.required)
        ? raw.required.filter((key): key is string => typeof key === "string")
        : []
      for (const key of required) {
        if (own(currentRecord, key)) {
          add([...path, key], "required-property", replaceAt(root, [...path, key], undefined, true))
        }
      }
      add(
        [...path, "__nifra_unexpected"],
        "additional-property",
        replaceAt(root, [...path, "__nifra_unexpected"], true),
      )
      for (const [key, item] of Object.entries(currentRecord)) {
        if (!required.includes(key)) {
          add([...path, key], "missing-property", replaceAt(root, [...path, key], undefined, true))
        }
        const propertySchema = properties?.[key]
        visit(
          item,
          typeof propertySchema === "boolean" || recordOf(propertySchema) !== undefined
            ? (propertySchema as JsonSchema)
            : undefined,
          [...path, key],
          depth + 1,
        )
      }
    } else if (Array.isArray(current) && current.length > 0) {
      add(path, "missing-array-item", replaceAt(root, path, current.slice(0, -1)))
      const itemSchema = raw?.items
      visit(
        current[0],
        typeof itemSchema === "boolean" || recordOf(itemSchema) !== undefined
          ? (itemSchema as JsonSchema)
          : undefined,
        [...path, 0],
        depth + 1,
      )
    }
  }

  visit(root, schema, [], 0)
  return candidates
}

async function rejectedByValidator(reflection: SchemaReflection, value: unknown): Promise<boolean> {
  const validator = reflection.standard
  if (validator === undefined) return false
  const result = await validator["~standard"].validate(value)
  return result.issues !== undefined
}

async function provenMutations(
  input: ResolvedInput,
  target: InputTarget,
  maxMutations: number,
): Promise<Mutation[]> {
  const candidates = candidateMutations(input.value, input.reflection.jsonSchema, maxMutations)
  const mutations: Mutation[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    let serialized: string
    let value: unknown
    try {
      value = target === "query" ? queryInput(candidate.value) : jsonClone(candidate.value)
      if (value === undefined) continue
      serialized = JSON.stringify(value)
    } catch {
      continue
    }
    if (seen.has(serialized)) continue
    seen.add(serialized)
    try {
      if (await rejectedByValidator(input.reflection, value))
        mutations.push({ ...candidate, value })
    } catch {
      // A validator that throws for one hostile value violates Standard Schema, but do not let it
      // abort discovery of other mutations. If none are usable the route gets a fail-closed gap.
    }
    if (mutations.length >= maxMutations) break
  }
  return mutations
}

const queryPairs = (value: unknown): readonly [string, string][] | undefined => {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const pairs: [string, string][] = []
  for (const [key, item] of Object.entries(record)) {
    if (item === undefined) continue
    const values = Array.isArray(item) ? item : [item]
    for (const entry of values) {
      const encoded =
        entry !== null && typeof entry === "object" ? JSON.stringify(entry) : String(entry)
      pairs.push([key, encoded])
    }
  }
  return pairs
}

const queryInput = (value: unknown): unknown | undefined => {
  const pairs = queryPairs(value)
  if (pairs === undefined) return undefined
  const result: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >
  for (const [key, value] of pairs) {
    const previous = result[key]
    if (previous === undefined) result[key] = value
    else if (Array.isArray(previous)) previous.push(value)
    else result[key] = [previous, value]
  }
  return result
}

async function resolveInput(
  routeKey: string,
  target: InputTarget,
  reflection: SchemaReflection,
  witness: ContractWitness,
  seed: number,
  maxWitnessBytes: number,
): Promise<ResolveInput> {
  if (reflection.standard === undefined) {
    return {
      ok: false,
      gap: {
        route: routeKey,
        target,
        code: "NO_VALIDATOR",
        message: `${target} metadata has no Standard Schema validator`,
      },
    }
  }

  let value: unknown
  if (own(witness, target)) {
    value = witness[target]
  } else if (reflection.jsonSchema !== undefined) {
    try {
      value = generateMockValue(
        reflection.jsonSchema,
        target,
        seededRandom(seed ^ hash(`${routeKey}:${target}`)),
      )
    } catch (error) {
      return {
        ok: false,
        gap: {
          route: routeKey,
          target,
          code: "NO_WITNESS",
          message: `could not synthesize a ${target} witness: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
  } else {
    return {
      ok: false,
      gap: {
        route: routeKey,
        target,
        code: "NO_WITNESS",
        message: `opaque ${target} schema needs witnesses[${JSON.stringify(routeKey)}].${target}`,
      },
    }
  }

  try {
    value = target === "query" ? queryInput(value) : jsonClone(value)
    if (value === undefined) throw new TypeError(`${target} witness is not transport-serializable`)
    if (valueSize(value) > maxWitnessBytes) {
      return {
        ok: false,
        gap: {
          route: routeKey,
          target,
          code: "WITNESS_TOO_LARGE",
          message: `${target} witness exceeds maxWitnessBytes (${maxWitnessBytes})`,
        },
      }
    }
    if (await rejectedByValidator(reflection, value)) {
      return {
        ok: false,
        gap: {
          route: routeKey,
          target,
          code: "INVALID_WITNESS",
          message: `${target} witness is rejected by its Standard Schema validator`,
        },
      }
    }
    return { ok: true, input: { value, reflection } }
  } catch (error) {
    return {
      ok: false,
      gap: {
        route: routeKey,
        target,
        code: "INVALID_WITNESS",
        message: `could not validate ${target} witness: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}

const materializePath = (
  path: string,
  params: Readonly<Record<string, string>> | undefined,
): string =>
  path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const name = segment.slice(1)
        return encodeURIComponent(params?.[name] ?? `${name || "param"}-contract`)
      }
      if (segment.startsWith("*")) {
        const name = segment.slice(1)
        const value = params?.[name] ?? `${name || "path"}/contract`
        return value.split("/").filter(Boolean).map(encodeURIComponent).join("/")
      }
      return segment
    })
    .join("/")

function requestFor(
  laboratory: RouteLaboratory,
  origin: string,
  body: unknown,
  query: unknown,
): Request {
  const path = materializePath(laboratory.route.path, laboratory.witness.params)
  const url = new URL(path, origin)
  for (const [key, value] of queryPairs(query) ?? []) url.searchParams.append(key, value)
  const headers = new Headers(laboratory.witness.headers)
  const init: RequestInit = { method: laboratory.route.method, headers }
  if (
    laboratory.route.schema?.body !== undefined &&
    !NO_BODY_METHODS.has(laboratory.route.method)
  ) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    init.body = JSON.stringify(body)
  }
  return new Request(url.toString(), init)
}

const onlySet = (only: string | readonly string[] | undefined): ReadonlySet<string> | undefined =>
  only === undefined ? undefined : new Set(typeof only === "string" ? [only] : only)

const simplerValues = (value: unknown): readonly unknown[] => {
  if (typeof value === "string")
    return value.length === 0 ? [] : ["", value.slice(0, value.length / 2)]
  if (typeof value === "number") return value === 0 ? [] : [0, Math.trunc(value / 2)]
  if (Array.isArray(value)) return value.length === 0 ? [] : [[], value.slice(0, value.length / 2)]
  const record = recordOf(value)
  if (record !== undefined) {
    const entries = Object.entries(record)
    if (entries.length === 0) return []
    return [
      {},
      ...entries.map(([removed]) => {
        const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        for (const [key, item] of entries) if (key !== removed) clone[key] = item
        return clone
      }),
    ]
  }
  return value === null || value === false ? [] : [null, false]
}

async function preparedRequest(
  request: Request,
  context: ContractCaseContext,
  prepare: AdversarialContractOptions["prepareRequest"],
): Promise<Request> {
  return prepare === undefined ? request : await prepare(request, context)
}

async function discardResponse(response: Response): Promise<void> {
  if (response.body === null || response.bodyUsed) return
  try {
    await response.body.cancel()
  } catch {
    // A custom rejection predicate may have locked the stream. Disposal is best-effort only.
  }
}

async function executeRejection(
  runtime: ContractRuntime,
  laboratory: RouteLaboratory,
  target: InputTarget,
  mutation: Mutation,
  id: string,
  options: AdversarialContractOptions,
  seed: number,
  origin: string,
  statuses: ReadonlySet<number>,
): Promise<{ readonly rejected: boolean; readonly status?: number; readonly error?: string }> {
  const context: ContractCaseContext = {
    seed,
    caseId: id,
    route: laboratory.route,
    runtime: runtime.name,
    kind: "input-rejection",
    target,
    mutation: `${displayPath(target, mutation.path)} ${mutation.reason}`,
  }
  try {
    const body = target === "body" ? mutation.value : laboratory.body?.value
    const query = target === "query" ? mutation.value : laboratory.query?.value
    const request = await preparedRequest(
      requestFor(laboratory, origin, body, query),
      context,
      options.prepareRequest,
    )
    const response = await runtime.fetch(request)
    const rejected =
      options.isRejected === undefined
        ? statuses.has(response.status)
        : await options.isRejected(response, context)
    await discardResponse(response)
    return { rejected, status: response.status }
  } catch (error) {
    return { rejected: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function shrinkFailure(
  runtime: ContractRuntime,
  laboratory: RouteLaboratory,
  target: InputTarget,
  mutation: Mutation,
  id: string,
  options: AdversarialContractOptions,
  seed: number,
  origin: string,
  statuses: ReadonlySet<number>,
  maxAttempts: number,
): Promise<{ readonly mutation: Mutation; readonly steps: number; readonly status?: number }> {
  let current = mutation
  let steps = 0
  let attempts = 0
  let status: number | undefined
  while (attempts < maxAttempts) {
    let improved = false
    for (const value of simplerValues(current.value)) {
      attempts += 1
      if (attempts > maxAttempts) break
      const reflection =
        target === "body" ? laboratory.body?.reflection : laboratory.query?.reflection
      const transported = target === "query" ? queryInput(value) : jsonClone(value)
      if (transported === undefined) continue
      if (reflection === undefined) continue
      try {
        if (!(await rejectedByValidator(reflection, transported))) continue
      } catch {
        continue
      }
      const candidate = { ...current, value: transported }
      const result = await executeRejection(
        runtime,
        laboratory,
        target,
        candidate,
        id,
        options,
        seed,
        origin,
        statuses,
      )
      status = result.status
      if (!result.rejected && result.error === undefined) {
        current = candidate
        steps += 1
        improved = true
        break
      }
    }
    if (!improved) break
  }
  return { mutation: current, steps, ...(status === undefined ? {} : { status }) }
}

const resultForFailure = (
  base: Omit<AdversarialContractResult, "ok" | "message" | "replay">,
  seed: number,
  message: string,
): AdversarialContractResult => ({
  ...base,
  ok: false,
  message,
  replay: { seed, caseId: base.id, runtime: base.runtime },
})

async function buildLaboratories(
  routes: readonly ReflectedRoute[],
  options: AdversarialContractOptions,
  seed: number,
  gaps: ContractCoverageGap[],
): Promise<{ readonly laboratories: RouteLaboratory[]; readonly targetCount: number }> {
  const laboratories: RouteLaboratory[] = []
  const maxMutations = positiveInteger(options.maxMutationsPerInput, DEFAULT_MAX_MUTATIONS)
  const maxWitnessBytes = positiveInteger(options.maxWitnessBytes, DEFAULT_MAX_WITNESS_BYTES)
  let targetCount = 0

  for (const route of routes) {
    const routeKey = routeKeyOf(route)
    const witness = options.witnesses?.[routeKey] ?? {}
    let body: ResolvedInput | undefined
    let query: ResolvedInput | undefined

    if (route.schema?.body !== undefined) {
      targetCount += 1
      if (NO_BODY_METHODS.has(route.method)) {
        gaps.push({
          route: routeKey,
          target: "body",
          code: "UNSUPPORTED_BODY_METHOD",
          message: `${route.method} cannot carry a request body`,
        })
      } else {
        const resolved = await resolveInput(
          routeKey,
          "body",
          route.schema.body,
          witness,
          seed,
          maxWitnessBytes,
        )
        if (resolved.ok) body = resolved.input
        else gaps.push(resolved.gap)
      }
    }
    if (route.schema?.query !== undefined) {
      targetCount += 1
      const resolved = await resolveInput(
        routeKey,
        "query",
        route.schema.query,
        witness,
        seed,
        maxWitnessBytes,
      )
      if (resolved.ok) query = resolved.input
      else gaps.push(resolved.gap)
    }
    if (options.validateResponses !== false && route.schema?.response !== undefined)
      targetCount += 1

    const allInputsResolved =
      (route.schema?.body === undefined || body !== undefined) &&
      (route.schema?.query === undefined || query !== undefined)
    const bodyMutations =
      body !== undefined && allInputsResolved
        ? await provenMutations(body, "body", maxMutations)
        : []
    const queryMutations =
      query !== undefined && allInputsResolved
        ? await provenMutations(query, "query", maxMutations)
        : []
    if (body !== undefined && allInputsResolved && bodyMutations.length === 0) {
      gaps.push({
        route: routeKey,
        target: "body",
        code: "NO_REJECTED_MUTATION",
        message: "the body validator accepted every generated hostile mutation",
      })
    }
    if (query !== undefined && allInputsResolved && queryMutations.length === 0) {
      gaps.push({
        route: routeKey,
        target: "query",
        code: "NO_REJECTED_MUTATION",
        message: "the query validator accepted every generated hostile mutation",
      })
    }
    laboratories.push({
      route,
      routeKey,
      witness,
      ...(body === undefined ? {} : { body }),
      ...(query === undefined ? {} : { query }),
      bodyMutations,
      queryMutations,
    })
  }
  return { laboratories, targetCount }
}

/**
 * Execute contract-derived hostile inputs and declared-response conformance against a runtime matrix.
 * Runtime/request failures are captured in the report; inspect `report.ok`, `failures`, and `gaps`
 * (or use {@link assertAdversarialContract} for a throwing test assertion).
 */
export async function runAdversarialContract(
  app: ContractTestApp,
  options: AdversarialContractOptions = {},
): Promise<AdversarialContractReport> {
  const seed = normalizeSeed(options.seed)
  const origin = options.origin ?? DEFAULT_ORIGIN
  const routes = reflectRoutes(app).filter((route) => options.include?.(route) ?? true)
  const runtimes = options.runtimes ?? [
    { name: "in-process", fetch: (request) => app.fetch(request) },
  ]
  const statuses = new Set(options.expectedValidationStatuses ?? [422])
  const gaps: ContractCoverageGap[] = []
  const results: AdversarialContractResult[] = []
  const only = onlySet(options.only)
  const { laboratories, targetCount } = await buildLaboratories(routes, options, seed, gaps)

  if (runtimes.length === 0) {
    gaps.push({ code: "NO_RUNTIME", message: "at least one contract runtime is required" })
  }
  const runtimeNames = new Set<string>()
  for (const runtime of runtimes) {
    const name = runtime.name.trim()
    if (!name || runtimeNames.has(name)) {
      gaps.push({
        code: "INVALID_RUNTIME",
        message: !name
          ? "contract runtime names must be non-empty"
          : `duplicate contract runtime name ${JSON.stringify(name)}`,
      })
    }
    runtimeNames.add(name)
  }
  if (targetCount === 0) {
    gaps.push({
      code: "NO_CONTRACT_TARGETS",
      message: "selected routes declare no body, query, or response contracts",
    })
  }

  for (const laboratory of laboratories) {
    for (const target of ["body", "query"] as const) {
      const mutations = target === "body" ? laboratory.bodyMutations : laboratory.queryMutations
      for (const mutation of mutations) {
        const id = mutationId(laboratory.routeKey, target, mutation)
        if (only !== undefined && !only.has(id)) continue
        for (const runtime of runtimes) {
          const base = {
            id,
            route: laboratory.routeKey,
            runtime: runtime.name,
            kind: "input-rejection" as const,
            target,
            mutation: `${displayPath(target, mutation.path)} ${mutation.reason}`,
          }
          const outcome = await executeRejection(
            runtime,
            laboratory,
            target,
            mutation,
            id,
            options,
            seed,
            origin,
            statuses,
          )
          if (outcome.rejected) {
            results.push({
              ...base,
              ok: true,
              ...(outcome.status === undefined ? {} : { status: outcome.status }),
              message: "hostile input rejected at the request boundary",
              replay: { seed, caseId: id, runtime: runtime.name },
            })
            continue
          }

          let shrinkSteps = 0
          let status = outcome.status
          if (options.shrinkFailures !== false && outcome.error === undefined) {
            const shrunk = await shrinkFailure(
              runtime,
              laboratory,
              target,
              mutation,
              id,
              options,
              seed,
              origin,
              statuses,
              positiveInteger(options.maxShrinkAttempts, DEFAULT_MAX_SHRINK_ATTEMPTS),
            )
            shrinkSteps = shrunk.steps
            status = shrunk.status ?? status
          }
          results.push(
            resultForFailure(
              {
                ...base,
                ...(status === undefined ? {} : { status }),
                ...(shrinkSteps === 0 ? {} : { shrinkSteps }),
              },
              seed,
              outcome.error === undefined
                ? `expected validation status ${[...statuses].join("/")}, received ${status ?? "no response"}`
                : `runtime threw: ${outcome.error}`,
            ),
          )
        }
      }
    }

    const responseSchema = laboratory.route.schema?.response
    if (options.validateResponses === false || responseSchema === undefined) continue
    const id = responseId(laboratory.routeKey)
    if (only !== undefined && !only.has(id)) continue
    if (responseSchema.standard === undefined) {
      gaps.push({
        route: laboratory.routeKey,
        target: "response",
        code: "NO_VALIDATOR",
        message: "response metadata has no Standard Schema validator",
      })
      continue
    }
    const allInputsResolved =
      (laboratory.route.schema?.body === undefined || laboratory.body !== undefined) &&
      (laboratory.route.schema?.query === undefined || laboratory.query !== undefined)
    if (!allInputsResolved) continue

    for (const runtime of runtimes) {
      const context: ContractCaseContext = {
        seed,
        caseId: id,
        route: laboratory.route,
        runtime: runtime.name,
        kind: "response-conformance",
        target: "response",
      }
      const base = {
        id,
        route: laboratory.routeKey,
        runtime: runtime.name,
        kind: "response-conformance" as const,
        target: "response" as const,
      }
      try {
        const request = await preparedRequest(
          requestFor(laboratory, origin, laboratory.body?.value, laboratory.query?.value),
          context,
          options.prepareRequest,
        )
        const response = await runtime.fetch(request)
        const status = response.status
        if (!response.ok) {
          await discardResponse(response)
          results.push(
            resultForFailure(
              { ...base, status },
              seed,
              `valid witness returned non-success status ${status}`,
            ),
          )
          continue
        }
        const text = await response.text()
        let value: unknown
        try {
          value = text.length === 0 ? undefined : (JSON.parse(text) as unknown)
        } catch {
          results.push(
            resultForFailure(
              { ...base, status },
              seed,
              "declared response contract received a non-JSON response body",
            ),
          )
          continue
        }
        const validation = await responseSchema.standard["~standard"].validate(value)
        if (validation.issues !== undefined) {
          const first = validation.issues[0]
          const at = first?.path?.map((segment) =>
            typeof segment === "object" && segment !== null && "key" in segment
              ? String(segment.key)
              : String(segment),
          )
          results.push(
            resultForFailure(
              { ...base, status },
              seed,
              `response violates its contract${at && at.length > 0 ? ` at ${at.join(".")}` : ""}${first?.message ? `: ${first.message}` : ""}`,
            ),
          )
          continue
        }
        results.push({
          ...base,
          status,
          ok: true,
          message: "successful response satisfies its declared contract",
          replay: { seed, caseId: id, runtime: runtime.name },
        })
      } catch (error) {
        results.push(
          resultForFailure(
            base,
            seed,
            `runtime threw: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }
  }

  const failures = results.filter((result) => !result.ok)
  if (only !== undefined) {
    for (const id of only) {
      if (!results.some((result) => result.id === id)) {
        gaps.push({
          code: "CASE_NOT_FOUND",
          message: `replay case ${JSON.stringify(id)} was not generated for the selected contract`,
        })
      }
    }
  }
  const coverageRequired = options.requireCoverage ?? options.only === undefined
  const fatalGap = gaps.some(
    (gap) =>
      gap.code === "NO_RUNTIME" || gap.code === "INVALID_RUNTIME" || gap.code === "CASE_NOT_FOUND",
  )
  return {
    ok: failures.length === 0 && !fatalGap && (!coverageRequired || gaps.length === 0),
    seed,
    routeCount: routes.length,
    targetCount,
    runtimeCount: runtimes.length,
    results,
    failures,
    gaps,
    counts: {
      passed: results.length - failures.length,
      failed: failures.length,
      gaps: gaps.length,
    },
  }
}

/** Run the contract laboratory and throw an {@link AdversarialContractError} unless it is fully green. */
export async function assertAdversarialContract(
  app: ContractTestApp,
  options: AdversarialContractOptions = {},
): Promise<AdversarialContractReport> {
  const report = await runAdversarialContract(app, options)
  if (!report.ok) throw new AdversarialContractError(report)
  return report
}
