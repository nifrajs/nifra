/**
 * Opt-in server integration for request idempotency.
 *
 * Kept separate from `@nifrajs/core/server` so a bare HTTP app does not evaluate or bundle the
 * dedupe lane. Import primitives and stores from `@nifrajs/core/idempotency`.
 */
export { type IdempotencyPluginOptions, idempotency } from "./server/idempotency-lane.ts"

import { markRequestSafeToRetry } from "./internal/effect-execution.ts"

/**
 * Opt a concrete 5xx response into releasing its idempotency reservation, but only while the
 * request-local effect scope still proves that no owned effect began.
 */
export function markIdempotencySafeToRetry(context: object): void {
  markRequestSafeToRetry(context)
}
