/** Request-local owned-effect scope used by idempotency and every capability boundary. */

import {
  createEffectEvidenceScope,
  type EffectEvidenceScope,
  type EffectScopeEvidence,
} from "../effect-scope.ts"

export type RequestEffectEvidence = EffectScopeEvidence

const scopeByRequest = new WeakMap<Request, EffectEvidenceScope>()

export function beginRequestEffectTracking(request: Request): EffectEvidenceScope {
  const scope = createEffectEvidenceScope()
  scopeByRequest.set(request, scope)
  return scope
}

export function requestEffectScope(request: Request): EffectEvidenceScope | undefined {
  return scopeByRequest.get(request)
}

export function requestEffectEvidence(request: Request): RequestEffectEvidence {
  return (
    scopeByRequest.get(request)?.evidence() ??
    Object.freeze({ began: false, committed: false, ambiguous: false })
  )
}

export function effectScopeForContext(context: object): EffectEvidenceScope | undefined {
  const request = (context as { readonly req?: unknown }).req
  return request instanceof Request ? scopeByRequest.get(request) : undefined
}

export function markEffect(context: object, committed: boolean): void {
  const scope = effectScopeForContext(context)
  if (committed) scope?.markCommitted()
  else scope?.markBegan()
}

/** A legacy beacon cannot prove what happens after the call, so it is immediately ambiguous. */
export function markBeaconEffectBegan(context: object): void {
  effectScopeForContext(context)?.markBegan()
}

export function markEffectExecuting(context: object): void {
  effectScopeForContext(context)?.markBegan()
}

export function markEffectCommitted(context: object): void {
  effectScopeForContext(context)?.markCommitted()
}

export function markEffectAmbiguous(context: object): void {
  effectScopeForContext(context)?.markAmbiguous()
}

export function markRequestSafeToRetry(context: object): void {
  const scope = effectScopeForContext(context)
  if (scope === undefined) {
    throw new Error(
      "markIdempotencySafeToRetry() requires an active route with idempotency enabled",
    )
  }
  scope.markSafeToRetry()
}

export function requestIsSafeToRetry(request: Request): boolean {
  return scopeByRequest.get(request)?.safeToRetry() ?? false
}
