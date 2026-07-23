import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  createDurableExecutionAdapter,
  DurableObjectExecutionAdapter,
  type DurableObjectStorage,
  MemoryDurableRecordBackend,
  type PostgresClient,
  PostgresDurableExecutionAdapter,
  PostgresDurableRecordBackend,
  type PostgresQueryResult,
  runDurableExecutionAdapterConformance,
  SQLiteDurableExecutionAdapter,
} from "../src/durable-adapters.ts"
import { stringify as stringifyWire } from "../src/wire.ts"

class MemoryDurableObjectStorage implements DurableObjectStorage {
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }
  async list<T>(
    options: {
      readonly prefix?: string
      readonly startAfter?: string
      readonly limit?: number
    } = {},
  ): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
      .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, options.limit)
    return new Map(entries) as Map<string, T>
  }
  transaction<T>(closure: (transaction: this) => Promise<T>): Promise<T> {
    return closure(this)
  }
}

class ScriptedPostgresClient implements PostgresClient {
  readonly queries: Array<{ readonly sql: string; readonly values?: readonly unknown[] }> = []
  readonly responses: PostgresQueryResult[] = []

  async query(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult> {
    this.queries.push({ sql, ...(values === undefined ? {} : { values }) })
    return this.responses.shift() ?? { rows: [] }
  }
}

describe("durable execution adapter conformance", () => {
  test("one atomic backend satisfies effect, approval, saga, and lease semantics", async () => {
    const backend = new MemoryDurableRecordBackend()
    const adapter = createDurableExecutionAdapter(backend)
    const result = await runDurableExecutionAdapterConformance(adapter)
    expect(result).toEqual({
      effects: true,
      approvals: true,
      sagas: true,
      leases: true,
    })

    await backend.create("effect", "scan-a", {
      version: 1,
      state: "executing",
      updatedAt: 1,
    })
    await backend.create("effect", "scan-b", {
      version: 1,
      state: "executing",
      updatedAt: 2,
    })
    expect(
      await backend.compareAndSet("effect", "scan-a", 1, {
        version: 2,
        state: "executing",
        updatedAt: 1,
      }),
    ).toBe(true)
    const page = await backend.scan("effect", {
      states: ["executing"],
      updatedBefore: 2,
      limit: 1,
    })
    expect(page.records).toHaveLength(1)
    expect(page.cursor).toBeDefined()
    expect(await adapter.effects.scan?.({ states: ["executing"], limit: 1 })).toBeDefined()

    const lease = await backend.acquireLease({ name: "negative", owner: "a", now: 1, leaseMs: 2 })
    expect(lease).toBeDefined()
    expect(
      await backend.acquireLease({ name: "negative", owner: "b", now: 2, leaseMs: 2 }),
    ).toBeUndefined()
    expect(
      await backend.renewLease({
        name: "negative",
        owner: "a",
        token: lease!.token,
        now: 3,
        leaseMs: 2,
      }),
    ).toBe(false)
    expect(
      await backend.checkpointLease({
        name: "negative",
        owner: "wrong",
        token: lease!.token,
        cursor: "next",
      }),
    ).toBe(false)
    expect(
      await backend.releaseLease({ name: "negative", owner: "wrong", token: lease!.token }),
    ).toBe(false)
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
      expect(await adapter.backend.scan("effect", { states: [], limit: 1 })).toEqual({
        records: [],
      })
    } finally {
      db.close()
    }
  })

  test("Durable Object production adapter passes the shared conformance suite", async () => {
    const adapter = new DurableObjectExecutionAdapter(new MemoryDurableObjectStorage())
    expect(await runDurableExecutionAdapterConformance(adapter)).toEqual({
      effects: true,
      approvals: true,
      sagas: true,
      leases: true,
    })
    expect(await adapter.backend.scan("effect", { states: ["executing"], limit: 1 })).toBeDefined()
    expect(
      await adapter.backend.renewLease({
        name: "missing",
        owner: "a",
        token: "token",
        now: 1,
        leaseMs: 1,
      }),
    ).toBe(false)
    expect(
      await adapter.backend.checkpointLease({
        name: "missing",
        owner: "a",
        token: "token",
        cursor: "next",
      }),
    ).toBe(false)
    expect(
      await adapter.backend.releaseLease({ name: "missing", owner: "a", token: "token" }),
    ).toBe(false)
  })

  test("Postgres adapter parameterizes records and exercises every atomic primitive", async () => {
    const client = new ScriptedPostgresClient()
    const backend = new PostgresDurableRecordBackend(client, { tablePrefix: "tenant_a" })
    await backend.migrate()
    expect(client.queries).toHaveLength(3)

    client.responses.push({ rows: [{ id: "one" }] })
    expect(await backend.create("effect", "one", { version: 1, state: "admission" })).toBe(true)
    client.responses.push({
      rows: [{ payload: stringifyWire({ version: 1, state: "admission" }) }],
    })
    expect(
      await backend.get<{ readonly version: number; readonly state: string }>("effect", "one"),
    ).toEqual({ version: 1, state: "admission" })
    expect(
      await backend.compareAndSet("effect", "one", 1, { version: 3, state: "executing" }),
    ).toBe(false)
    client.responses.push({ rows: [{ id: "one" }] })
    expect(
      await backend.compareAndSet("effect", "one", 1, {
        version: 2,
        state: "executing",
        updatedAt: 2,
      }),
    ).toBe(true)

    client.responses.push({
      rows: [
        { id: "one", payload: stringifyWire({ version: 2, state: "executing", updatedAt: 2 }) },
        { id: "two", payload: stringifyWire({ version: 1, state: "executing", updatedAt: 2 }) },
      ],
    })
    const page = await backend.scan("effect", {
      states: ["executing"],
      updatedBefore: 3,
      limit: 1,
    })
    expect(page.records).toHaveLength(1)
    expect(page.cursor).toBe("one")

    client.responses.push({ rows: [] })
    expect(
      await backend.acquireLease({ name: "worker", owner: "a", now: 1, leaseMs: 10 }),
    ).toBeUndefined()
    client.responses.push({
      rows: [{ name: "worker", owner: "a", token: "token", expires_at: 11, cursor: "next" }],
    })
    expect(
      await backend.acquireLease({ name: "worker", owner: "a", now: 1, leaseMs: 10 }),
    ).toMatchObject({ token: "token", cursor: "next" })
    for (const operation of [
      () => backend.renewLease({ name: "worker", owner: "a", token: "token", now: 2, leaseMs: 10 }),
      () => backend.checkpointLease({ name: "worker", owner: "a", token: "token", cursor: "next" }),
      () => backend.releaseLease({ name: "worker", owner: "a", token: "token" }),
    ]) {
      client.responses.push({ rows: [{ name: "worker" }] })
      expect(await operation()).toBe(true)
    }

    const adapterClient = new ScriptedPostgresClient()
    const adapter = new PostgresDurableExecutionAdapter(adapterClient)
    await adapter.migrate()
    expect(adapter.effects.durability).toBe("durable")
    expect(() => new PostgresDurableRecordBackend(client, { tablePrefix: "bad-prefix" })).toThrow(
      "invalid SQL table prefix",
    )
  })
})
