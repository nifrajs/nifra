/**
 * Content-free projection of the dead-letter queue.
 *
 * A dead-letter record carries the last error as free text, and free text can carry payloads -
 * request bodies, user input echoed by a validator, connection strings. Nothing browser-facing may
 * see it. This module projects `{ id, name, error }` down to `{ id, name, errorFingerprint }`: the
 * identity needed to triage plus a deterministic grouping key for identical failures. The error
 * text itself stays server-side (logs), exactly like prompt/tool content stays out of
 * `@nifrajs/agent-app` view models.
 *
 * Feed: `MemoryJobStore.deadLetters()` (or any durable store's equivalent listing). Sink: queue
 * health endpoints, the local Workbench replay fixture, and - via `agent-app`'s
 * `EvidenceTimelineView` `dead-lettered` status - run timelines. The projection is the boundary.
 */

/** The store-side shape this projects. Structural so durable adapters need no jobs import. */
export interface DeadLetterRecord {
  readonly id: string
  readonly name: string
  readonly error: string
}

/** What leaves the server: identity plus a grouping key. Never the error text. */
export interface DeadLetterView {
  readonly id: string
  readonly name: string
  /** FNV-1a 32-bit hex of the error text. This is grouping metadata, not a confidentiality boundary. */
  readonly errorFingerprint: string
}

/** Queue health counters. A straight passthrough of `JobStore.counts()` - counters are safe. */
export interface QueueHealth {
  readonly pending: number
  readonly active: number
  readonly dead: number
}

const MAX_ID_LENGTH = 128
const MAX_NAME_LENGTH = 128
const MAX_ERROR_LENGTH = 64 * 1024

function fingerprintError(error: string): string {
  let hash = 0x81_1c_9d_c5
  for (let index = 0; index < error.length; index++) {
    hash ^= error.charCodeAt(index)
    hash = Math.imul(hash, 0x01_00_01_93)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function assertRecord(record: unknown, index: number): asserts record is DeadLetterRecord {
  if (record === null || typeof record !== "object")
    throw new TypeError(`dead-letter-view: record at index ${index} must be an object`)
  const value = record as {
    readonly id?: unknown
    readonly name?: unknown
    readonly error?: unknown
  }
  if (typeof value.id !== "string" || value.id === "")
    throw new TypeError(`dead-letter-view: record id at index ${index} must be a non-empty string`)
  if (value.id.length > MAX_ID_LENGTH)
    throw new TypeError(
      `dead-letter-view: record id at index ${index} exceeds length ${MAX_ID_LENGTH}`,
    )
  if (typeof value.name !== "string" || value.name === "")
    throw new TypeError(
      `dead-letter-view: record name at index ${index} must be a non-empty string`,
    )
  if (value.name.length > MAX_NAME_LENGTH)
    throw new TypeError(
      `dead-letter-view: record name at index ${index} exceeds length ${MAX_NAME_LENGTH}`,
    )
  if (typeof value.error !== "string")
    throw new TypeError(`dead-letter-view: record error at index ${index} must be a string`)
  if (value.error.length > MAX_ERROR_LENGTH)
    throw new TypeError(
      `dead-letter-view: record error at index ${index} exceeds length ${MAX_ERROR_LENGTH}`,
    )
}

/** Project dead-letter records to content-free views. Throws on malformed input, never partial. */
export function toDeadLetterView(records: readonly DeadLetterRecord[]): readonly DeadLetterView[] {
  if (!Array.isArray(records)) throw new TypeError("dead-letter-view: records must be an array")
  const views: DeadLetterView[] = []
  for (let index = 0; index < records.length; index++) {
    if (!Object.hasOwn(records, index))
      throw new TypeError(`dead-letter-view: record at index ${index} is missing`)
    const record = records[index]
    assertRecord(record, index)
    views.push(
      Object.freeze({
        id: record.id,
        name: record.name,
        errorFingerprint: fingerprintError(record.error),
      }),
    )
  }
  return Object.freeze(views)
}

/** Project store counts to a health snapshot. Non-negative integers only; anything else throws. */
export function toQueueHealth(counts: {
  readonly pending: number
  readonly active: number
  readonly dead: number
}): QueueHealth {
  if (counts === null || typeof counts !== "object" || Array.isArray(counts))
    throw new TypeError("dead-letter-view: counts must be an object")
  const source = counts as Record<string, unknown>
  const keys = ["pending", "active", "dead"] as const
  for (const key of keys) {
    if (!Object.hasOwn(source, key))
      throw new TypeError(`dead-letter-view: counts.${key} is required`)
    const value = source[key]
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new TypeError(`dead-letter-view: counts.${key} must be a non-negative safe integer`)
  }
  for (const key of Object.keys(source)) {
    if (!keys.includes(key as (typeof keys)[number]))
      throw new TypeError(`dead-letter-view: counts.${key} is an unknown counter`)
  }
  return Object.freeze({
    pending: source.pending as number,
    active: source.active as number,
    dead: source.dead as number,
  })
}
