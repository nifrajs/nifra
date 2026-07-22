/** Request-local evidence used by the idempotency lane. Never exported or persisted. */
export interface RequestEffectEvidence {
  readonly began: boolean
  readonly committed: boolean
  readonly ambiguous: boolean
}

interface MutableEvidence {
  began: boolean
  committed: boolean
  ambiguous: boolean
}

const evidenceByRequest = new WeakMap<Request, MutableEvidence>()

export function beginRequestEffectTracking(request: Request): void {
  evidenceByRequest.set(request, { began: false, committed: false, ambiguous: false })
}

export function requestEffectEvidence(request: Request): RequestEffectEvidence {
  const evidence = evidenceByRequest.get(request)
  return evidence === undefined
    ? Object.freeze({ began: false, committed: false, ambiguous: false })
    : Object.freeze({ ...evidence })
}

function evidenceForContext(context: object): MutableEvidence | undefined {
  const request = (context as { readonly req?: unknown }).req
  return request instanceof Request ? evidenceByRequest.get(request) : undefined
}

export function markEffect(context: object, committed: boolean): void {
  const evidence = evidenceForContext(context)
  if (evidence === undefined) return
  evidence.began = true
  if (committed) evidence.committed = true
  evidence.ambiguous = !committed
}

/** A legacy beacon cannot prove what happens after the call, so it is immediately ambiguous. */
export function markBeaconEffectBegan(context: object): void {
  markEffect(context, false)
}

export function markEffectExecuting(context: object): void {
  markEffect(context, false)
}

export function markEffectCommitted(context: object): void {
  markEffect(context, true)
}

export function markEffectAmbiguous(context: object): void {
  markEffect(context, false)
}
