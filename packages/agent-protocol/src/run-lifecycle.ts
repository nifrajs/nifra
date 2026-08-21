/**
 * Additive run-lifecycle contracts: content-free run snapshots, evidence-event envelopes, handoff
 * snapshots, feature negotiation, and cursor resume. These layer on top of the orchestration value
 * contracts without changing `AGENT_PROTOCOL_VERSION`, and - like the evidence contract - carry no
 * payload content.
 *
 * Two decoder disciplines live here on purpose:
 *  - Transport decoders ({@link parseRunSnapshot}, {@link parseHandoffSnapshot},
 *    {@link parseRunPlanRef}, and the envelope of {@link parseRunEvidenceEvent}) are lenient about
 *    unknown additive fields so a newer host can add optional metadata without breaking an older
 *    client. They still reject any {@link FORBIDDEN_CONTENT_KEYS} so a payload can never ride along.
 *  - The evidence sink stays strict: the inner record of a {@link RunEvidenceEvent} is validated by
 *    {@link parseRunEvidence}, which accepts only the declared content-free keys.
 */

import {
  FORBIDDEN_CONTENT_KEYS,
  parseRunEvidence,
  RunContractError,
  type RunEvidence,
} from "./orchestration.ts"

/** Run-lifecycle contract version. Additive to the session `AGENT_PROTOCOL_VERSION`. */
export const RUN_LIFECYCLE_VERSION = 1 as const

/** Terminal-or-transient state of a run as observed through evidence. */
export type RunLifecycleState =
  | "submitted"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"

const RUN_LIFECYCLE_STATES: readonly RunLifecycleState[] = [
  "submitted",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]

/** Handoff resolution state, surfaced content-free. */
export type HandoffStatus = "pending" | "accepted" | "declined"

const HANDOFF_STATUSES: readonly HandoffStatus[] = ["pending", "accepted", "declined"]

// ── Value contracts ───────────────────────────────────────────────────────────────────────────

/** A content-free pointer to the plan a run is executing. */
export interface RunPlanRef {
  readonly id: string
  /** SHA-256 hex of the canonical plan. Content-free. */
  readonly digest: string
  readonly nodeCount: number
}

/** Running tallies over a run's evidence stream. */
export interface RunCounters {
  readonly total: number
  readonly completed: number
  readonly failed: number
}

/**
 * The bounded current view of a run: its plan pointer, lifecycle state, resume cursor, and counters.
 * `cursor` is the highest evidence `seq` reflected here; a client resumes with everything after it.
 */
export interface RunSnapshot {
  readonly version: typeof RUN_LIFECYCLE_VERSION
  readonly runId: string
  readonly plan: RunPlanRef
  readonly state: RunLifecycleState
  /** Highest evidence seq reflected in this snapshot, or -1 before any evidence. */
  readonly cursor: number
  readonly counters: RunCounters
  readonly updatedAt: number
  readonly failureCode?: string
}

/** A content-free pointer to one evidence record, with the stable dedupe identity. */
export interface EvidenceRef {
  readonly runId: string
  readonly seq: number
  /** Stable per-record identity: `${runId}:${seq}`. */
  readonly eventId: string
}

/** A transport envelope wrapping one strict evidence record with its stable dedupe identity. */
export interface RunEvidenceEvent {
  readonly version: typeof RUN_LIFECYCLE_VERSION
  /** Stable per-record identity: `${runId}:${seq}` of the inner evidence. */
  readonly eventId: string
  readonly evidence: RunEvidence
}

/** A content-free snapshot of one handoff between roles/agents within a run. */
export interface HandoffSnapshot {
  readonly version: typeof RUN_LIFECYCLE_VERSION
  readonly runId: string
  readonly nodeId: string
  readonly seq: number
  /** Caller-opaque role identifiers. Non-secret structural coordinates. */
  readonly from: string
  readonly to: string
  readonly status: HandoffStatus
  readonly reason?: string
}

/** The stable dedupe identity for an evidence record. */
export function evidenceEventId(runId: string, seq: number): string {
  return `${runId}:${seq}`
}

// ── Feature negotiation ───────────────────────────────────────────────────────────────────────

/** The result of reconciling a client's requested features against a host's offered set. */
export interface FeatureNegotiation {
  /** Requested features the host offers, sorted and de-duplicated. */
  readonly granted: readonly string[]
  /** Requested features the host does not offer, sorted and de-duplicated. */
  readonly unsupported: readonly string[]
}

