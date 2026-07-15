/**
 * Framework-neutral execution causality.
 *
 * Traces describe one synchronous/remote observation tree. Causality survives the durable seams a
 * trace cannot: a command commits an outbox event, a workflow resumes tomorrow, a projection
 * consumes that event, and reconciliation repairs drift. This module carries only bounded identity
 * tokens and links; payloads, tenant identifiers, request URLs, and arbitrary attributes cannot enter
 * the graph by construction.
 */

/** A node category such as `request`, `command`, `event`, `workflow`, `projection`, or `repair`. */
export type CausalityKind = string

/** A bounded identity within one execution graph. */
export interface CausalityRef {
  readonly kind: CausalityKind
  readonly id: string
}

/** Optional OpenTelemetry anchor for the nearest observed ancestor. */
export interface CausalityTrace {
  readonly traceId: string
  readonly spanId: string
}

/** The propagation shape carried across commands/events/jobs. */
export interface CausalityContext {
  readonly executionId: string
  readonly current: CausalityRef
  /** Nearest observed ancestor; downstream observations can attach a real OTel span link to it. */
  readonly trace?: CausalityTrace
}

/** One immediate parent edge. Relation is a bounded token (`caused`, `emitted`, `projected`, …). */
export interface CausalityParent extends CausalityRef {
  readonly relation: string
}

/** One append-only graph record. It intentionally has no payload or metadata field. */
export interface CausalityRecord {
  readonly executionId: string
  readonly node: CausalityRef & {
    readonly at: number
    /** Present only when this node itself opened an observation. */
    readonly trace?: CausalityTrace
  }
  readonly parents: readonly CausalityParent[]
}

/** A propagation context plus the graph record a durable adapter should append. */
export interface CausalityStep {
  readonly context: CausalityContext
  readonly record: CausalityRecord
}

export interface CausalityRecorder<Tx = unknown> {
  /** Idempotently append one node and its immediate incoming edges. */
  record(record: CausalityRecord, tx?: Tx): Promise<"inserted" | "duplicate">
}

export interface CausalityTimelineItem {
  readonly cursor: string
  readonly record: CausalityRecord
}

export interface CausalityTimelinePage {
  readonly items: readonly CausalityTimelineItem[]
  readonly nextCursor?: string
}

export interface CausalityReader {
  timeline(
    executionId: string,
    options?: { readonly after?: string; readonly limit?: number },
  ): Promise<CausalityTimelinePage>
}

export type CausalityGraphStore<Tx = unknown> = CausalityRecorder<Tx> & CausalityReader

export class CausalityConflictError extends Error {
  constructor(
    readonly executionId: string,
    readonly node: CausalityRef,
  ) {
    super(`causality conflict: ${node.kind}:${node.id} changed inside execution ${executionId}`)
    this.name = "CausalityConflictError"
  }
}

export class CausalityCapacityError extends Error {
  constructor(readonly maxRecords: number) {
    super(`causality store capacity exceeded (${maxRecords} records)`)
    this.name = "CausalityCapacityError"
  }
}

export interface StartCausalityOptions {
  /** Stable graph identity. Generate once at the ingress boundary, then propagate it. */
  readonly executionId: string
  /** Epoch milliseconds. Injectable for deterministic tests. Default `Date.now()`. */
  readonly at?: number
  /** Observation opened for this exact node. */
  readonly trace?: CausalityTrace
}

export interface ContinueCausalityOptions {
  /** Edge relation. Default `caused`. */
  readonly relation?: string
  /** Epoch milliseconds. Injectable for deterministic tests. Default `Date.now()`. */
  readonly at?: number
  /** A new observation opened for this exact node; otherwise the nearest anchor is propagated. */
  readonly trace?: CausalityTrace
}

export type CausalityParseResult =
  | { readonly success: true; readonly context: CausalityContext }
  | {
      readonly success: false
      readonly reason: "missing" | "incomplete" | "invalid" | "unknown-field"
    }

