/** Leased, cursor-checkpointed, bounded reconciliation worker orchestration. */
import {
  type DurableEffectStore,
  type EffectReconciliationFinding,
  reconcileEffectsPage,
  reconcileSagasPage,
  type SagaReconciliationFinding,
  type SagaStore,
} from "./durable-execution.ts"
import { safeEqual } from "./internal/safe-equal.ts"

const TOKEN = /^[!-~]{1,128}$/

export interface ReconciliationLease {
  readonly name: string
  readonly owner: string
  readonly token: string
  readonly expiresAt: number
  readonly cursor?: string
}

export interface ReconciliationLeaseStore {
  readonly durability?: "memory" | "durable"
  acquire(input: {
    readonly name: string
    readonly owner: string
    readonly now: number
    readonly leaseMs: number
  }): ReconciliationLease | undefined | Promise<ReconciliationLease | undefined>
  renew(input: {
    readonly name: string
    readonly owner: string
    readonly token: string
    readonly now: number
    readonly leaseMs: number
  }): boolean | Promise<boolean>
  checkpoint(input: {
    readonly name: string
    readonly owner: string
    readonly token: string
    readonly cursor?: string
  }): boolean | Promise<boolean>
  release(input: {
    readonly name: string
    readonly owner: string
    readonly token: string
  }): boolean | Promise<boolean>
}

export type ReconciliationWorkerEvent =
  | { readonly type: "acquired" | "released" | "lease-lost"; readonly name: string }
  | {
      readonly type: "page" | "checkpoint"
      readonly name: string
      readonly scanned: number
      readonly handled: number
    }
  | { readonly type: "failed"; readonly name: string; readonly errorCode: "scan" | "handle" }

export interface ReconciliationWorkerOptions<Finding> {
  readonly name: string
  readonly owner: string
  readonly leases: ReconciliationLeaseStore
  readonly leaseMs?: number
  readonly batchSize?: number
  readonly maxPages?: number
  readonly concurrency?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly scan: (input: {
    readonly cursor?: string
    readonly limit: number
    readonly signal: AbortSignal
  }) =>
    | { readonly findings: readonly Finding[]; readonly cursor?: string }
    | Promise<{
        readonly findings: readonly Finding[]
        readonly cursor?: string
      }>
  readonly filter?: (finding: Finding) => boolean
  readonly handle: (finding: Finding, signal: AbortSignal) => void | PromiseLike<void>
  readonly observe?: (event: ReconciliationWorkerEvent) => void
}

export interface ReconciliationWorkerResult {
  readonly acquired: boolean
  readonly pages: number
  readonly scanned: number
  readonly handled: number
}

function positive(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new RangeError(`${label} must be an integer between 1 and ${max}`)
  return value
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("reconciliation clock must return a non-negative safe integer")
  return value
}

function assertToken(value: string, label: string): void {
  if (!TOKEN.test(value)) throw new TypeError(`${label} must be a bounded printable token`)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("reconciliation aborted")
}

