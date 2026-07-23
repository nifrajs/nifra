import { describe, expect, test } from "bun:test"
import type { DurableEffectStore, SagaStore } from "../src/durable-execution.ts"
import {
  MemoryReconciliationLeaseStore,
  runEffectReconciliationWorker,
  runReconciliationWorker,
  runSagaReconciliationWorker,
} from "../src/reconciliation-worker.ts"

describe("bounded reconciliation worker", () => {
  test("persists cursors under a lease with filters, concurrency, and metrics", async () => {
    const leases = new MemoryReconciliationLeaseStore()
    const handled: number[] = []
    const metrics: string[] = []
    const pages = [{ findings: [1, 2, 3], cursor: "next" }, { findings: [4] }]
    let scans = 0
    let active = 0
    let peak = 0

    const result = await runReconciliationWorker({
      name: "effects",
      owner: "worker-a",
      leases,
      leaseMs: 10_000,
      batchSize: 3,
      maxPages: 2,
      concurrency: 2,
      scan: async ({ cursor }) => {
        expect(cursor).toBe(scans === 0 ? undefined : "next")
        return pages[scans++]!
      },
      filter: (finding) => finding % 2 === 0,
      handle: async (finding) => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        handled.push(finding)
        active--
      },
      observe: (event) => metrics.push(event.type),
    })

    expect(result).toEqual({ acquired: true, pages: 2, scanned: 4, handled: 2 })
    expect(handled).toEqual([2, 4])
    expect(peak).toBeLessThanOrEqual(2)
    expect(metrics).toContain("checkpoint")
    expect(
      (
        await leases.acquire({
          name: "effects",
          owner: "worker-b",
          now: Date.now(),
          leaseMs: 10_000,
        })
      )?.cursor,
    ).toBeUndefined()
  })

  test("fails closed when another owner holds the lease", async () => {
    const leases = new MemoryReconciliationLeaseStore()
    await leases.acquire({
      name: "effects",
      owner: "worker-a",
      now: 1,
      leaseMs: 10_000,
    })
    const result = await runReconciliationWorker({
      name: "effects",
      owner: "worker-b",
      leases,
      now: () => 2,
      leaseMs: 100,
      scan: async () => ({ findings: [] }),
      handle: async () => {},
    })
    expect(result).toEqual({ acquired: false, pages: 0, scanned: 0, handled: 0 })
  })

  test("effect and saga wrappers bind bounded reconciliation scans", async () => {
    const leases = new MemoryReconciliationLeaseStore()
    const effects = {
      durability: "durable",
      scan: async (input: { readonly cursor?: string }) => ({
        records: [
          {
            effectId: "effect-1",
            capability: "db.write",
            state: "executing",
            updatedAt: 1,
            version: 1,
          },
        ],
        cursor: input.cursor,
      }),
    } as unknown as DurableEffectStore
    const effectFindings: string[] = []
    const effectResult = await runEffectReconciliationWorker(effects, {
      name: "effect-worker",
      owner: "worker-a",
      leases,
      staleBefore: 2,
      maxPages: 1,
      handle: (finding) => {
        effectFindings.push(finding.effectId)
      },
    })
    expect(effectResult.handled).toBe(1)
    expect(effectFindings).toEqual(["effect-1"])

    const sagas = {
      durability: "durable",
      scan: async () => ({
        records: [
          {
            sagaId: "saga-1",
            definition: "checkout",
            state: "manual-review",
            input: {},
            steps: [],
            createdAt: 1,
            updatedAt: 1,
            version: 1,
          },
        ],
      }),
    } as unknown as SagaStore
    const sagaFindings: string[] = []
    const sagaResult = await runSagaReconciliationWorker(sagas, {
      name: "saga-worker",
      owner: "worker-a",
      leases,
      staleBefore: 2,
      maxPages: 1,
      handle: (finding) => {
        sagaFindings.push(finding.sagaId)
      },
    })
    expect(sagaResult.handled).toBe(1)
    expect(sagaFindings).toEqual(["saga-1"])
  })
})
