import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  createDurableExecutionAdapter,
  type DurableExecutionAdapter,
  DurableObjectExecutionAdapter,
  DurableObjectRecordBackend,
  type DurableObjectStorage,
  type DurableRecordBackend,
  MemoryDurableRecordBackend,
  type PostgresClient,
  PostgresDurableExecutionAdapter,
  PostgresDurableRecordBackend,
  type PostgresQueryResult,
  runDurableExecutionAdapterConformance,
  SQLiteDurableExecutionAdapter,
  SQLiteDurableRecordBackend,
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

function postgresConformanceAdapter(): PostgresDurableExecutionAdapter {
  const client = new ScriptedPostgresClient()
  const effect = {
    effectId: "effect",
    capability: "test.write",
    state: "admission",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  }
  const approval = {
    approvalId: "approval",
    effectId: "effect",
    capability: "test.write",
    tenantId: "tenant",
    principalId: "principal",
    tokenHash: "hash",
    state: "pending",
    createdAt: 1,
    expiresAt: 100,
    updatedAt: 1,
    version: 1,
  }
  client.responses.push(
    { rows: [{ id: "effect" }] },
    { rows: [] },
    { rows: [{ payload: stringifyWire(effect) }] },
    { rows: [{ id: "effect" }] },
    {
      rows: [
        {
          payload: stringifyWire({ ...effect, state: "executing", version: 2, updatedAt: 2 }),
        },
      ],
    },
    { rows: [{ id: "approval" }] },
    { rows: [{ payload: stringifyWire(approval) }] },
    { rows: [{ id: "approval" }] },
    {
      rows: [
        {
          payload: stringifyWire({ ...approval, state: "approved", version: 2, updatedAt: 2 }),
        },
      ],
    },
    { rows: [{ id: "approval" }] },
    {
      rows: [
        {
          payload: stringifyWire({ ...approval, state: "consumed", version: 3, updatedAt: 3 }),
        },
      ],
    },
    { rows: [{ id: "saga" }] },
    { rows: [{ id: "saga" }] },
    { rows: [{ name: "worker", owner: "a", token: "token", expires_at: 101 }] },
    { rows: [] },
    { rows: [{ name: "worker" }] },
    { rows: [{ name: "worker" }] },
  )
  return new PostgresDurableExecutionAdapter(client)
}

describe("durable execution adapter conformance", () => {
  test("one atomic backend exposes the expected primitives", async () => {
    const backend = new MemoryDurableRecordBackend()
    const adapter = createDurableExecutionAdapter(backend)

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

  const adapterCases: readonly {
    readonly name: string
    readonly create: () => {
      readonly adapter: DurableExecutionAdapter
      readonly close?: () => void
    }
  }[] = [
    {
      name: "memory",
      create: () => ({ adapter: createDurableExecutionAdapter(new MemoryDurableRecordBackend()) }),
    },
    {
      name: "sqlite",
      create: () => {
        const db = new Database(":memory:")
        const adapter = new SQLiteDurableExecutionAdapter(db)
        adapter.migrate()
        return { adapter, close: () => db.close() }
      },
    },
    {
      name: "durable object",
      create: () => ({
        adapter: new DurableObjectExecutionAdapter(new MemoryDurableObjectStorage()),
      }),
    },
    {
      name: "postgres",
      create: () => ({ adapter: postgresConformanceAdapter() }),
    },
  ] as const

  for (const candidate of adapterCases) {
    test(`${candidate.name} adapter passes the shared protocol conformance suite`, async () => {
      const instance = candidate.create()
      try {
        expect(await runDurableExecutionAdapterConformance(instance.adapter)).toEqual({
          effects: true,
          approvals: true,
          sagas: true,
          leases: true,
        })
      } finally {
        instance.close?.()
      }
    })
  }

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
    expect(
      () => new PostgresDurableRecordBackend(client, { tablePrefix: `a${"b".repeat(44)}` }),
    ).not.toThrow()
    expect(
      () => new PostgresDurableRecordBackend(client, { tablePrefix: `a${"b".repeat(45)}` }),
    ).toThrow("invalid SQL table prefix")
  })

  // The reconciliation `scan` + lease lifecycle on the SQLite and Durable-Object record backends is only
  // reached by a reconciliation worker, not the atomic-primitive conformance suite. Drive both directly
  // against their real in-memory fakes so scan pagination and the lease acquire/renew/checkpoint/release
  // paths stay covered.
  async function exercisesScanAndLeaseLifecycle(backend: DurableRecordBackend): Promise<void> {
    expect(
      await backend.create("effect", "r-1", { version: 1, state: "executing", updatedAt: 1 }),
    ).toBe(true)
    expect(
      await backend.create("effect", "r-2", { version: 1, state: "executing", updatedAt: 2 }),
    ).toBe(true)
    expect(
      await backend.create("effect", "r-3", { version: 1, state: "admission", updatedAt: 3 }),
    ).toBe(true)

    const full = await backend.scan("effect", { states: ["executing"], updatedBefore: 5, limit: 5 })
    expect(full.records).toHaveLength(2)
    expect(full.cursor).toBeUndefined()

    const firstPage = await backend.scan("effect", {
      states: ["executing"],
      updatedBefore: 5,
      limit: 1,
    })
    expect(firstPage.records).toHaveLength(1)
    expect(firstPage.cursor).toBeDefined()

    const lease = await backend.acquireLease({ name: "worker", owner: "a", now: 10, leaseMs: 100 })
    expect(lease?.owner).toBe("a")
    const token = lease?.token ?? ""
    expect(
      await backend.acquireLease({ name: "worker", owner: "b", now: 20, leaseMs: 100 }),
    ).toBeUndefined()
    expect(
      await backend.renewLease({
        name: "worker",
        owner: "a",
        token: "wrong",
        now: 30,
        leaseMs: 100,
      }),
    ).toBe(false)
    expect(
      await backend.renewLease({ name: "worker", owner: "a", token, now: 30, leaseMs: 100 }),
    ).toBe(true)
    expect(
      await backend.checkpointLease({ name: "worker", owner: "a", token, cursor: "r-2" }),
    ).toBe(true)
    expect(await backend.releaseLease({ name: "worker", owner: "a", token })).toBe(true)
  }

  test("SQLite record backend covers scan pagination and the lease lifecycle", async () => {
    const db = new Database(":memory:")
    try {
      const backend = new SQLiteDurableRecordBackend(db)
      backend.migrate()
      expect(await backend.scan("effect", { states: [], limit: 5 })).toEqual({ records: [] })
      await exercisesScanAndLeaseLifecycle(backend)
    } finally {
      db.close()
    }
  })

  test("Durable-Object record backend covers scan pagination and the lease lifecycle", async () => {
    await exercisesScanAndLeaseLifecycle(
      new DurableObjectRecordBackend(new MemoryDurableObjectStorage()),
    )
  })
})