export type CausalityRecordParseResult =
  | { readonly success: true; readonly record: CausalityRecord }
  | {
      readonly success: false
      readonly reason: "incomplete" | "invalid" | "unknown-field"
    }

export const CAUSALITY_EXECUTION_HEADER = "x-nifra-execution-id"
export const CAUSALITY_KIND_HEADER = "x-nifra-causality-kind"
export const CAUSALITY_NODE_HEADER = "x-nifra-causality-id"
export const CAUSALITY_TRACE_HEADER = "x-nifra-causality-trace"

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KIND = /^[a-z][a-z0-9._-]{0,63}$/
const RELATION = /^[a-z][a-z0-9._-]{0,63}$/
const TRACE_ID = /^[0-9a-f]{32}$/
const SPAN_ID = /^[0-9a-f]{16}$/
const MAX_PARENTS = 16
const DEFAULT_TIMELINE_LIMIT = 100
const MAX_TIMELINE_LIMIT = 500

function identity(value: string, label: string): string {
  if (!IDENTITY.test(value)) {
    throw new TypeError(`causality: ${label} must be a bounded identity token`)
  }
  return value
}

function kind(value: string): string {
  if (!KIND.test(value)) throw new TypeError("causality: kind must be a bounded lowercase token")
  return value
}

function relation(value: string): string {
  if (!RELATION.test(value)) {
    throw new TypeError("causality: relation must be a bounded lowercase token")
  }
  return value
}

function timestamp(value: number | undefined): number {
  const at = value ?? Date.now()
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new TypeError("causality: at must be a non-negative safe-integer epoch millisecond")
  }
  return at
}

function trace(value: CausalityTrace | undefined): CausalityTrace | undefined {
  if (value === undefined) return undefined
  if (!TRACE_ID.test(value.traceId) || !SPAN_ID.test(value.spanId)) {
    throw new TypeError("causality: trace must contain lowercase W3C trace/span ids")
  }
  return Object.freeze({ traceId: value.traceId, spanId: value.spanId })
}

