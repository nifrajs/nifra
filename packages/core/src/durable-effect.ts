import { type EffectLifecycleObserver, emitEffectLifecycle } from "./effect-lifecycle.ts"
import type { CapabilityExecutionJournal } from "./internal/capability-runtime.ts"
import { validCapabilityId } from "./internal/capability-runtime.ts"
import { durableEffectProtocol } from "./internal/durable-effect-protocol.ts"
import {
  assertTimestamp,
  assertToken,
  bucketAdd,
  bucketMove,
  cloneValue,
  ERROR_CODE,
  indexedScan,
  MAX_RECONCILIATION_LIMIT,
  memoryScan,
  readClock,
  reconciliationLimit,
} from "./internal/durable-shared.ts"
import type {
  DurableEffectRecord,
  DurableEffectState,
  DurableEffectStore,
  ReconciliationPage,
  ReconciliationScanOptions,
  ReconciliationScanPage,
} from "./internal/durable-types.ts"
// Durable effect journal + reconciliation

export class DurableEffectTransitionError extends Error {
  constructor(
    public readonly effectId: string,
    public readonly transition: string,
  ) {
    super(`durable effect ${effectId}: ${transition} transition was rejected`)
    this.name = "DurableEffectTransitionError"
  }
}

export interface DurableEffectJournalOptions {
  readonly store: DurableEffectStore
  readonly now?: () => number
  /** Tests/local development only. Production journals require `store.durability === "durable"`. */
  readonly allowMemoryStore?: boolean
}

export function createDurableEffectJournal(
  options: DurableEffectJournalOptions,
): CapabilityExecutionJournal {
  if (options.store.durability !== "durable" && options.allowMemoryStore !== true) {
    throw new TypeError('durable effect journal requires store.durability === "durable"')
  }
  const clock = options.now ?? Date.now
  const now = (): number => readClock(clock, "durable effect clock")

  const current = async (effectId: string): Promise<DurableEffectRecord> => {
    assertToken(effectId, "durable effect id", 64)
    const record = await options.store.get(effectId)
    if (record === undefined) throw new DurableEffectTransitionError(effectId, "missing")
    if (
      record.effectId !== effectId ||
      !validCapabilityId(record.capability) ||
      !["admission", "executing", "committed", "failed", "unknown"].includes(record.state) ||
      !Number.isSafeInteger(record.version) ||
      record.version < 1
    ) {
      throw new TypeError(`durable effect ${effectId}: store returned an invalid record`)
    }
    assertTimestamp(record.createdAt, "durable effect createdAt")
    assertTimestamp(record.updatedAt, "durable effect updatedAt")
    if (record.createdAt > record.updatedAt)
      throw new TypeError(`durable effect ${effectId}: updatedAt precedes createdAt`)
    if (record.target !== undefined) assertToken(record.target, "stored durable effect target", 128)
    if (record.digest !== undefined && !/^[0-9a-f]{64}$/u.test(record.digest))
      throw new TypeError(`durable effect ${effectId}: store returned an invalid digest`)
    if (record.tenantId !== undefined)
      assertToken(record.tenantId, "stored durable effect tenantId")
    if (record.principalId !== undefined)
      assertToken(record.principalId, "stored durable effect principalId")
    if ((record.tenantId === undefined) !== (record.principalId === undefined))
      throw new TypeError(`durable effect ${effectId}: store returned a partial identity`)
    if (record.errorCode !== undefined && !ERROR_CODE.test(record.errorCode))
      throw new TypeError(`durable effect ${effectId}: store returned an invalid error code`)
    return record
  }
  const transition = async (
    effectId: string,
    from: DurableEffectState,
    to: DurableEffectState,
    errorCode?: string,
  ): Promise<void> => {
    const record = await current(effectId)
    const next = durableEffectProtocol.transition(record, {
      effectId,
      version: record.version,
      from,
      to,
      updatedAt: now(),
      ...(errorCode === undefined ? {} : { errorCode }),
    })
    if (next === undefined) throw new DurableEffectTransitionError(effectId, `${from}->${to}`)
    const accepted = await options.store.transition({
      effectId,
      version: record.version,
      from,
      to,
      updatedAt: next.updatedAt,
      ...(errorCode === undefined ? {} : { errorCode }),
    })
    if (!accepted) throw new DurableEffectTransitionError(effectId, `${from}->${to}`)
  }

  const journal: CapabilityExecutionJournal = {
    async intent(input) {
      assertToken(input.effectId, "durable effect id", 64)
      if (!validCapabilityId(input.capability))
        throw new TypeError("durable effect capability is invalid")
      if (input.target !== undefined) assertToken(input.target, "durable effect target", 128)
      if (input.digest !== undefined && !/^[0-9a-f]{64}$/u.test(input.digest))
        throw new TypeError("durable effect digest is invalid")
      if (input.identity !== undefined) {
        assertToken(input.identity.tenantId, "durable effect tenantId")
        assertToken(input.identity.principalId, "durable effect principalId")
      }
      const at = now()
      const accepted = await options.store.create(
        Object.freeze({
          effectId: input.effectId,
          capability: input.capability,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.digest === undefined ? {} : { digest: input.digest }),
          ...(input.identity === undefined
            ? {}
            : { tenantId: input.identity.tenantId, principalId: input.identity.principalId }),
          state: "admission" as const,
          createdAt: at,
          updatedAt: at,
          version: 1,
        }),
      )
      if (!accepted) throw new DurableEffectTransitionError(input.effectId, "create")
    },
    async executing(effectId) {
      await transition(effectId, "admission", "executing")
    },
    async committed(effectId) {
      await transition(effectId, "executing", "committed")
    },
    async failed(effectId, input) {
      if (!ERROR_CODE.test(input.errorCode))
        throw new TypeError("durable effect errorCode is invalid")
      const record = await current(effectId)
      const to = input.began ? "unknown" : "failed"
      const next = durableEffectProtocol.transition(record, {
        effectId,
        version: record.version,
        from: record.state,
        to,
        updatedAt: now(),
        errorCode: input.errorCode,
      })
      if (next === undefined)
        throw new DurableEffectTransitionError(effectId, `${record.state}->${to}`)
      const accepted = await options.store.transition({
        effectId,
        version: record.version,
        from: record.state,
        to,
        updatedAt: next.updatedAt,
        errorCode: input.errorCode,
      })
      if (!accepted) throw new DurableEffectTransitionError(effectId, `${record.state}->${to}`)
    },
  }
  return Object.freeze(journal)
}

