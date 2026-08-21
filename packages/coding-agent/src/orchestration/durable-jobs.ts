/**
 * Adapter from the dependency-free jobs lease contract to run-node dispatch.
 *
 * The supplied JobStore should be dedicated to this adapter (JobStore has no claim-by-name
 * operation). Its persisted payload is the parsed, content-free RunDispatch identity. The adapter
 * adds lease generations and rejects stale completions in-process; a durable operated implementation
 * must enforce the same compare-and-commit rule in its data layer.
 */

import type { JobStore, StoredJob } from "@nifrajs/jobs"
import { MemoryJobStore } from "@nifrajs/jobs"
import {
  DISPATCH_JOB_NAME,
  type DispatchInspection,
  type DispatchResultCode,
  type DispatchState,
  type DispatchWriteResult,
  deriveRunIdempotencyKey,
  parseRunCheckpoint,
  parseRunDispatch,
  parseRunDispatchEvidence,
  parseRunLease,
  RUN_DISPATCH_VERSION,
  type RunCheckpoint,
  type RunDispatch,
  type RunDispatchEvidence,
  type RunDispatchStore,
  type RunLease,
} from "./dispatch.ts"

export interface DurableJobsStoreOptions {
  /** A dedicated at-least-once JobStore. Defaults to disposable in-memory storage. */
  readonly store?: JobStore
  /** Injected time source used for lease and cancellation decisions. */
  readonly now?: () => number
}

interface Entry {
  readonly dispatch: RunDispatch
  readonly jobId: string
  state: DispatchState
  attempt: number
  generation: number
  leaseId: string | undefined
  leaseUntil: number
  lease: RunLease | undefined
  checkpoint: RunCheckpoint | undefined
  readonly evidence: RunDispatchEvidence[]
}

function code(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(value))
    throw new TypeError("dispatch code must be a stable token")
  return value
}

function result(codeValue: DispatchResultCode): DispatchWriteResult {
  return { ok: codeValue === "accepted", code: codeValue }
}

function leaseMatches(entry: Entry | undefined, lease: RunLease): entry is Entry {
  return (
    entry !== undefined &&
    entry.leaseId === lease.leaseId &&
    entry.generation === lease.generation &&
    entry.attempt === lease.attempt &&
    entry.dispatch.dispatchId === lease.dispatch.dispatchId &&
    entry.dispatch.planDigest === lease.dispatch.planDigest &&
    entry.dispatch.nodeId === lease.dispatch.nodeId &&
    entry.lease?.idempotencyKey === lease.idempotencyKey
  )
}

function isTerminal(state: DispatchState): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "dead-lettered"
  )
}

function evidenceFor(
  entry: Entry,
  state: DispatchState,
  at: number,
  scheduleToken: string,
  idempotencyKey: string,
  codeValue?: string,
): RunDispatchEvidence {
  return parseRunDispatchEvidence({
    version: RUN_DISPATCH_VERSION,
    dispatchId: entry.dispatch.dispatchId,
    runId: entry.dispatch.runId,
    nodeId: entry.dispatch.nodeId,
    state,
    attempt: entry.attempt,
    generation: entry.generation,
    at,
    scheduleToken,
    idempotencyKey,
    ...(codeValue === undefined ? {} : { code: code(codeValue) }),
  })
}

function appendEvidence(entry: Entry, item: RunDispatchEvidence): void {
  entry.evidence.push(parseRunDispatchEvidence(item))
}

function dispatchFromJob(job: StoredJob): RunDispatch {
  if (job.name !== DISPATCH_JOB_NAME) throw new TypeError("jobs adapter received an unrelated job")
  return parseRunDispatch(job.payload)
}

/**
 * Create an at-least-once run dispatch store over an existing JobStore.
 *
 * JobStore's `attempt` increments only when a caller explicitly retries; an expired lease is
 * redelivered at the same logical attempt, which is what makes the idempotency key stable across a
 * duplicate delivery. A retry intentionally advances the logical attempt and gets a new key.
 */
