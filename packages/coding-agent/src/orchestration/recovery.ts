/**
 * Recovery state machine for at-least-once node dispatch.
 *
 * The machine treats every effect invocation as potentially side-effecting. A normal retry is
 * allowed only for an explicit pre-effect rejection. Once an effect has been invoked, recovery
 * requires a matching idempotency proof; without one it dead-letters the dispatch instead of
 * guessing that a duplicate is safe. This is deliberately conservative and never claims exactly
 * once delivery or hostile-code isolation.
 */

import {
  type DispatchResultCode,
  type InjectedClock,
  type RunDispatchStore,
  type RunLease,
  systemClock,
} from "./dispatch.ts"

export interface IdempotencyProofStore {
  has(key: string): boolean | Promise<boolean>
  record(key: string): void | Promise<void>
}
/** Disposable proof reference for tests and one-process local runs. */
export class MemoryIdempotencyProofStore implements IdempotencyProofStore {
  private readonly keys = new Set<string>()

  has(key: string): boolean {
    return this.keys.has(key)
  }

  record(key: string): void {
    this.keys.add(key)
  }

  keysSnapshot(): readonly string[] {
    return Object.freeze([...this.keys].sort())
  }
}

/** A side effect must explicitly confirm that its idempotency proof was durably recorded. */
export interface CommittedEffect {
  readonly committed: true
}

export interface RunEffectContext {
  readonly lease: RunLease
  readonly signal: AbortSignal
  /** Persist a content-free safe boundary; a failed write prevents the next unsafe step. */
  readonly checkpoint: (boundary: "before-effect" | "after-effect") => Promise<boolean>
}

export type RunEffect = (context: RunEffectContext) => Promise<CommittedEffect> | CommittedEffect

/** Stable pre-effect failure; it may be retried with a new logical attempt. */
export class EffectRejectedError extends Error {
  readonly code: string

  constructor(code = "effect_rejected") {
    super("run effect was rejected before the side effect boundary")
    this.name = "EffectRejectedError"
    this.code = code
  }
}

/** Simulates worker loss at a named boundary; the lease is intentionally left unresolved. */
export class RecoveryCrashError extends Error {
  readonly boundary: "before-effect" | "after-effect" | "after-checkpoint"

  constructor(boundary: "before-effect" | "after-effect" | "after-checkpoint") {
    super("worker stopped at a recovery boundary")
    this.name = "RecoveryCrashError"
    this.boundary = boundary
  }
}

export interface RecoveryMachineOptions {
  readonly store: RunDispatchStore
  readonly clock?: InjectedClock
  readonly proofStore?: IdempotencyProofStore
  readonly leaseMs?: number
  readonly retryBackoff?: (attempt: number) => number
  readonly signal?: AbortSignal
}

export interface RecoveryProcessResult {
  readonly leased: number
  readonly completed: number
  readonly retried: number
  readonly deadLettered: number
  readonly cancelled: number
}

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_BACKOFF = (attempt: number): number => Math.min(1_000 * Math.max(1, attempt), 60_000)

function stableCode(error: unknown): string {
  if (error instanceof EffectRejectedError) return error.code
  if (error instanceof RecoveryCrashError) return `worker_${error.boundary.replaceAll("-", "_")}`
  return "effect_failed"
}

function isAbort(signal: AbortSignal, error?: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError")
}

/**
 * Drives leases through safe checkpoints and terminal transitions. The caller owns the effect and
 * any real idempotency ledger; this class stores only opaque proof keys in the reference adapter.
 */
export class RunRecoveryMachine {
  private readonly store: RunDispatchStore
  private readonly clock: InjectedClock
  private readonly proofs: IdempotencyProofStore
  private readonly leaseMs: number
  private readonly retryBackoff: (attempt: number) => number
  private readonly signal: AbortSignal

