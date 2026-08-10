import type { SealedEffectLedger } from "@nifrajs/core/ledger"

export type EffectLedger = SealedEffectLedger

export interface IdempotencyDivergence {
  readonly step: number
  readonly field: string
  readonly first: unknown
  readonly second: unknown
}

export interface IdempotencyProof {
  readonly ok: boolean
  readonly divergences: readonly IdempotencyDivergence[]
}

interface CanonicalLedger {
  readonly method: string
  readonly path: string
  readonly declared: readonly string[]
  readonly entries: readonly Readonly<Record<string, unknown>>[]
}

function canonicalize(ledger: EffectLedger): CanonicalLedger {
  return {
    method: ledger.method,
    path: ledger.path,
    declared: [...ledger.declared],
    entries: ledger.entries.map((entry) => {
      const value: Record<string, unknown> = {
        seq: entry.seq,
        ...(entry.effectId === undefined ? {} : { effectId: entry.effectId }),
        capability: entry.capability,
        phase: entry.phase,
        ...(entry.target === undefined ? {} : { target: entry.target }),
        ...(entry.cost === undefined ? {} : { cost: entry.cost }),
        ...(entry.digest === undefined ? {} : { digest: entry.digest }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
      }
      return value
    }),
  }
}

function flatten(value: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value))
    return value.flatMap((item, index) => flatten(item, `${path}[${index}]`))
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      flatten(item, path ? `${path}.${key}` : key),
    )
  }
  return [{ path, value }]
}

/** Run a token-only effect workload repeatedly and report the first stable replay differences. */
export async function proveIdempotency(options: {
  readonly run: () => Promise<EffectLedger> | EffectLedger
  readonly runs?: number
}): Promise<IdempotencyProof> {
  const runs = options.runs ?? 2
  if (!Number.isSafeInteger(runs) || runs < 2)
    throw new RangeError("idempotency runs must be at least 2")
  const ledgers: CanonicalLedger[] = []
  for (let index = 0; index < runs; index++) ledgers.push(canonicalize(await options.run()))
  const first = flatten(ledgers[0])
  const divergences: IdempotencyDivergence[] = []
  for (let run = 1; run < ledgers.length; run++) {
    const current = flatten(ledgers[run])
    const max = Math.max(first.length, current.length)
    for (let step = 0; step < max; step++) {
      const left = first[step]
      const right = current[step]
      if (
        left?.path === right?.path &&
        JSON.stringify(left?.value) === JSON.stringify(right?.value)
      )
        continue
      divergences.push({
        step,
        field: left?.path ?? right?.path ?? "ledger",
        first: left?.value,
        second: right?.value,
      })
      break
    }
  }
  return Object.freeze({ ok: divergences.length === 0, divergences: Object.freeze(divergences) })
}
