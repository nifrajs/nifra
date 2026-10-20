/**
 * The seam between `createWebApp` and a cache wrapper for an action's invalidation: types and one
 * symbol, so an app pays for the pipeline only once something runs it.
 */
export interface InvalidationOp {
  /** Names the operation in logs; never key text. */
  readonly id: string
  readonly paths: readonly string[]
  readonly tags: readonly string[]
  readonly keys: readonly string[]
}

/** What a `createWebApp` app hands a cache wrapper that owns its invalidation. */
export interface InvalidationHandoff {
  /** The operation the action behind `request` recorded, once. */
  take(request: Request): InvalidationOp | undefined
  /** The app's live publish, when it configures `live`. */
  readonly publish: ((keys: readonly string[]) => Promise<void>) | undefined
}

export const INVALIDATION: unique symbol = Symbol.for("nifra.web.invalidation")
