/**
 * Evidence-only run stores. A store keeps a bounded live window of the most recent
 * {@link RunEvidence} records, a set of order-independent aggregates (completed node ids, artifact
 * refs, counters), and an order-independent terminal digest - never the whole stream, so a 100k-event
 * run stays bounded in memory. Every record is re-parsed through {@link parseRunEvidence} on the way
 * in, so a payload-bearing or oversized record cannot be written through either store: the parser is
 * the privacy gate, not the caller's discipline.
 *
 * There is no dependency on `FileSessionStore` or any session machinery: these stores hold run
 * evidence only, and the file store persists exactly the content-free record it parsed.
 */

import { appendFile } from "node:fs/promises"
import type { ArtifactRef, RunEvidence } from "@nifrajs/agent-protocol"
import { assertEvidenceSize, parseRunEvidence } from "@nifrajs/agent-protocol"
import { canonicalJson } from "./hash.ts"

/** Terminal tally of a run's evidence stream. Counts only; no payloads. */
export interface EvidenceCounters {
  readonly total: number
  readonly started: number
  readonly completed: number
  readonly failed: number
}

/** A bounded, evidence-only run store. Append is fail-closed; reads are content-free aggregates. */
export interface EvidenceStore {
  /** Parse, tally, and persist one record. Throws on a payload-bearing or oversized record. */
  append(record: RunEvidence): Promise<void>
  /** Total records appended (not the live-window size). */
  readonly count: number
  /** The most recent records, oldest first, capped at the configured window. */
  live(): readonly RunEvidence[]
  counters(): EvidenceCounters
  /** Distinct node ids that reached `completed`, sorted for determinism. */
  completedNodeIds(): readonly string[]
  /** Every artifact ref referenced by the stream, in append order. */
  artifacts(): readonly ArtifactRef[]
  /** Order-independent SHA-256 of the run's outcome multiset (parallel order cannot change it). */
  digest(): Promise<string>
}

const DEFAULT_MAX_LIVE = 1024
const encoder = new TextEncoder()

async function sha256Bytes(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text))
  return new Uint8Array(digest)
}

/**
 * The identity of one record for the terminal digest: node outcome only. `seq`, `durationMs`, and
 * `runId` are excluded so two runs of the same plan (or the same plan under a different parallel
 * schedule) produce an identical digest - the deterministic-eval anchor. Each node emits at most one
 * record per status, so XOR accumulation never cancels a distinct outcome.
 */
function digestKey(record: RunEvidence): string {
  return canonicalJson({
    planDigest: record.planDigest,
    nodeId: record.nodeId,
    status: record.status,
    idempotent: record.idempotent,
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    ...(record.effectKey !== undefined ? { effectKey: record.effectKey } : {}),
    ...(record.artifacts !== undefined ? { artifacts: record.artifacts } : {}),
  })
}

/** Shared accumulator: bounded ring window plus order-independent aggregates. No payload retained. */
class EvidenceAccumulator {
  private readonly max: number
  private readonly buf: RunEvidence[] = []
  private head = 0
  private filled = false
  private readonly acc = new Uint8Array(32)
  private readonly completed = new Set<string>()
  private readonly artifactRefs: ArtifactRef[] = []
  private totalCount = 0
  private startedCount = 0
  private completedCount = 0
  private failedCount = 0

  constructor(maxLive: number) {
    if (!Number.isSafeInteger(maxLive) || maxLive < 0)
      throw new RangeError("evidence store: maxLive must be a non-negative integer")
    this.max = maxLive
  }

  /** `record` is already parsed and within the size cap. */
  async add(record: RunEvidence): Promise<void> {
    this.totalCount++
    if (record.status === "started") this.startedCount++
    else if (record.status === "completed") {
      this.completedCount++
      this.completed.add(record.nodeId)
    } else this.failedCount++
    if (record.artifacts !== undefined)
      for (const ref of record.artifacts) this.artifactRefs.push(ref)
    const hash = await sha256Bytes(digestKey(record))
    for (let i = 0; i < 32; i++) this.acc[i] = (this.acc[i] as number) ^ (hash[i] as number)
    this.pushLive(record)
  }