export function createDurableJobsStore(options: DurableJobsStoreOptions = {}): RunDispatchStore & {
  readonly jobs: JobStore
  deadLetters(): readonly RunDispatchEvidence[]
} {
  const jobs = options.store ?? new MemoryJobStore()
  const now = options.now ?? (() => Date.now())
  const byJobId = new Map<string, Entry>()
  const byDispatchId = new Map<string, Entry>()
  let generation = 0
  const dead: RunDispatchEvidence[] = []

  async function enqueue(source: RunDispatch): Promise<void> {
    const dispatch = parseRunDispatch(source)
    if (byDispatchId.has(dispatch.dispatchId)) throw new Error("duplicate dispatch id")
    const jobId = await jobs.enqueue({
      name: DISPATCH_JOB_NAME,
      payload: dispatch,
      runAt: dispatch.notBefore,
      maxAttempts: dispatch.maxAttempts,
    })
    const entry: Entry = {
      dispatch,
      jobId,
      state: "queued",
      attempt: 1,
      generation: 0,
      leaseId: undefined,
      leaseUntil: 0,
      lease: undefined,
      checkpoint: undefined,
      evidence: [],
    }
    byJobId.set(jobId, entry)
    byDispatchId.set(dispatch.dispatchId, entry)
  }

  async function lease(at: number, limit: number, leaseMs: number): Promise<RunLease[]> {
    if (!Number.isSafeInteger(at) || at < 0) throw new RangeError("dispatch lease time is invalid")
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("dispatch lease limit is invalid")
    if (!Number.isFinite(leaseMs) || leaseMs <= 0)
      throw new RangeError("dispatch lease duration is invalid")
    const jobsLeased = await jobs.lease(at, limit, leaseMs)
    const resultLeases: RunLease[] = []
    for (const job of jobsLeased) {
      const dispatch = dispatchFromJob(job)
      const entry = byJobId.get(job.id) ?? byDispatchId.get(dispatch.dispatchId)
      if (entry === undefined) throw new Error("jobs adapter lost dispatch identity")
      if (isTerminal(entry.state)) continue
      entry.state = "leased"
      entry.attempt = job.attempt + 1
      entry.generation = ++generation
      entry.leaseUntil = at + leaseMs
      entry.leaseId = `${job.id}:${entry.generation}`
      const idempotencyKey = await deriveRunIdempotencyKey(
        dispatch.planDigest,
        dispatch.runId,
        dispatch.nodeId,
        entry.attempt,
      )
      const value = parseRunLease({
        version: RUN_DISPATCH_VERSION,
        leaseId: entry.leaseId,
        dispatch,
        attempt: entry.attempt,
        generation: entry.generation,
        leasedAt: at,
        leaseUntil: entry.leaseUntil,
        scheduleToken: `${job.id}:${entry.generation}`,
        idempotencyKey,
      })
      entry.lease = value
      appendEvidence(
        entry,
        evidenceFor(entry, "leased", at, value.scheduleToken, value.idempotencyKey),
      )
      resultLeases.push(value)
    }
    return resultLeases
  }

  function current(lease: RunLease): Entry | undefined {
    return byDispatchId.get(lease.dispatch.dispatchId)
  }

  async function checkpoint(lease: RunLease, source: RunCheckpoint): Promise<DispatchWriteResult> {
    const value = parseRunCheckpoint(source)
    const entry = current(lease)
    if (!leaseMatches(entry, lease)) return result("stale_lease")
    if (entry.state === "cancelled") return result("cancelled")
    if (isTerminal(entry.state)) return result("terminal")
    if (now() >= entry.leaseUntil) return result("stale_lease")
    if (
      value.dispatchId !== lease.dispatch.dispatchId ||
      value.runId !== lease.dispatch.runId ||
      value.nodeId !== lease.dispatch.nodeId ||
      value.attempt !== lease.attempt ||
      value.generation !== lease.generation ||
      value.idempotencyKey !== lease.idempotencyKey
    )
      return result("invalid_checkpoint")
    entry.checkpoint = value
    entry.state = "checkpointed"
    appendEvidence(
      entry,
      evidenceFor(entry, "checkpointed", value.at, value.scheduleToken, value.idempotencyKey),
    )
    return result("accepted")
  }

  async function complete(
    lease: RunLease,
    source?: RunDispatchEvidence,
  ): Promise<DispatchWriteResult> {
    const entry = current(lease)
    if (!leaseMatches(entry, lease)) return result("stale_lease")
    if (entry.state === "cancelled") return result("cancelled")
    if (isTerminal(entry.state)) return result("terminal")
    if (now() >= entry.leaseUntil) return result("stale_lease")
    if (source !== undefined) {
      const evidence = parseRunDispatchEvidence(source)
      if (
        evidence.dispatchId !== lease.dispatch.dispatchId ||
        evidence.attempt !== lease.attempt ||
        evidence.generation !== lease.generation ||
        evidence.idempotencyKey !== lease.idempotencyKey
      )
        return result("invalid_checkpoint")
    }
    await jobs.complete(entry.jobId)
    entry.state = "succeeded"
    appendEvidence(
      entry,
      source ?? evidenceFor(entry, "succeeded", now(), lease.scheduleToken, lease.idempotencyKey),
    )
    entry.lease = undefined
    return result("accepted")
  }

  async function retry(
    lease: RunLease,
    runAt: number,
    failureCode: string,
  ): Promise<DispatchWriteResult> {
    const entry = current(lease)
    if (!leaseMatches(entry, lease)) return result("stale_lease")
    if (entry.state === "cancelled") return result("cancelled")
    if (isTerminal(entry.state)) return result("terminal")
    if (now() >= entry.leaseUntil) return result("stale_lease")
    if (!Number.isSafeInteger(runAt) || runAt < 0)
      throw new RangeError("dispatch retry time is invalid")
    await jobs.retry(entry.jobId, runAt)
    entry.state = "retrying"
    entry.checkpoint = undefined
    appendEvidence(
      entry,
      evidenceFor(entry, "retrying", now(), lease.scheduleToken, lease.idempotencyKey, failureCode),
    )
    entry.lease = undefined
    return result("accepted")
  }

  async function deadLetter(lease: RunLease, failureCode: string): Promise<DispatchWriteResult> {
    const entry = current(lease)
    if (!leaseMatches(entry, lease)) return result("stale_lease")
    if (entry.state === "cancelled") return result("cancelled")
    if (isTerminal(entry.state)) return result("terminal")
    if (now() >= entry.leaseUntil) return result("stale_lease")
    const stableCode = code(failureCode)
    await jobs.deadLetter(entry.jobId, stableCode)
    entry.state = "dead-lettered"
    const evidence = evidenceFor(
      entry,
      "dead-lettered",
      now(),
      lease.scheduleToken,
      lease.idempotencyKey,
      stableCode,
    )
    appendEvidence(entry, evidence)
    dead.push(evidence)
    entry.lease = undefined
    return result("accepted")
  }

  async function cancel(runId: string, cancellationCode = "cancelled"): Promise<number> {
    const stableCode = code(cancellationCode)
    let changed = 0
    for (const entry of byDispatchId.values()) {
      if (entry.dispatch.runId !== runId || isTerminal(entry.state)) continue
      entry.state = "cancelled"
      changed++
      const lease = entry.lease
      appendEvidence(
        entry,
        evidenceFor(
          entry,
          "cancelled",
          now(),
          lease?.scheduleToken ?? `${entry.jobId}:cancel`,
          lease?.idempotencyKey ??
            (await deriveRunIdempotencyKey(
              entry.dispatch.planDigest,
              entry.dispatch.runId,
              entry.dispatch.nodeId,
              entry.attempt,
            )),
          stableCode,
        ),
      )
      if (lease !== undefined) await jobs.deadLetter(entry.jobId, stableCode)
      else await jobs.deadLetter(entry.jobId, stableCode)
      entry.lease = undefined
    }
    return changed
  }

  function inspect(dispatchId: string): DispatchInspection | undefined {
    const entry = byDispatchId.get(dispatchId)
    if (entry === undefined) return undefined
    return Object.freeze({
      dispatch: entry.dispatch,
      state: entry.state,
      attempt: entry.attempt,
      generation: entry.generation,
      ...(entry.checkpoint === undefined ? {} : { checkpoint: entry.checkpoint }),
      evidence: Object.freeze([...entry.evidence]),
    })
  }

  return {
    jobs,
    enqueue,
    lease,
    checkpoint,
    complete,
    retry,
    deadLetter,
    cancel,
    inspect,
    deadLetters: () => Object.freeze([...dead]),
  }
}

/** Disposable local reference adapter; it makes no durability or exactly-once guarantee. */
export function createMemoryRunDispatchStore(
  options: { readonly now?: () => number } = {},
): RunDispatchStore & {
  readonly jobs: JobStore
  deadLetters(): readonly RunDispatchEvidence[]
} {
  return createDurableJobsStore({ store: new MemoryJobStore(), ...options })
}