  constructor(options: RecoveryMachineOptions) {
    this.store = options.store
    this.clock = options.clock ?? systemClock
    this.proofs = options.proofStore ?? new MemoryIdempotencyProofStore()
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.retryBackoff = options.retryBackoff ?? DEFAULT_BACKOFF
    this.signal = options.signal ?? new AbortController().signal
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0)
      throw new RangeError("recovery leaseMs must be positive")
  }

  /** Cancel all matching run dispatches; every late lease write then fails closed. */
  async cancel(runId: string): Promise<number> {
    return await this.store.cancel(runId, "cancelled")
  }

  /** Process one bounded lease batch. No payload is read or emitted by this coordinator. */
  async process(
    effect: RunEffect,
    options: { readonly limit?: number } = {},
  ): Promise<RecoveryProcessResult> {
    const limit = options.limit ?? 1
    const leases = await this.store.lease(this.clock.now(), limit, this.leaseMs)
    const summary = {
      leased: leases.length,
      completed: 0,
      retried: 0,
      deadLettered: 0,
      cancelled: 0,
    }
    for (const lease of leases) {
      const outcome = await this.processLease(lease, effect)
      summary.completed += outcome === "completed" ? 1 : 0
      summary.retried += outcome === "retried" ? 1 : 0
      summary.deadLettered += outcome === "dead-lettered" ? 1 : 0
      summary.cancelled += outcome === "cancelled" ? 1 : 0
    }
    return Object.freeze(summary)
  }

  private async processLease(
    lease: RunLease,
    effect: RunEffect,
  ): Promise<"completed" | "retried" | "dead-lettered" | "cancelled" | "waiting"> {
    const signal = this.signal
    if (signal.aborted) {
      await this.store.cancel(lease.dispatch.runId, "cancelled")
      return "cancelled"
    }

    const inspection = await this.store.inspect(lease.dispatch.dispatchId)
    const checkpoint = inspection?.checkpoint
    const proof = await this.proofs.has(lease.idempotencyKey)
    if (proof || checkpoint?.boundary === "after-effect") {
      if (!proof) {
        await this.store.deadLetter(lease, "idempotency_required")
        return "dead-lettered"
      }
      const completed = await this.store.complete(lease)
      return completed.ok ? "completed" : "waiting"
    }

    const before = await this.storeCheckpoint(lease, "before-effect")
    if (!before) return "waiting"
    if (signal.aborted) {
      await this.store.cancel(lease.dispatch.runId, "cancelled")
      return "cancelled"
    }

    let invoked = false
    try {
      invoked = true
      const committed = await effect({
        lease,
        signal,
        checkpoint: (boundary) => this.storeCheckpoint(lease, boundary),
      })
      if (committed.committed !== true) {
        await this.store.deadLetter(lease, "idempotency_required")
        return "dead-lettered"
      }
      await this.proofs.record(lease.idempotencyKey)
      const after = await this.storeCheckpoint(lease, "after-effect")
      if (!after) return "waiting"
      const completed = await this.store.complete(lease)
      return completed.ok ? "completed" : "waiting"
    } catch (error) {
      if (error instanceof RecoveryCrashError) return "waiting"
      if (isAbort(signal, error)) {
        await this.store.cancel(lease.dispatch.runId, "cancelled")
        return "cancelled"
      }
      const failure = stableCode(error)
      if (invoked && !(error instanceof EffectRejectedError)) {
        // The effect boundary was crossed, so a retry would be an unproven duplicate.
        await this.store.deadLetter(lease, "idempotency_required")
        return "dead-lettered"
      }
      if (lease.attempt >= lease.dispatch.maxAttempts) {
        await this.store.deadLetter(lease, failure)
        return "dead-lettered"
      }
      const delay = this.retryBackoff(lease.attempt)
      if (!Number.isFinite(delay) || delay < 0)
        throw new RangeError("recovery retry backoff is invalid")
      const retried = await this.store.retry(
        lease,
        this.clock.now() + Math.min(delay, 86_400_000),
        failure,
      )
      return retried.ok ? "retried" : "waiting"
    }
  }

  private async storeCheckpoint(
    lease: RunLease,
    boundary: "before-effect" | "after-effect",
  ): Promise<boolean> {
    const outcome = await this.store.checkpoint(lease, {
      version: 1,
      dispatchId: lease.dispatch.dispatchId,
      runId: lease.dispatch.runId,
      nodeId: lease.dispatch.nodeId,
      attempt: lease.attempt,
      generation: lease.generation,
      boundary,
      idempotencyKey: lease.idempotencyKey,
      at: this.clock.now(),
      scheduleToken: lease.scheduleToken,
    })
    return outcome.ok
  }
}

/** A small deterministic clock useful for recovery schedules and tests. */
export class TestClock implements InjectedClock {
  private current: number

  constructor(start = 0) {
    if (!Number.isSafeInteger(start) || start < 0)
      throw new RangeError("test clock start is invalid")
    this.current = start
  }

  now = (): number => this.current

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      throw new RangeError("test clock advance is invalid")
    this.current += milliseconds
  }
}

export type { DispatchResultCode }