  private pushLive(record: RunEvidence): void {
    if (this.max === 0) return
    this.buf[this.head] = record
    this.head = (this.head + 1) % this.max
    if (this.head === 0) this.filled = true
  }

  get count(): number {
    return this.totalCount
  }

  live(): readonly RunEvidence[] {
    if (!this.filled) return this.buf.slice(0, this.head)
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)]
  }

  counters(): EvidenceCounters {
    return {
      total: this.totalCount,
      started: this.startedCount,
      completed: this.completedCount,
      failed: this.failedCount,
    }
  }

  completedNodeIds(): readonly string[] {
    return [...this.completed].sort()
  }

  artifacts(): readonly ArtifactRef[] {
    return [...this.artifactRefs]
  }

  digest(): string {
    let hex = ""
    for (let i = 0; i < 32; i++) hex += (this.acc[i] as number).toString(16).padStart(2, "0")
    return hex
  }
}

/** Normalize on the way in: re-parse (content-free gate) then re-check the size cap. */
function normalize(record: RunEvidence): RunEvidence {
  const parsed = parseRunEvidence(record)
  assertEvidenceSize(parsed)
  return parsed
}

export interface MemoryEvidenceStoreOptions {
  /** Records retained in the live window. Older records fall out; aggregates still count them. */
  readonly maxLive?: number
}

/** A fully in-memory bounded store. Keeps a window plus aggregates; never the whole stream. */
export class MemoryEvidenceStore implements EvidenceStore {
  private readonly accumulator: EvidenceAccumulator

  constructor(options: MemoryEvidenceStoreOptions = {}) {
    this.accumulator = new EvidenceAccumulator(options.maxLive ?? DEFAULT_MAX_LIVE)
  }

  async append(record: RunEvidence): Promise<void> {
    await this.accumulator.add(normalize(record))
  }

  get count(): number {
    return this.accumulator.count
  }
  live(): readonly RunEvidence[] {
    return this.accumulator.live()
  }
  counters(): EvidenceCounters {
    return this.accumulator.counters()
  }
  completedNodeIds(): readonly string[] {
    return this.accumulator.completedNodeIds()
  }
  artifacts(): readonly ArtifactRef[] {
    return this.accumulator.artifacts()
  }
  async digest(): Promise<string> {
    return this.accumulator.digest()
  }
}

export interface FileEvidenceStoreOptions {
  /** Append-only newline-delimited file. One canonical JSON record per line, in append order. */
  readonly path: string
  readonly maxLive?: number
}

/**
 * A bounded store that also appends each parsed record as one canonical-JSON line to a file, in
 * deterministic append order. The record is normalized (and so a forbidden-content record is
 * rejected) BEFORE the line is written, so the file never receives a payload. The append uses the
 * `a` flag, so each record is one O_APPEND write.
 */
export class FileEvidenceStore implements EvidenceStore {
  private readonly accumulator: EvidenceAccumulator
  private readonly path: string

  constructor(options: FileEvidenceStoreOptions) {
    this.path = options.path
    this.accumulator = new EvidenceAccumulator(options.maxLive ?? DEFAULT_MAX_LIVE)
  }

  async append(record: RunEvidence): Promise<void> {
    const parsed = normalize(record)
    await this.accumulator.add(parsed)
    await appendFile(this.path, `${canonicalJson(parsed)}\n`, { flag: "a" })
  }

  get count(): number {
    return this.accumulator.count
  }
  live(): readonly RunEvidence[] {
    return this.accumulator.live()
  }
  counters(): EvidenceCounters {
    return this.accumulator.counters()
  }
  completedNodeIds(): readonly string[] {
    return this.accumulator.completedNodeIds()
  }
  artifacts(): readonly ArtifactRef[] {
    return this.accumulator.artifacts()
  }
  async digest(): Promise<string> {
    return this.accumulator.digest()
  }
}