/**
 * Reconcile requested features against the offered set. A requested feature the host does not offer
 * is reported as unsupported rather than silently dropped, so a client can degrade deliberately.
 */
export function negotiateFeatures(
  offered: readonly string[],
  requested: readonly string[],
): FeatureNegotiation {
  const offeredSet = new Set(offered)
  const granted = new Set<string>()
  const unsupported = new Set<string>()
  for (const feature of requested) {
    if (offeredSet.has(feature)) granted.add(feature)
    else unsupported.add(feature)
  }
  return {
    granted: Object.freeze([...granted].sort()),
    unsupported: Object.freeze([...unsupported].sort()),
  }
}

// ── Cursor resume ─────────────────────────────────────────────────────────────────────────────

export type CursorResyncReason = "stale_cursor"

/** Events after the cursor were retained; deliver them and advance. */
export interface CursorResumeOk<T> {
  readonly status: "ok"
  readonly events: readonly T[]
  /** Highest seq now delivered, or the input cursor when nothing followed it. */
  readonly nextCursor: number
}

/** The bounded window no longer contains the record after the cursor; a full resync is required. */
export interface CursorResyncRequired {
  readonly status: "resync_required"
  readonly reason: CursorResyncReason
  readonly earliest: number
  readonly latest: number
}

export type CursorResume<T> = CursorResumeOk<T> | CursorResyncRequired

/** Sentinel cursor meaning "before any record". A fresh subscription passes this or `undefined`. */
export const CURSOR_BEFORE_ALL = -1

/**
 * Resume an ordered, seq-keyed window from a cursor.
 *
 * The window must be sorted by ascending, strictly increasing `seq`. `cursor` is the last seq the
 * client already holds; `undefined` (or {@link CURSOR_BEFORE_ALL}) means the client holds nothing.
 * If the record immediately after the cursor was already evicted from the bounded window, a gap
 * exists and this returns `resync_required` with reason `stale_cursor` rather than silently skipping.
 */
export function resumeFromCursor<T extends { readonly seq: number }>(
  window: readonly T[],
  cursor?: number,
): CursorResume<T> {
  let previous = Number.NEGATIVE_INFINITY
  for (const entry of window) {
    if (!Number.isSafeInteger(entry.seq) || entry.seq < 0)
      throw new RunContractError("cursor window seq must be a non-negative integer")
    if (entry.seq <= previous)
      throw new RunContractError("cursor window must be sorted by strictly increasing seq")
    previous = entry.seq
  }

  const from = cursor === undefined ? CURSOR_BEFORE_ALL : cursor
  if (!Number.isSafeInteger(from) || from < CURSOR_BEFORE_ALL)
    throw new RunContractError("cursor must be a safe integer >= -1")

  if (window.length === 0)
    return {
      status: "ok",
      events: Object.freeze([]),
      nextCursor: Math.max(from, CURSOR_BEFORE_ALL),
    }

  const earliest = (window[0] as T).seq
  const latest = (window[window.length - 1] as T).seq

  // A real cursor whose next record (from + 1) predates our window lost a gap to eviction. A fresh
  // subscriber (CURSOR_BEFORE_ALL) has no continuity expectation and always takes the whole window.
  if (from >= 0 && from + 1 < earliest)
    return { status: "resync_required", reason: "stale_cursor", earliest, latest }

  const events = window.filter((entry) => entry.seq > from)
  const nextCursor = events.length > 0 ? (events[events.length - 1] as T).seq : from
  return { status: "ok", events: Object.freeze(events), nextCursor }
}

// ── Decoders ──────────────────────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNoForbiddenKeys(record: Record<string, unknown>, where: string): void {
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    if (key in record) throw new RunContractError(`${where} carries forbidden content key '${key}'`)
  }
}

function str(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0)
    throw new RunContractError(`${where}.${key} must be a non-empty string`)
  return value
}

function nonNegInt(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new RunContractError(`${where}.${key} must be a non-negative integer`)
  return value
}

/** Decode a content-free plan reference. Lenient about unknown additive keys, never content. */
export function parseRunPlanRef(value: unknown): RunPlanRef {
  if (!isRecord(value)) throw new RunContractError("run plan ref must be an object")
  assertNoForbiddenKeys(value, "run plan ref")
  const digest = str(value, "digest", "run plan ref")
  if (!HEX64.test(digest)) throw new RunContractError("run plan ref.digest must be sha256 hex")
  return {
    id: str(value, "id", "run plan ref"),
    digest,
    nodeCount: nonNegInt(value, "nodeCount", "run plan ref"),
  }
}

