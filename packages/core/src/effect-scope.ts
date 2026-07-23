/**
 * One cross-runtime boundary for owned external effects. It centralizes correlation, lifecycle
 * evidence, cancellation, durable transition ordering, and token-only observation without relying
 * on Node-only async-local state.
 */

import {
  type EffectLifecycleObserver,
  type EffectLifecycleStage,
  type EffectTraceParent,
  emitEffectLifecycle,
} from "./effect-lifecycle.ts"
import { validCapabilityId } from "./internal/capability-runtime.ts"
import { type EffectMetadata, normalizeEffectMetadata } from "./ledger.ts"

const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/

export interface EffectScopeEvidence {
  readonly began: boolean
  readonly committed: boolean
  readonly ambiguous: boolean
}

export interface OwnedEffectContext extends EffectMetadata {
  readonly effectId: string
  readonly capability: string
  readonly stage: Exclude<EffectLifecycleStage, "admission" | "reconciliation">
  readonly signal: AbortSignal
  readonly attempt?: number
}

export interface OwnedEffectTransitions<T> {
  intent?(context: OwnedEffectContext): void | PromiseLike<void>
  executing?(context: OwnedEffectContext): void | PromiseLike<void>
  committed?(context: OwnedEffectContext, result: T): void | PromiseLike<void>
  failed?(
    context: OwnedEffectContext,
    input: { readonly began: boolean; readonly errorCode: string; readonly error: unknown },
  ): void | PromiseLike<void>
}

export interface OwnedEffectRunOptions<T> extends EffectMetadata {
  readonly effectId?: string
  readonly capability: string
  readonly stage?: Exclude<EffectLifecycleStage, "admission" | "reconciliation">
  readonly signal?: AbortSignal
  readonly attempt?: number
  readonly trace?: EffectTraceParent
  /** Per-run observers, combined with the scope's observers. */
  readonly observers?: readonly EffectLifecycleObserver[]
  /** Optional admission boundary executed before the effect is marked as begun. */
  readonly admit?: (context: OwnedEffectContext) => void | PromiseLike<void>
  readonly transitions?: OwnedEffectTransitions<T>
  readonly errorCode?: string | ((error: unknown, began: boolean) => string)
  /** Classify a caught execution failure when the caller can prove it is terminal. */
  readonly failurePhase?: (error: unknown, began: boolean) => "failed" | "ambiguous"
}

export interface EffectScopeOptions {
  readonly observers?: readonly EffectLifecycleObserver[]
  readonly signal?: AbortSignal
  readonly effectId?: () => string
}

export interface EffectEvidenceScope {
  evidence(): EffectScopeEvidence
  /** Legacy/manual effects cannot prove a terminal outcome and therefore become ambiguous. */
  markBegan(): void
  /** Pair a prior manual `markBegan()` with a proven commit. */
  markCommitted(): void
  /** Preserve uncertainty when a caller loses the terminal outcome. */
  markAmbiguous(): void
  /** Settle one begun effect as a proven terminal failure without claiming it committed. */
  markFailed(): void
  /**
   * Declare that the enclosing request may release its idempotency reservation if it returns a
   * server error before any owned effect begins.
   */
  markSafeToRetry(): void
  /** True only while the retry declaration remains backed by evidence that no effect began. */
  safeToRetry(): boolean
}

export interface EffectScope extends EffectEvidenceScope {
  run<T>(
    options: OwnedEffectRunOptions<T>,
    execute: (context: OwnedEffectContext) => T | PromiseLike<T>,
  ): Promise<T>
}

let neverSignal: AbortSignal | undefined
function signalOrNever(signal?: AbortSignal): AbortSignal {
  neverSignal ??= new AbortController().signal
  return signal ?? neverSignal
}

function assertEffectId(value: string): void {
  if (!/^[!-~]{1,64}$/u.test(value))
    throw new TypeError("effect id must be a bounded printable token")
}

function codeFor(
  configured: OwnedEffectRunOptions<unknown>["errorCode"],
  error: unknown,
  began: boolean,
): string {
  const code =
    typeof configured === "function"
      ? configured(error, began)
      : (configured ?? (began ? "execution_failed" : "admission_failed"))
  if (!ERROR_CODE.test(code)) throw new TypeError("effect errorCode is invalid")
  return code
}