function ref(nodeKind: string, id: string): CausalityRef {
  return Object.freeze({ kind: kind(nodeKind), id: identity(id, "node id") })
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function onlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function buildStep(
  executionId: string,
  current: CausalityRef,
  parents: readonly CausalityParent[],
  at: number,
  nodeTrace: CausalityTrace | undefined,
  propagatedTrace: CausalityTrace | undefined,
): CausalityStep {
  const node = Object.freeze({
    ...current,
    at,
    ...(nodeTrace === undefined ? {} : { trace: nodeTrace }),
  })
  const frozenParents = Object.freeze([...parents])
  const context = Object.freeze({
    executionId,
    current,
    ...(propagatedTrace === undefined ? {} : { trace: propagatedTrace }),
  })
  const record = Object.freeze({ executionId, node, parents: frozenParents })
  return Object.freeze({ context, record })
}

function normalizeRecord(input: CausalityRecord): CausalityRecord {
  const executionId = identity(input.executionId, "executionId")
  if (input.parents.length > MAX_PARENTS) {
    throw new RangeError(`causality: a record cannot have more than ${MAX_PARENTS} parents`)
  }
  const current = ref(input.node.kind, input.node.id)
  const nodeTrace = trace(input.node.trace)
  const parents = input.parents.map((parent) =>
    Object.freeze({
      ...ref(parent.kind, parent.id),
      relation: relation(parent.relation),
    }),
  )
  return Object.freeze({
    executionId,
    node: Object.freeze({
      ...current,
      at: timestamp(input.node.at),
      ...(nodeTrace === undefined ? {} : { trace: nodeTrace }),
    }),
    parents: Object.freeze(parents),
  })
}

/** Start a root execution node at an ingress boundary. */
export function startCausality(
  nodeKind: CausalityKind,
  id: string,
  options: StartCausalityOptions,
): CausalityStep {
  const executionId = identity(options.executionId, "executionId")
  const current = ref(nodeKind, id)
  const nodeTrace = trace(options.trace)
  return buildStep(executionId, current, [], timestamp(options.at), nodeTrace, nodeTrace)
}

/** Continue one execution from a single immediate parent. */
export function continueCausality(
  parent: CausalityContext,
  nodeKind: CausalityKind,
  id: string,
  options: ContinueCausalityOptions = {},
): CausalityStep {
  return joinCausality([parent], nodeKind, id, options)
}

/** Join several immediate parents. Cross-execution joins fail closed. */
export function joinCausality(
  parents: readonly CausalityContext[],
  nodeKind: CausalityKind,
  id: string,
  options: ContinueCausalityOptions = {},
): CausalityStep {
  if (parents.length === 0 || parents.length > MAX_PARENTS) {
    throw new RangeError(`causality: parents must contain 1 to ${MAX_PARENTS} contexts`)
  }
  const executionId = identity(parents[0]?.executionId ?? "", "executionId")
  if (parents.some((parent) => parent.executionId !== executionId)) {
    throw new Error("causality: joined parents must belong to the same execution")
  }
  const edgeRelation = relation(options.relation ?? "caused")
  const seen = new Set<string>()
  const incoming: CausalityParent[] = []
  for (const parent of parents) {
    const parentRef = ref(parent.current.kind, parent.current.id)
    const key = `${parentRef.kind}\n${parentRef.id}`
    if (seen.has(key)) continue
    seen.add(key)
    incoming.push(Object.freeze({ ...parentRef, relation: edgeRelation }))
  }
  const current = ref(nodeKind, id)
  const nodeTrace = trace(options.trace)
  const propagatedTrace = nodeTrace ?? parents.find((parent) => parent.trace !== undefined)?.trace
  return buildStep(
    executionId,
    current,
    incoming,
    timestamp(options.at),
    nodeTrace,
    propagatedTrace,
  )
}

const CONTEXT_FIELDS: ReadonlySet<string> = new Set(["executionId", "current", "trace"])
const REF_FIELDS: ReadonlySet<string> = new Set(["kind", "id"])
const TRACE_FIELDS: ReadonlySet<string> = new Set(["traceId", "spanId"])
const RECORD_FIELDS: ReadonlySet<string> = new Set(["executionId", "node", "parents"])
const NODE_FIELDS: ReadonlySet<string> = new Set(["kind", "id", "at", "trace"])
const PARENT_FIELDS: ReadonlySet<string> = new Set(["kind", "id", "relation"])

/** Parse an untrusted durable graph record. Unknown fields fail closed at every nesting level. */
export function parseCausalityRecord(input: unknown): CausalityRecordParseResult {
  const value = recordOf(input)
  if (value === undefined) return { success: false, reason: "invalid" }
  if (!onlyKeys(value, RECORD_FIELDS)) return { success: false, reason: "unknown-field" }
  const node = recordOf(value.node)
  if (node === undefined || !Array.isArray(value.parents)) {
    return { success: false, reason: "incomplete" }
  }
  if (!onlyKeys(node, NODE_FIELDS)) return { success: false, reason: "unknown-field" }
  const nodeTrace =
    value.node !== undefined && node.trace !== undefined ? recordOf(node.trace) : undefined
  if (node.trace !== undefined && nodeTrace === undefined) {
    return { success: false, reason: "invalid" }
  }
  if (nodeTrace !== undefined && !onlyKeys(nodeTrace, TRACE_FIELDS)) {
    return { success: false, reason: "unknown-field" }
  }
  const parents: CausalityParent[] = []
  for (const rawParent of value.parents) {
    const parent = recordOf(rawParent)
    if (parent === undefined) return { success: false, reason: "invalid" }
    if (!onlyKeys(parent, PARENT_FIELDS)) return { success: false, reason: "unknown-field" }
    if (
      typeof parent.kind !== "string" ||
      typeof parent.id !== "string" ||
      typeof parent.relation !== "string"
    ) {
      return { success: false, reason: "incomplete" }
    }
    parents.push({ kind: parent.kind, id: parent.id, relation: parent.relation })
  }
  if (
    typeof value.executionId !== "string" ||
    typeof node.kind !== "string" ||
    typeof node.id !== "string" ||
    typeof node.at !== "number" ||
    (nodeTrace !== undefined &&
      (typeof nodeTrace.traceId !== "string" || typeof nodeTrace.spanId !== "string"))
  ) {
    return { success: false, reason: "incomplete" }
  }
  try {
    return {
      success: true,
      record: normalizeRecord({
        executionId: value.executionId,
        node: {
          kind: node.kind,
          id: node.id,
          at: node.at,
          ...(nodeTrace === undefined
            ? {}
            : {
                trace: { traceId: nodeTrace.traceId as string, spanId: nodeTrace.spanId as string },
              }),
        },
        parents,
      }),
    }
  } catch {
    return { success: false, reason: "invalid" }
  }
}

/** Parse an untrusted JSON causality context. Unknown fields fail closed so payloads cannot hitchhike. */
export function parseCausalityContext(input: unknown): CausalityParseResult {
  const value = recordOf(input)
  if (value === undefined) return { success: false, reason: "invalid" }
  if (!onlyKeys(value, CONTEXT_FIELDS)) return { success: false, reason: "unknown-field" }
  const current = recordOf(value.current)
  if (current === undefined) return { success: false, reason: "incomplete" }
  if (!onlyKeys(current, REF_FIELDS)) return { success: false, reason: "unknown-field" }
  const rawTrace = value.trace === undefined ? undefined : recordOf(value.trace)
  if (value.trace !== undefined && rawTrace === undefined) {
    return { success: false, reason: "invalid" }
  }
  if (rawTrace !== undefined && !onlyKeys(rawTrace, TRACE_FIELDS)) {
    return { success: false, reason: "unknown-field" }
  }
  if (
    typeof value.executionId !== "string" ||
    typeof current.kind !== "string" ||
    typeof current.id !== "string" ||
    (rawTrace !== undefined &&
      (typeof rawTrace.traceId !== "string" || typeof rawTrace.spanId !== "string"))
  ) {
    return { success: false, reason: "incomplete" }
  }
  try {
    const context = Object.freeze({
      executionId: identity(value.executionId, "executionId"),
      current: ref(current.kind, current.id),
      ...(rawTrace === undefined
        ? {}
        : {
            trace: trace({
              traceId: rawTrace.traceId as string,
              spanId: rawTrace.spanId as string,
            }) as CausalityTrace,
          }),
    })
    return { success: true, context }
  } catch {
    return { success: false, reason: "invalid" }
  }
}

/** Serialize the propagation context into bounded HTTP headers. */
export function causalityHeaders(context: CausalityContext): Readonly<Record<string, string>> {
  const parsed = parseCausalityContext(context)
  if (!parsed.success) throw new TypeError(`causality: invalid context (${parsed.reason})`)
  return Object.freeze({
    [CAUSALITY_EXECUTION_HEADER]: parsed.context.executionId,
    [CAUSALITY_KIND_HEADER]: parsed.context.current.kind,
    [CAUSALITY_NODE_HEADER]: parsed.context.current.id,
    ...(parsed.context.trace === undefined
      ? {}
      : {
          [CAUSALITY_TRACE_HEADER]: `${parsed.context.trace.traceId}-${parsed.context.trace.spanId}`,
        }),
  })
}

/** Parse the public header convention without ever throwing on hostile input. */
export function readCausalityHeaders(headers: Headers): CausalityParseResult {
  const executionId = headers.get(CAUSALITY_EXECUTION_HEADER)
  const nodeKind = headers.get(CAUSALITY_KIND_HEADER)
  const nodeId = headers.get(CAUSALITY_NODE_HEADER)
  const encodedTrace = headers.get(CAUSALITY_TRACE_HEADER)
  if (executionId === null && nodeKind === null && nodeId === null && encodedTrace === null) {
    return { success: false, reason: "missing" }
  }
  if (executionId === null || nodeKind === null || nodeId === null) {
    return { success: false, reason: "incomplete" }
  }
  let decodedTrace: CausalityTrace | undefined
  if (encodedTrace !== null) {
    const match = /^([0-9a-f]{32})-([0-9a-f]{16})$/.exec(encodedTrace)
    if (match === null) return { success: false, reason: "invalid" }
    decodedTrace = { traceId: match[1] as string, spanId: match[2] as string }
  }
  return parseCausalityContext({
    executionId,
    current: { kind: nodeKind, id: nodeId },
    ...(decodedTrace === undefined ? {} : { trace: decodedTrace }),
  })
}

interface MemoryEntry {
  readonly sequence: number
  readonly canonical: string
  readonly record: CausalityRecord
}

export interface MemoryCausalityStoreOptions {
  /** Global record bound. Default 10,000. */
  readonly maxRecords?: number
  /** In-memory evidence disappears on restart and is rejected in production unless explicitly allowed. */
  readonly allowInProduction?: boolean
}

const timelineCursor = (entry: MemoryEntry): string =>
  `${entry.record.node.at.toString(36)}:${entry.sequence.toString(36)}`

function timelineLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_TIMELINE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) {
    throw new RangeError(
      `causality: timeline limit must be an integer from 1 to ${MAX_TIMELINE_LIMIT}`,
    )
  }
  return limit
}

