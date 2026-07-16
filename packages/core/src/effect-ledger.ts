/**
 * Opt-in server integration for the per-request effect ledger.
 *
 * Kept separate from `@nifrajs/core/server` so a bare HTTP app does not evaluate or bundle ledger
 * machinery. Import ledger primitives from `@nifrajs/core/ledger`.
 */

export type { EffectLedgerOptions } from "./ledger.ts"
export { effectLedger } from "./server/ledger-lane.ts"