/** Lightweight aggregate evidence shared by request idempotency and full owned-effect runners. */
export function createEffectEvidenceScope(): EffectEvidenceScope {
  const aggregate = { began: false, committed: false }
  let uncertain = 0
  let retryDeclared = false
  return Object.freeze({
    evidence() {
      return Object.freeze({ ...aggregate, ambiguous: uncertain > 0 })
    },
    markBegan() {
      aggregate.began = true
      retryDeclared = false
      uncertain++
    },
    markCommitted() {
      aggregate.began = true
      aggregate.committed = true
      if (uncertain > 0) uncertain--
    },
    markAmbiguous() {
      aggregate.began = true
      retryDeclared = false
      if (uncertain === 0) uncertain = 1
    },
    markFailed() {
      aggregate.began = true
      retryDeclared = false
      if (uncertain > 0) uncertain--
    },
    markSafeToRetry() {
      if (aggregate.began) {
        throw new Error("cannot mark an idempotent request safe to retry after an effect began")
      }
      retryDeclared = true
    },
    safeToRetry() {
      return retryDeclared && !aggregate.began
    },
  })
}

export function createEffectScope(
  options: EffectScopeOptions = {},
  evidenceScope: EffectEvidenceScope = createEffectEvidenceScope(),
): EffectScope {
  const observers = Object.freeze([...(options.observers ?? [])])
  const idFor = options.effectId ?? crypto.randomUUID.bind(crypto)

  const scope: EffectScope = {
    async run<T>(
      input: OwnedEffectRunOptions<T>,
      execute: (context: OwnedEffectContext) => T | PromiseLike<T>,
    ) {
      if (typeof execute !== "function")
        throw new TypeError("owned effect executor must be a function")
      if (!validCapabilityId(input.capability))
        throw new TypeError("owned effect capability is invalid")
      const effectId = input.effectId ?? idFor()
      assertEffectId(effectId)
      const metadata = normalizeEffectMetadata(input)
      const signal = input.signal ?? options.signal ?? signalOrNever()
      const stage = input.stage ?? "execution"
      if (
        input.attempt !== undefined &&
        (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
      )
        throw new RangeError("owned effect attempt must be a positive safe integer")
      const context: OwnedEffectContext = Object.freeze({
        effectId,
        capability: input.capability,
        stage,
        signal,
        ...metadata,
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      })
      const runObservers =
        input.observers === undefined
          ? observers
          : Object.freeze([...observers, ...input.observers])
      let began = false
      const startedAt = performance.now()
      try {
        if (signal.aborted) throw signal.reason
        await input.transitions?.intent?.(context)
        if (input.admit !== undefined) {
          emitEffectLifecycle(runObservers, {
            ...context,
            stage: "admission",
            phase: "started",
            ...(input.trace === undefined ? {} : { trace: input.trace }),
          })
          await input.admit(context)
          emitEffectLifecycle(runObservers, {
            ...context,
            stage: "admission",
            phase: "succeeded",
            durationMs: Math.max(0, performance.now() - startedAt),
            ...(input.trace === undefined ? {} : { trace: input.trace }),
          })
        }
        if (signal.aborted) throw signal.reason
        await input.transitions?.executing?.(context)
        began = true
        evidenceScope.markBegan()
        const executionStartedAt = performance.now()
        emitEffectLifecycle(runObservers, {
          ...context,
          phase: "started",
          ...(input.trace === undefined ? {} : { trace: input.trace }),
        })
        const result = await execute(context)
        await input.transitions?.committed?.(context, result)
        evidenceScope.markCommitted()
        emitEffectLifecycle(runObservers, {
          ...context,
          phase: "succeeded",
          durationMs: Math.max(0, performance.now() - executionStartedAt),
          ...(input.trace === undefined ? {} : { trace: input.trace }),
        })
        return result
      } catch (error) {
        const errorCode = codeFor(input.errorCode, error, began)
        const failurePhase = input.failurePhase?.(error, began) ?? (began ? "ambiguous" : "failed")
        if (failurePhase !== "failed" && failurePhase !== "ambiguous") {
          throw new TypeError("owned effect failurePhase returned an invalid phase")
        }
        try {
          await input.transitions?.failed?.(context, { began, errorCode, error })
        } catch {
          // Preserve the owned effect's cause. Reconciliation sees the unfinished durable state.
        }
        if (began && failurePhase === "failed") evidenceScope.markFailed()
        emitEffectLifecycle(runObservers, {
          ...context,
          stage: began ? stage : input.admit === undefined ? stage : "admission",
          phase: began ? failurePhase : "failed",
          durationMs: Math.max(0, performance.now() - startedAt),
          errorCode,
          ...(input.trace === undefined ? {} : { trace: input.trace }),
        })
        throw error
      }
    },
    evidence: () => evidenceScope.evidence(),
    markBegan: () => evidenceScope.markBegan(),
    markCommitted: () => evidenceScope.markCommitted(),
    markAmbiguous: () => evidenceScope.markAmbiguous(),
    markFailed: () => evidenceScope.markFailed(),
    markSafeToRetry: () => evidenceScope.markSafeToRetry(),
    safeToRetry: () => evidenceScope.safeToRetry(),
  }
  return Object.freeze(scope)
}