/** Bounded dev/test graph store. Production callers should provide a durable adapter. */
export function createMemoryCausalityStore(
  options: MemoryCausalityStoreOptions = {},
): CausalityGraphStore {
  if (
    typeof process !== "undefined" &&
    process.env.NODE_ENV === "production" &&
    !options.allowInProduction
  ) {
    throw new Error(
      "causality: the memory store is not durable; configure a production graph adapter",
    )
  }
  const maxRecords = options.maxRecords ?? 10_000
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new RangeError("causality: maxRecords must be a positive safe integer")
  }
  const byNode = new Map<string, MemoryEntry>()
  const byExecution = new Map<string, MemoryEntry[]>()
  let sequence = 0

  return {
    async record(input) {
      const parsed = parseCausalityRecord(input)
      if (!parsed.success) throw new TypeError(`causality: invalid record (${parsed.reason})`)
      const record = parsed.record
      const key = `${record.executionId}\n${record.node.kind}\n${record.node.id}`
      const canonical = JSON.stringify(record)
      const prior = byNode.get(key)
      if (prior !== undefined) {
        if (prior.canonical !== canonical) {
          throw new CausalityConflictError(record.executionId, record.node)
        }
        return "duplicate"
      }
      if (byNode.size >= maxRecords) throw new CausalityCapacityError(maxRecords)
      const entry = Object.freeze({ sequence: sequence++, canonical, record })
      byNode.set(key, entry)
      const execution = byExecution.get(record.executionId) ?? []
      execution.push(entry)
      byExecution.set(record.executionId, execution)
      return "inserted"
    },
    async timeline(rawExecutionId, query = {}) {
      const executionId = identity(rawExecutionId, "executionId")
      const limit = timelineLimit(query.limit)
      const entries = [...(byExecution.get(executionId) ?? [])].sort(
        (left, right) =>
          left.record.node.at - right.record.node.at || left.sequence - right.sequence,
      )
      let start = 0
      if (query.after !== undefined) {
        const index = entries.findIndex((entry) => timelineCursor(entry) === query.after)
        if (index < 0) throw new TypeError("causality: invalid timeline cursor")
        start = index + 1
      }
      const selected = entries.slice(start, start + limit)
      const hasMore = start + selected.length < entries.length
      return Object.freeze({
        items: Object.freeze(
          selected.map((entry) =>
            Object.freeze({ cursor: timelineCursor(entry), record: entry.record }),
          ),
        ),
        ...(hasMore && selected.length > 0
          ? { nextCursor: timelineCursor(selected[selected.length - 1] as MemoryEntry) }
          : {}),
      })
    },
  }
}