async function boundedMap<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= values.length) return
      await run(values[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
}

export async function runReconciliationWorker<Finding>(
  options: ReconciliationWorkerOptions<Finding>,
): Promise<ReconciliationWorkerResult> {
  assertToken(options.name, "reconciliation worker name")
  assertToken(options.owner, "reconciliation worker owner")
  const leaseMs = positive(options.leaseMs ?? 30_000, "reconciliation leaseMs", 86_400_000)
  const batchSize = positive(options.batchSize ?? 100, "reconciliation batchSize", 1_000)
  const maxPages = positive(options.maxPages ?? 10, "reconciliation maxPages", 1_000)
  const concurrency = positive(options.concurrency ?? 4, "reconciliation concurrency", 64)
  const now = options.now ?? Date.now
  const signal = options.signal ?? new AbortController().signal
  throwIfAborted(signal)
  const lease = await options.leases.acquire({
    name: options.name,
    owner: options.owner,
    now: timestamp(now()),
    leaseMs,
  })
  if (lease === undefined) return { acquired: false, pages: 0, scanned: 0, handled: 0 }
  if (
    lease.name !== options.name ||
    lease.owner !== options.owner ||
    !TOKEN.test(lease.token) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= 0 ||
    (lease.cursor !== undefined && !/^[ -~]{1,1024}$/u.test(lease.cursor))
  ) {
    throw new TypeError("reconciliation lease store returned an invalid lease")
  }
  options.observe?.({ type: "acquired", name: options.name })
  let cursor = lease.cursor
  let pages = 0
  let scanned = 0
  let handled = 0
  try {
    while (pages < maxPages) {
      throwIfAborted(signal)
      const renewed = await options.leases.renew({
        name: options.name,
        owner: options.owner,
        token: lease.token,
        now: timestamp(now()),
        leaseMs,
      })
      if (!renewed) {
        options.observe?.({ type: "lease-lost", name: options.name })
        throw new Error("reconciliation lease lost")
      }
      let page: Awaited<ReturnType<typeof options.scan>>
      try {
        page = await options.scan({
          ...(cursor === undefined ? {} : { cursor }),
          limit: batchSize,
          signal,
        })
      } catch (error) {
        options.observe?.({ type: "failed", name: options.name, errorCode: "scan" })
        throw error
      }
      if (!Array.isArray(page.findings) || page.findings.length > batchSize)
        throw new TypeError("reconciliation scan returned an invalid or oversized page")
      pages++
      scanned += page.findings.length
      const selected =
        options.filter === undefined ? page.findings : page.findings.filter(options.filter)
      try {
        await boundedMap(selected, concurrency, async (finding) => {
          throwIfAborted(signal)
          await options.handle(finding, signal)
          handled++
        })
      } catch (error) {
        options.observe?.({ type: "failed", name: options.name, errorCode: "handle" })
        throw error
      }
      const renewedAfterWork = await options.leases.renew({
        name: options.name,
        owner: options.owner,
        token: lease.token,
        now: timestamp(now()),
        leaseMs,
      })
      if (!renewedAfterWork) {
        options.observe?.({ type: "lease-lost", name: options.name })
        throw new Error("reconciliation lease expired during page handling")
      }
      options.observe?.({
        type: "page",
        name: options.name,
        scanned: page.findings.length,
        handled: selected.length,
      })
      const checkpointed = await options.leases.checkpoint({
        name: options.name,
        owner: options.owner,
        token: lease.token,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      })
      if (!checkpointed) {
        options.observe?.({ type: "lease-lost", name: options.name })
        throw new Error("reconciliation lease lost before checkpoint")
      }
      options.observe?.({
        type: "checkpoint",
        name: options.name,
        scanned,
        handled,
      })
      cursor = page.cursor
      if (cursor === undefined) break
    }
    return { acquired: true, pages, scanned, handled }
  } finally {
    if (
      await options.leases.release({
        name: options.name,
        owner: options.owner,
        token: lease.token,
      })
    ) {
      options.observe?.({ type: "released", name: options.name })
    }
  }
}

interface MemoryLeaseRecord {
  owner?: string
  token?: string
  expiresAt?: number
  cursor?: string
}

export class MemoryReconciliationLeaseStore implements ReconciliationLeaseStore {
  readonly durability = "memory" as const
  private readonly records = new Map<string, MemoryLeaseRecord>()

  acquire(
    input: Parameters<ReconciliationLeaseStore["acquire"]>[0],
  ): ReconciliationLease | undefined {
    assertToken(input.name, "reconciliation lease name")
    assertToken(input.owner, "reconciliation lease owner")
    const current = this.records.get(input.name)
    if (
      current?.owner !== undefined &&
      current.expiresAt !== undefined &&
      current.expiresAt > input.now
    ) {
      return undefined
    }
    const token = crypto.randomUUID()
    const expiresAt = input.now + input.leaseMs
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError("reconciliation lease overflow")
    this.records.set(input.name, {
      owner: input.owner,
      token,
      expiresAt,
      ...(current?.cursor === undefined ? {} : { cursor: current.cursor }),
    })
    return Object.freeze({
      name: input.name,
      owner: input.owner,
      token,
      expiresAt,
      ...(current?.cursor === undefined ? {} : { cursor: current.cursor }),
    })
  }

  renew(input: Parameters<ReconciliationLeaseStore["renew"]>[0]): boolean {
    const record = this.records.get(input.name)
    if (
      record?.owner !== input.owner ||
      !safeEqual(record.token, input.token) ||
      (record.expiresAt ?? 0) <= input.now
    )
      return false
    const expiresAt = input.now + input.leaseMs
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError("reconciliation lease overflow")
    record.expiresAt = expiresAt
    return true
  }

  checkpoint(input: Parameters<ReconciliationLeaseStore["checkpoint"]>[0]): boolean {
    const record = this.records.get(input.name)
    if (record?.owner !== input.owner || !safeEqual(record.token, input.token)) return false
    if (input.cursor === undefined) delete record.cursor
    else record.cursor = input.cursor
    return true
  }

  release(input: Parameters<ReconciliationLeaseStore["release"]>[0]): boolean {
    const record = this.records.get(input.name)
    if (record?.owner !== input.owner || !safeEqual(record.token, input.token)) return false
    delete record.owner
    delete record.token
    delete record.expiresAt
    return true
  }
}

interface SpecializedWorkerOptions<Finding> {
  readonly name: string
  readonly owner: string
  readonly leases: ReconciliationLeaseStore
  readonly staleBefore: number
  readonly leaseMs?: number
  readonly batchSize?: number
  readonly maxPages?: number
  readonly concurrency?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly filter?: (finding: Finding) => boolean
  readonly handle: (finding: Finding, signal: AbortSignal) => void | PromiseLike<void>
  readonly observe?: (event: ReconciliationWorkerEvent) => void
}

export function runEffectReconciliationWorker(
  store: DurableEffectStore,
  options: SpecializedWorkerOptions<EffectReconciliationFinding>,
): Promise<ReconciliationWorkerResult> {
  return runReconciliationWorker({
    ...options,
    scan: ({ cursor, limit }) =>
      reconcileEffectsPage(store, {
        staleBefore: options.staleBefore,
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      }),
  })
}

export function runSagaReconciliationWorker(
  store: SagaStore,
  options: SpecializedWorkerOptions<SagaReconciliationFinding>,
): Promise<ReconciliationWorkerResult> {
  return runReconciliationWorker({
    ...options,
    scan: ({ cursor, limit }) =>
      reconcileSagasPage(store, {
        staleBefore: options.staleBefore,
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      }),
  })
}
