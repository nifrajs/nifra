import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  createDurableExecutionAdapter,
  MemoryDurableRecordBackend,
  runDurableExecutionAdapterConformance,
  SQLiteDurableExecutionAdapter,
} from "../src/durable-adapters.ts"

describe("durable execution adapter conformance", () => {
  test("one atomic backend satisfies effect, approval, saga, and lease semantics", async () => {
    const adapter = createDurableExecutionAdapter(new MemoryDurableRecordBackend())
    const result = await runDurableExecutionAdapterConformance(adapter)
    expect(result).toEqual({
      effects: true,
      approvals: true,
      sagas: true,
      leases: true,
    })
  })

  test("SQLite production adapter passes the shared conformance suite", async () => {
    const db = new Database(":memory:")
    try {
      const adapter = new SQLiteDurableExecutionAdapter(db)
      adapter.migrate()
      expect(await runDurableExecutionAdapterConformance(adapter)).toEqual({
        effects: true,
        approvals: true,
        sagas: true,
        leases: true,
      })
    } finally {
      db.close()
    }
  })
})
