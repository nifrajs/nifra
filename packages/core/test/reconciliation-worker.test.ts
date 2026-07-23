import { describe, expect, test } from "bun:test"
import {
  MemoryReconciliationLeaseStore,
  runReconciliationWorker,
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
})
