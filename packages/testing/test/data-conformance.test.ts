import { describe, expect, test } from "bun:test"
import {
  assertDataAdapterConformance,
  type DataAdapterConformanceTarget,
  runDataAdapterConformance,
} from "../src/data-conformance.ts"

interface Row {
  readonly tenant: string
  readonly id: string
}

interface Handle {
  readonly state: Map<string, Row[]>
}

type Snapshot = Map<string, Row[]>

const clone = (state: Map<string, Row[]>): Map<string, Row[]> =>
  new Map([...state.entries()].map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]))

function target(
  swallowTransactionError = false,
): DataAdapterConformanceTarget<Handle, Row, Snapshot> {
  const state = new Map<string, Row[]>()
  return {
    createAdapter: async () => ({ state }),
    seed: async (adapter, scope, row) => {
      const rows = adapter.state.get(scope.token) ?? []
      adapter.state.set(scope.token, [...rows, row])
    },
    read: async (adapter, scope) => adapter.state.get(scope.token) ?? [],
    write: async (adapter, scope, row, signal) => {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError")
      const rows = adapter.state.get(scope.token) ?? []
      adapter.state.set(scope.token, [...rows, row])
    },
    transaction: async (adapter, scope, run) => {
      const snapshot = clone(adapter.state)
      const transaction = {
        write: async (row: Row) => {
          const rows = adapter.state.get(scope.token) ?? []
          adapter.state.set(scope.token, [...rows, row])
        },
      }
      try {
        return await run(transaction)
      } catch (error) {
        adapter.state.clear()
        for (const [key, rows] of snapshot) adapter.state.set(key, rows)
        if (swallowTransactionError) return undefined as never
        throw error
      }
    },
    page: async (adapter, scope, cursor) => {
      const rows = adapter.state.get(scope.token) ?? []
      const offset = cursor === undefined ? 0 : Number(cursor)
      const items = rows.slice(offset, offset + 1)
      const next = offset + items.length
      return {
        items,
        ...(next < rows.length ? { cursor: String(next) } : {}),
      }
    },
    snapshot: async (adapter) => clone(adapter.state),
    restore: async (adapter, snapshot) => {
      adapter.state.clear()
      for (const [key, rows] of snapshot) adapter.state.set(key, rows)
    },
    rowKey: (row) => `${row.tenant}:${row.id}`,
  }
}

describe("data adapter conformance", () => {
  test("proves tenant isolation, rollback, cancellation, paging, backup, and sharing", async () => {
    const report = await runDataAdapterConformance(target(), {
      scopes: {
        left: { token: "left" },
        right: { token: "right" },
      },
      rows: {
        left: { tenant: "left", id: "left" },
        right: { tenant: "right", id: "right" },
        rollback: { tenant: "left", id: "rollback" },
        shared: { tenant: "left", id: "shared" },
      },
    })
    expect(report.ok).toBe(true)
    expect(Object.values(report.checks).every((status) => status === "pass")).toBe(true)
    await expect(assertDataAdapterConformance(target())).resolves.toBeUndefined()
  })

  test("each broken guarantee fails its own check", async () => {
    const failing = async (
      broken: Partial<DataAdapterConformanceTarget<Handle, Row, Snapshot>>,
    ): Promise<string[]> => {
      const report = await runDataAdapterConformance({ ...target(), ...broken })
      return Object.entries(report.checks)
        .filter(([, status]) => status === "fail")
        .map(([check]) => check)
    }
    // Failing for another reason is not honoring the signal.
    expect(
      await failing({
        write: async () => {
          throw new Error("ECONNREFUSED 10.0.0.5:5432")
        },
      }),
    ).toEqual(["cancellation"])
    // Nor is reporting an abort after the row was written.
    expect(
      await failing({
        write: async (adapter, scope, row) => {
          adapter.state.set(scope.token, [...(adapter.state.get(scope.token) ?? []), row])
          throw new DOMException("cancelled", "AbortError")
        },
      }),
    ).toEqual(["cancellation"])
    expect(await failing({ page: async () => ({ items: [] }) })).toEqual(["pagination"])
    expect(
      await failing({
        restore: async (adapter) => {
          adapter.state.clear()
        },
      }),
    ).toEqual(["backup-restore"])
  })

  test("fails closed when a transaction swallows a rejected callback", async () => {
    const report = await runDataAdapterConformance(target(true), {
      scopes: {
        left: { token: "left" },
        right: { token: "right" },
      },
      rows: {
        left: { tenant: "left", id: "left" },
        right: { tenant: "right", id: "right" },
        rollback: { tenant: "left", id: "rollback" },
        shared: { tenant: "left", id: "shared" },
      },
    })
    expect(report.ok).toBe(false)
    expect(report.checks["transaction-rollback"]).toBe("fail")
    expect(report.failures).toContainEqual({
      check: "transaction-rollback",
      message: "transaction-rollback conformance check failed",
    })
  })
})
