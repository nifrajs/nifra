/**
 * The seam between `createWebApp` and a cache wrapper for an action's invalidation: types and one
 * symbol, so an app pays for the pipeline only once something runs it.
 */
import type { RevalidateResult } from "./render-document.ts"

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

/** The operation an action's `revalidate()` names: its paths, cache tags and live keys. */
export function invalidationOf(revalidation: RevalidateResult<unknown>): InvalidationOp {
  return {
    id: crypto.randomUUID(),
    paths: revalidation.__nifraRevalidate.filter(
      (path) => typeof path === "string" && path.startsWith("/"),
    ),
    tags: revalidation.__nifraInvalidate?.tags ?? [],
    keys: revalidation.__nifraInvalidate?.keys ?? [],
  }
}