export class MemoryDurableEffectStore implements DurableEffectStore {
  readonly durability = "memory" as const
  private readonly records = new Map<string, DurableEffectRecord>()
  // Secondary index: effectIds grouped by state, so reconciliation scans only the requested (few,
  // non-terminal) states instead of walking every retained record. See {@link indexedScan}.
  private readonly byState = new Map<DurableEffectState, Set<string>>()

  create(record: DurableEffectRecord): boolean {
    if (this.records.has(record.effectId)) return false
    this.records.set(record.effectId, Object.freeze(cloneValue(record)))
    bucketAdd(this.byState, record.state, record.effectId)
    return true
  }

  get(effectId: string): DurableEffectRecord | undefined {
    const record = this.records.get(effectId)
    return record === undefined ? undefined : Object.freeze(cloneValue(record))
  }

  transition(input: Parameters<DurableEffectStore["transition"]>[0]): boolean {
    const current = this.records.get(input.effectId)
    const next = durableEffectProtocol.transition(current, input)
    if (next === undefined) return false
    if (current === undefined) return false
    this.records.set(input.effectId, Object.freeze(next))
    bucketMove(this.byState, current.state, input.to, input.effectId)
    return true
  }

  list(): readonly DurableEffectRecord[] {
    return Object.freeze(
      [...this.records.values()].map((record) => Object.freeze(cloneValue(record))),
    )
  }

  scan(
    input: ReconciliationScanOptions<DurableEffectState>,
  ): ReconciliationScanPage<DurableEffectRecord> {
    return indexedScan(this.byState, (id) => this.records.get(id), input)
  }
}

export interface EffectReconciliationFinding {
  readonly effectId: string
  readonly capability: string
  readonly state: "incomplete" | "ambiguous"
  readonly updatedAt: number
}

async function scanEffectRecords(
  store: DurableEffectStore,
  input: ReconciliationScanOptions<DurableEffectState>,
): Promise<ReconciliationScanPage<DurableEffectRecord>> {
  if (store.scan !== undefined) return await store.scan(input)
  if (store.list === undefined) throw new TypeError("effect store does not support reconciliation")
  return memoryScan(await store.list(), input)
}

export async function reconcileEffectsPage(
  store: DurableEffectStore,
  options: {
    readonly staleBefore: number
    readonly observer?: EffectLifecycleObserver
    readonly cursor?: string
    readonly limit?: number
  },
): Promise<ReconciliationPage<EffectReconciliationFinding>> {
  const findings: EffectReconciliationFinding[] = []
  const page = await scanEffectRecords(store, {
    states: ["admission", "executing", "unknown"],
    updatedBefore: options.staleBefore,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: reconciliationLimit(options.limit),
  })
  for (const record of page.records) {
    if (!validCapabilityId(record.capability) || !/^[!-~]{1,64}$/u.test(record.effectId)) continue
    if (record.updatedAt > options.staleBefore) continue
    const state =
      record.state === "admission"
        ? "incomplete"
        : record.state === "executing" || record.state === "unknown"
          ? "ambiguous"
          : undefined
    if (state === undefined) continue
    findings.push(
      Object.freeze({
        effectId: record.effectId,
        capability: record.capability,
        state,
        updatedAt: record.updatedAt,
      }),
    )
    if (options.observer !== undefined) {
      emitEffectLifecycle([options.observer], {
        effectId: record.effectId,
        capability: record.capability,
        stage: "reconciliation",
        phase: state === "ambiguous" ? "ambiguous" : "failed",
        errorCode: state === "ambiguous" ? "effect_ambiguous" : "effect_incomplete",
      })
    }
  }
  return Object.freeze({
    findings: Object.freeze(findings),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  })
}

export async function reconcileEffects(
  store: DurableEffectStore,
  options: { readonly staleBefore: number; readonly observer?: EffectLifecycleObserver },
): Promise<readonly EffectReconciliationFinding[]> {
  const page = await reconcileEffectsPage(store, {
    ...options,
    limit: MAX_RECONCILIATION_LIMIT,
  })
  if (page.cursor !== undefined) {
    throw new RangeError(
      `effect reconciliation exceeds ${MAX_RECONCILIATION_LIMIT} records; use reconcileEffectsPage()`,
    )
  }
  return page.findings
}

// -------------------------------------------------------------------------------------------------
