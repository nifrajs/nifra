/**
 * Opt-in server integration for request idempotency.
 *
 * Kept separate from `@nifrajs/core/server` so a bare HTTP app does not evaluate or bundle the
 * dedupe lane. Import primitives and stores from `@nifrajs/core/idempotency`.
 */
export { type IdempotencyPluginOptions, idempotency } from "./server/idempotency-lane.ts"