function parseCounters(value: unknown): RunCounters {
  if (!isRecord(value)) throw new RunContractError("run snapshot.counters must be an object")
  assertNoForbiddenKeys(value, "run snapshot.counters")
  return {
    total: nonNegInt(value, "total", "run snapshot.counters"),
    completed: nonNegInt(value, "completed", "run snapshot.counters"),
    failed: nonNegInt(value, "failed", "run snapshot.counters"),
  }
}

/**
 * Decode a bounded run snapshot. Forward-compatible: unknown additive fields are ignored so an
 * older client tolerates a newer host. Forbidden content keys are still rejected.
 */
export function parseRunSnapshot(value: unknown): RunSnapshot {
  if (!isRecord(value)) throw new RunContractError("run snapshot must be an object")
  assertNoForbiddenKeys(value, "run snapshot")
  if (value.version !== RUN_LIFECYCLE_VERSION)
    throw new RunContractError(`run snapshot.version must be ${RUN_LIFECYCLE_VERSION}`)
  const state = value.state
  if (typeof state !== "string" || !RUN_LIFECYCLE_STATES.includes(state as RunLifecycleState))
    throw new RunContractError("run snapshot.state is invalid")
  const cursor = value.cursor
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < CURSOR_BEFORE_ALL)
    throw new RunContractError("run snapshot.cursor must be a safe integer >= -1")
  const snapshot: RunSnapshot = {
    version: RUN_LIFECYCLE_VERSION,
    runId: str(value, "runId", "run snapshot"),
    plan: parseRunPlanRef(value.plan),
    state: state as RunLifecycleState,
    cursor,
    counters: parseCounters(value.counters),
    updatedAt: nonNegInt(value, "updatedAt", "run snapshot"),
    ...(value.failureCode !== undefined
      ? { failureCode: str(value, "failureCode", "run snapshot") }
      : {}),
  }
  return snapshot
}

/**
 * Decode an evidence-event envelope. The envelope is forward-compatible, but the inner record is
 * validated strictly by {@link parseRunEvidence}, and its identity must match `${runId}:${seq}`.
 */
export function parseRunEvidenceEvent(value: unknown): RunEvidenceEvent {
  if (!isRecord(value)) throw new RunContractError("run evidence event must be an object")
  assertNoForbiddenKeys(value, "run evidence event")
  if (value.version !== RUN_LIFECYCLE_VERSION)
    throw new RunContractError(`run evidence event.version must be ${RUN_LIFECYCLE_VERSION}`)
  const evidence = parseRunEvidence(value.evidence)
  const expected = evidenceEventId(evidence.runId, evidence.seq)
  if (value.eventId !== undefined && value.eventId !== expected)
    throw new RunContractError("run evidence event.eventId must match the inner record identity")
  return { version: RUN_LIFECYCLE_VERSION, eventId: expected, evidence }
}

/**
 * Decode a handoff snapshot. Forward-compatible about unknown additive fields; forbidden content
 * keys are rejected.
 */
export function parseHandoffSnapshot(value: unknown): HandoffSnapshot {
  if (!isRecord(value)) throw new RunContractError("handoff snapshot must be an object")
  assertNoForbiddenKeys(value, "handoff snapshot")
  if (value.version !== RUN_LIFECYCLE_VERSION)
    throw new RunContractError(`handoff snapshot.version must be ${RUN_LIFECYCLE_VERSION}`)
  const status = value.status
  if (typeof status !== "string" || !HANDOFF_STATUSES.includes(status as HandoffStatus))
    throw new RunContractError("handoff snapshot.status is invalid")
  const snapshot: HandoffSnapshot = {
    version: RUN_LIFECYCLE_VERSION,
    runId: str(value, "runId", "handoff snapshot"),
    nodeId: str(value, "nodeId", "handoff snapshot"),
    seq: nonNegInt(value, "seq", "handoff snapshot"),
    from: str(value, "from", "handoff snapshot"),
    to: str(value, "to", "handoff snapshot"),
    status: status as HandoffStatus,
    ...(value.reason !== undefined ? { reason: str(value, "reason", "handoff snapshot") } : {}),
  }
  return snapshot
}
