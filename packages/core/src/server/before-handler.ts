import type { Context } from "./context.ts"

/** Hooks {@link beforeHandler} marked; the kernel keeps them after guards registered later. */
export const LAST_BEFORE_HANDLE = new WeakSet<object>()

/**
 * Mark a `beforeHandle` hook to run just before the handler: a guard registered after it in the same
 * scope still goes ahead of it, so it only sees requests every guard admitted. A hook that answers
 * from stored state (an idempotency replay) needs this, or it would answer ahead of a later guard.
 */
export function beforeHandler<H extends (context: Context) => unknown>(hook: H): H {
  LAST_BEFORE_HANDLE.add(hook)
  return hook
}
