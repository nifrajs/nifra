/**
 * Retry backoff strategies. A {@link Backoff} maps the number of attempts already made (1-based) to a
 * delay in ms before the next attempt.
 */
import type { Backoff } from "./types.ts"

function delayMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `jobs: ${label} must be a finite, non-negative delay in ms, got ${String(value)}`,
    )
  }
  return value
}

export interface ExponentialOptions {
  /** Delay before the FIRST retry (attempt 1). Default 1000. */
  readonly baseMs?: number
  /** Upper bound on the delay. Default 30_000. */
  readonly maxMs?: number
  /** Full-jitter fraction in [0,1]: the delay is scaled by `1 - jitter*rand`. Default 0 (deterministic). */
  readonly jitter?: number
  /** Injectable randomness for jitter (tests). Default `Math.random`. */
  readonly random?: () => number
}

/** Exponential backoff: `baseMs * 2^(attempt-1)`, capped at `maxMs`, with optional jitter. */
export function exponentialBackoff(options: ExponentialOptions = {}): Backoff {
  const baseMs = delayMs(options.baseMs ?? 1000, "baseMs")
  const maxMs = delayMs(options.maxMs ?? 30_000, "maxMs")
  const jitter = options.jitter ?? 0
  if (!(jitter >= 0 && jitter <= 1)) {
    throw new RangeError(`jobs: jitter must be within [0, 1], got ${String(jitter)}`)
  }
  const random = options.random ?? Math.random
  return (attempt) => {
    const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
    return jitter > 0 ? Math.round(raw * (1 - jitter * random())) : raw
  }
}

/** Fixed delay before every retry. */
export const fixedBackoff = (ms: number): Backoff => {
  const delay = delayMs(ms, "fixedBackoff")
  return () => delay
}

/** No delay - retry immediately. */
export const noBackoff: Backoff = () => 0
