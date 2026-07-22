import { validCapabilityId } from "./internal/capability-runtime.ts"
import { type EffectCost, type EffectMetadata, normalizeEffectMetadata } from "./ledger.ts"

/** A bounded, payload-free stage in an effect's lifecycle. */
export type EffectLifecycleStage = "admission" | "execution" | "compensation" | "reconciliation"

export type EffectLifecyclePhase = "started" | "succeeded" | "failed" | "ambiguous"

/** Trace-parent tokens copied structurally from an installed tracing plugin. */
export interface EffectTraceParent {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}

/**
 * Token-only lifecycle evidence. There is deliberately no payload, argument, result, error message,
 * request, or context field, so observation adapters cannot accidentally export business data.
 */
export interface EffectLifecycleEvent extends EffectMetadata {
  readonly effectId: string
  readonly capability: string
  readonly stage: EffectLifecycleStage
  readonly phase: EffectLifecyclePhase
  readonly at: number
  readonly durationMs?: number
  readonly attempt?: number
  readonly errorCode?: string
  readonly trace?: EffectTraceParent
}

/** Observation is fail-open: a broken sink must never change effect behavior. */
export type EffectLifecycleObserver = (event: EffectLifecycleEvent) => void

const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/

export function effectTraceParentOf(context: object): EffectTraceParent | undefined {
  const trace = (
    context as {
      readonly trace?: {
        readonly traceId?: unknown
        readonly spanId?: unknown
        readonly sampled?: unknown
      }
    }
  ).trace
  if (
    trace === undefined ||
    typeof trace.traceId !== "string" ||
    !/^[0-9a-f]{32}$/.test(trace.traceId) ||
    typeof trace.spanId !== "string" ||
    !/^[0-9a-f]{16}$/.test(trace.spanId) ||
    typeof trace.sampled !== "boolean"
  ) {
    return undefined
  }
  return Object.freeze({ traceId: trace.traceId, spanId: trace.spanId, sampled: trace.sampled })
}

export interface EmitEffectLifecycleInput extends EffectMetadata {
  readonly effectId: string
  readonly capability: string
  readonly stage: EffectLifecycleStage
  readonly phase: EffectLifecyclePhase
  readonly at?: number
  readonly durationMs?: number
  readonly attempt?: number
  readonly errorCode?: string
  readonly trace?: EffectTraceParent
}

/** @internal Validate, freeze, and fan out one token-only event. */
export function emitEffectLifecycle(
  observers: readonly EffectLifecycleObserver[],
  input: EmitEffectLifecycleInput,
): void {
  if (observers.length === 0) return
  if (!validCapabilityId(input.capability) || !/^[!-~]{1,64}$/u.test(input.effectId)) return
  let metadata: EffectMetadata
  try {
    metadata = normalizeEffectMetadata(input)
  } catch {
    return
  }
  const at = input.at ?? Date.now()
  if (!Number.isFinite(at) || at < 0) return
  if (
    input.durationMs !== undefined &&
    (!Number.isFinite(input.durationMs) || input.durationMs < 0)
  ) {
    return
  }
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) {
    return
  }
  if (input.errorCode !== undefined && !ERROR_CODE.test(input.errorCode)) return
  const event: EffectLifecycleEvent = Object.freeze({
    effectId: input.effectId,
    capability: input.capability,
    stage: input.stage,
    phase: input.phase,
    at,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(metadata.target === undefined ? {} : { target: metadata.target }),
    ...(metadata.cost === undefined
      ? {}
      : { cost: Object.freeze({ ...metadata.cost }) as EffectCost }),
    ...(metadata.digest === undefined ? {} : { digest: metadata.digest }),
    ...(input.trace === undefined ? {} : { trace: input.trace }),
  })
  for (const observer of observers) {
    try {
      observer(event)
    } catch {
      // Observation is deliberately fail-open.
    }
  }
}
