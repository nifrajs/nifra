import type { EffectLifecycleObserver } from "../effect-lifecycle.ts"
import type { EffectCost } from "../ledger.ts"

export const CAPABILITY_GUARD = Symbol("nifra.capability.guard")
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/

export function validCapabilityId(value: string): boolean {
  return CAPABILITY_ID.test(value)
}

export interface CapabilityUseEvent {
  readonly capability: string
  readonly method: string
  readonly path: string
}

/** Token-only metadata supplied to an asynchronous capability admission interceptor. */
export interface CapabilityInterceptorEvent extends CapabilityUseEvent {
  readonly effectId: string
  readonly signal: AbortSignal
  readonly target?: string
  readonly cost?: EffectCost
  readonly digest?: string
}

/** Server-owned identity binding for durable admission. Values are opaque tokens, never payloads. */
export interface CapabilityExecutionIdentity {
  readonly tenantId: string
  readonly principalId: string
}

export interface CapabilityApprovalInput extends CapabilityExecutionIdentity {
  /** Signed token returned by the approval coordinator after the first suspended attempt. */
  readonly resumeToken?: string
}

export interface CapabilityApprovalGate {
  authorize(input: {
    readonly effectId: string
    readonly capability: string
    readonly target?: string
    readonly digest?: string
    readonly identity: CapabilityExecutionIdentity
    readonly resumeToken?: string
    readonly signal: AbortSignal
  }): void | PromiseLike<void>
}

/** Durable, token-only journal seam. Implementations must fail closed on transition failure. */
export interface CapabilityExecutionJournal {
  intent(input: {
    readonly effectId: string
    readonly capability: string
    readonly target?: string
    readonly digest?: string
    readonly identity?: CapabilityExecutionIdentity
  }): void | PromiseLike<void>
  executing(effectId: string): void | PromiseLike<void>
  committed(effectId: string): void | PromiseLike<void>
  failed(
    effectId: string,
    input: { readonly began: boolean; readonly errorCode: string },
  ): void | PromiseLike<void>
}

/** Continue to the next admission policy. The owned effect runs only after the full chain admits. */
export type CapabilityInterceptorNext = () => Promise<void>

export type CapabilityInterceptor = (
  event: CapabilityInterceptorEvent,
  next: CapabilityInterceptorNext,
) => void | PromiseLike<void>

export interface AroundCapabilityOptions {
  /** Maximum admission time in milliseconds. Default 30_000. */
  readonly timeoutMs?: number
}

export interface RegisteredCapabilityInterceptor {
  readonly interceptor: CapabilityInterceptor
  readonly timeoutMs: number
}

export const DEFAULT_CAPABILITY_INTERCEPTOR_TIMEOUT_MS = 30_000

export interface CapabilityGuard {
  readonly allowed: readonly string[]
  readonly method: string
  readonly path: string
  readonly onUse?: (event: CapabilityUseEvent) => void
  readonly trackEffect?: (context: object, committed: boolean) => void
  readonly interceptors: readonly RegisteredCapabilityInterceptor[]
  readonly observers: readonly EffectLifecycleObserver[]
}

export function normalizeRouteCapabilities(
  values: readonly string[] | undefined,
): readonly string[] {
  if (values === undefined) return Object.freeze([])
  if (!Array.isArray(values)) throw new TypeError("route capabilities must be an array")
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string" || !validCapabilityId(value)) {
      throw new Error(
        `route capabilities: invalid capability id ${JSON.stringify(value)} (use lowercase dot/dash segments)`,
      )
    }
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return Object.freeze(out)
}

export function createCapabilityGuard(
  allowed: readonly string[],
  method: string,
  path: string,
  onUse: ((event: CapabilityUseEvent) => void) | undefined,
  trackEffect: ((context: object, committed: boolean) => void) | undefined,
  interceptors: readonly RegisteredCapabilityInterceptor[],
  observers: readonly EffectLifecycleObserver[],
): CapabilityGuard {
  return Object.freeze({
    allowed,
    method,
    path,
    ...(onUse !== undefined ? { onUse } : {}),
    ...(trackEffect !== undefined ? { trackEffect } : {}),
    interceptors,
    observers,
  })
}
