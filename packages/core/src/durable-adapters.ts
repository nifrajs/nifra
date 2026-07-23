/**
 * Common durable execution persistence adapter. Concrete storage backends only implement atomic
 * insert/CAS/scan/lease primitives; these views supply the effect, approval, saga, and worker APIs.
 */
import type {
  ApprovalConsumeResult,
  ApprovalRecord,
  ApprovalStore,
  DurableEffectRecord,
  DurableEffectStore,
  ReconciliationScanOptions,
  ReconciliationScanPage,
  SagaRecord,
  SagaStore,
} from "./durable-execution.ts"
import { safeEqual } from "./internal/safe-equal.ts"
import type { ReconciliationLease, ReconciliationLeaseStore } from "./reconciliation-worker.ts"
import { parse as parseWire, stringify as stringifyWire } from "./wire.ts"

export type DurableRecordKind = "effect" | "approval" | "saga"

export interface DurableRecordBackend {
  create(
    kind: DurableRecordKind,
    id: string,
    record: {
      readonly version: number
      readonly state?: string
      readonly updatedAt?: number
    },
  ): Promise<boolean>
  get<T extends { readonly version: number }>(
    kind: DurableRecordKind,
    id: string,
  ): Promise<T | undefined>
  compareAndSet(
    kind: DurableRecordKind,
    id: string,
    expectedVersion: number,
    record: {
      readonly version: number
      readonly state?: string
      readonly updatedAt?: number
    },
  ): Promise<boolean>
  scan<T extends { readonly state: string; readonly updatedAt: number }>(
    kind: DurableRecordKind,
    input: ReconciliationScanOptions<string>,
  ): Promise<ReconciliationScanPage<T>>
  acquireLease(input: {
    readonly name: string
    readonly owner: string
    readonly now: number
    readonly leaseMs: number
  }): Promise<ReconciliationLease | undefined>
  renewLease(input: {
    readonly name: string
    readonly owner: string
    readonly token: string
    readonly now: number
    readonly leaseMs: number
  }): Promise<boolean>
  checkpointLease(input: {
    readonly name: string
    readonly owner: string
    readonly token: string
    readonly cursor?: string
  }): Promise<boolean>
  releaseLease(input: {
    readonly name: string
    readonly owner: string
    readonly token: string
  }): Promise<boolean>
}

export interface DurableExecutionAdapter {
  readonly effects: DurableEffectStore
  readonly approvals: ApprovalStore
  readonly sagas: SagaStore
  readonly leases: ReconciliationLeaseStore
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createDurableExecutionAdapter(
  backend: DurableRecordBackend,
): DurableExecutionAdapter {
  const effects: DurableEffectStore = {
    durability: "durable",
    create: (record) => backend.create("effect", record.effectId, clone(record)),
    get: (effectId) => backend.get<DurableEffectRecord>("effect", effectId),
    async transition(input) {
      const current = await backend.get<DurableEffectRecord>("effect", input.effectId)
      if (
        current === undefined ||
        current.version !== input.version ||
        current.state !== input.from
      ) {
        return false
      }
      const next: DurableEffectRecord = {
        ...current,
        state: input.to,
        updatedAt: input.updatedAt,
        version: current.version + 1,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      }
      return await backend.compareAndSet("effect", input.effectId, input.version, next)
    },
    scan: (input) =>
      backend.scan<DurableEffectRecord>("effect", input as ReconciliationScanOptions<string>),
  }

  const approvals: ApprovalStore = {
    durability: "durable",
    create: (record) => backend.create("approval", record.approvalId, clone(record)),
    get: (approvalId) => backend.get<ApprovalRecord>("approval", approvalId),
    async decide(input) {
      const current = await backend.get<ApprovalRecord>("approval", input.approvalId)
      if (
        current === undefined ||
        current.tenantId !== input.tenantId ||
        current.state !== "pending" ||
        current.expiresAt <= input.now
      ) {
        return false
      }
      const decided: ApprovalRecord = {
        ...current,
        state: input.decision,
        decidedBy: input.decidedBy,
        updatedAt: input.now,
        version: current.version + 1,
      }
      return await backend.compareAndSet("approval", input.approvalId, current.version, decided)
    },
    async consume(input): Promise<ApprovalConsumeResult> {
      const current = await backend.get<ApprovalRecord>("approval", input.approvalId)
      if (current === undefined) return { state: "missing" }
      if (current.tenantId !== input.tenantId || current.principalId !== input.principalId)
        return { state: "binding" }
      if (
        current.capability !== input.capability ||
        current.target !== input.target ||
        !safeEqual(current.digest, input.digest)
      )
        return { state: "binding" }
      if (!safeEqual(current.tokenHash, input.tokenHash)) return { state: "token" }
      if (current.state === "consumed") return { state: "replay" }
      if (current.state === "denied") return { state: "denied" }
      if (current.state === "pending") return { state: "pending" }
      if (current.state === "expired" || current.expiresAt <= input.now) return { state: "expired" }
      const consumed = await backend.compareAndSet("approval", input.approvalId, current.version, {
        ...current,
        state: "consumed",
        updatedAt: input.now,
        version: current.version + 1,
      })
      return consumed ? { state: "consumed" } : { state: "replay" }
    },
  }

  const sagas: SagaStore = {
    durability: "durable",
    create: (record) => backend.create("saga", record.sagaId, clone(record)),
    get: (sagaId) => backend.get<SagaRecord>("saga", sagaId),
    compareAndSet: (input) =>
      backend.compareAndSet("saga", input.sagaId, input.version, clone(input.record)),
    scan: (input) => backend.scan<SagaRecord>("saga", input as ReconciliationScanOptions<string>),
  }

  const leases: ReconciliationLeaseStore = {
    durability: "durable",
    acquire: (input) => backend.acquireLease(input),
    renew: (input) => backend.renewLease(input),
    checkpoint: (input) => backend.checkpointLease(input),
    release: (input) => backend.releaseLease(input),
  }
  return Object.freeze({ effects, approvals, sagas, leases })
}

interface MemoryRecord {
  readonly version: number
  readonly state?: string
  readonly updatedAt?: number
}
interface MemoryLease {
  owner?: string
  token?: string
  expiresAt?: number
  cursor?: string
}

/** Deterministic reference backend for tests and adapter conformance; not for production. */
export class MemoryDurableRecordBackend implements DurableRecordBackend {
  private readonly records = new Map<string, MemoryRecord>()
  private readonly leases = new Map<string, MemoryLease>()
  private key(kind: DurableRecordKind, id: string): string {
    return `${kind}:${id}`
  }
  async create(
    kind: DurableRecordKind,
    id: string,
    record: {
      readonly version: number
      readonly state?: string
      readonly updatedAt?: number
    },
  ): Promise<boolean> {
    const key = this.key(kind, id)
    if (this.records.has(key)) return false
    this.records.set(key, clone(record))
    return true
  }
  async get<T extends { readonly version: number }>(
    kind: DurableRecordKind,
    id: string,
  ): Promise<T | undefined> {
    const value = this.records.get(this.key(kind, id))
    return value === undefined ? undefined : clone(value as T)
  }
  async compareAndSet(
    kind: DurableRecordKind,
    id: string,
    expectedVersion: number,
    record: {
      readonly version: number
      readonly state?: string
      readonly updatedAt?: number
    },
  ): Promise<boolean> {
    const key = this.key(kind, id)
    const current = this.records.get(key)
    if (current?.version !== expectedVersion || record.version !== expectedVersion + 1) return false
    this.records.set(key, clone(record))
    return true
  }
  async scan<T extends { readonly state: string; readonly updatedAt: number }>(
    kind: DurableRecordKind,
    input: ReconciliationScanOptions<string>,
  ): Promise<ReconciliationScanPage<T>> {
    const prefix = `${kind}:`
    const records = [...this.records.entries()]
      .filter(([key, value]) => {
        if (!key.startsWith(prefix) || !input.states.includes(value.state ?? "")) return false
        return input.updatedBefore === undefined || (value.updatedAt ?? 0) <= input.updatedBefore
      })
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([key]) => input.cursor === undefined || key > prefix + input.cursor)
    const page = records.slice(0, input.limit)
    return Object.freeze({
      records: Object.freeze(page.map(([, value]) => clone(value as unknown as T))),
      ...(records.length > input.limit
        ? { cursor: (page.at(-1)?.[0] ?? "").slice(prefix.length) }
        : {}),
    })
  }
  async acquireLease(
    input: Parameters<DurableRecordBackend["acquireLease"]>[0],
  ): Promise<ReconciliationLease | undefined> {
    const current = this.leases.get(input.name)
    if (current?.owner !== undefined && (current.expiresAt ?? 0) > input.now) return undefined
    const expiresAt = input.now + input.leaseMs
    const token = crypto.randomUUID()
    const next = {
      owner: input.owner,
      token,
      expiresAt,
      ...(current?.cursor === undefined ? {} : { cursor: current.cursor }),
    }
    this.leases.set(input.name, next)
    return Object.freeze({ name: input.name, ...next }) as ReconciliationLease
  }
  async renewLease(input: Parameters<DurableRecordBackend["renewLease"]>[0]): Promise<boolean> {
    const current = this.leases.get(input.name)
    if (
      current?.owner !== input.owner ||
      !safeEqual(current.token, input.token) ||
      (current.expiresAt ?? 0) <= input.now
    )
      return false
    current.expiresAt = input.now + input.leaseMs
    return true
  }
  async checkpointLease(
    input: Parameters<DurableRecordBackend["checkpointLease"]>[0],
  ): Promise<boolean> {
    const current = this.leases.get(input.name)
    if (current?.owner !== input.owner || !safeEqual(current.token, input.token)) return false
    if (input.cursor === undefined) delete current.cursor
    else current.cursor = input.cursor
    return true
  }
  async releaseLease(input: Parameters<DurableRecordBackend["releaseLease"]>[0]): Promise<boolean> {
    const current = this.leases.get(input.name)
    if (current?.owner !== input.owner || !safeEqual(current.token, input.token)) return false
    delete current.owner
    delete current.token
    delete current.expiresAt
    return true
  }
}

export interface DurableExecutionConformanceResult {
  readonly effects: true
  readonly approvals: true
  readonly sagas: true
  readonly leases: true
}

function requireConformance(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`durable adapter conformance: ${message}`)
}

/** Runtime-independent conformance suite reusable by adapter authors and CI. */
export async function runDurableExecutionAdapterConformance(
  adapter: DurableExecutionAdapter,
): Promise<DurableExecutionConformanceResult> {
  const prefix = crypto.randomUUID()
  const effectId = `${prefix}-effect`
  const effect: DurableEffectRecord = {
    effectId,
    capability: "test.write",
    state: "admission",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  }
  requireConformance(await adapter.effects.create(effect), "effect create rejected")
  requireConformance(!(await adapter.effects.create(effect)), "duplicate effect create accepted")
  requireConformance(
    await adapter.effects.transition({
      effectId,
      version: 1,
      from: "admission",
      to: "executing",
      updatedAt: 2,
    }),
    "effect CAS rejected",
  )
  requireConformance(
    !(await adapter.effects.transition({
      effectId,
      version: 1,
      from: "admission",
      to: "failed",
      updatedAt: 3,
    })),
    "stale effect CAS accepted",
  )

  const approvalId = `${prefix}-approval`
  const approval: ApprovalRecord = {
    approvalId,
    effectId,
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
  requireConformance(await adapter.approvals.create(approval), "approval create rejected")
  requireConformance(
    await adapter.approvals.decide({
      approvalId,
      tenantId: "tenant",
      decision: "approved",
      decidedBy: "operator",
      now: 2,
    }),
    "approval decision rejected",
  )
  const consumed = await adapter.approvals.consume({
    approvalId,
    tenantId: "tenant",
    principalId: "principal",
    capability: "test.write",
    tokenHash: "hash",
    now: 3,
  })
  requireConformance(consumed.state === "consumed", "approval consume rejected")
  const replay = await adapter.approvals.consume({
    approvalId,
    tenantId: "tenant",
    principalId: "principal",
    capability: "test.write",
    tokenHash: "hash",
    now: 4,
  })
  requireConformance(replay.state === "replay", "approval replay not detected")

  const sagaId = `${prefix}-saga`
  const saga: SagaRecord = {
    sagaId,
    definition: "test",
    state: "running",
    input: null,
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  }
  requireConformance(await adapter.sagas.create(saga), "saga create rejected")
  requireConformance(
    await adapter.sagas.compareAndSet({
      sagaId,
      version: 1,
      record: { ...saga, state: "completed", updatedAt: 2, version: 2 },
    }),
    "saga CAS rejected",
  )

  const lease = await adapter.leases.acquire({
    name: `${prefix}-worker`,
    owner: "a",
    now: 1,
    leaseMs: 100,
  })
  requireConformance(lease !== undefined, "lease acquire rejected")
  requireConformance(
    (await adapter.leases.acquire({
      name: `${prefix}-worker`,
      owner: "b",
      now: 2,
      leaseMs: 100,
    })) === undefined,
    "live lease stolen",
  )
  requireConformance(
    await adapter.leases.checkpoint({
      name: lease.name,
      owner: lease.owner,
      token: lease.token,
      cursor: "next",
    }),
    "lease checkpoint rejected",
  )
  requireConformance(
    await adapter.leases.release({ name: lease.name, owner: lease.owner, token: lease.token }),
    "lease release rejected",
  )
  return { effects: true, approvals: true, sagas: true, leases: true }
}

// -------------------------------------------------------------------------------------------------
// PostgreSQL

export interface PostgresQueryResult {
  readonly rows: readonly Record<string, unknown>[]
  readonly rowCount?: number
}

export interface PostgresClient {
  query(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult>
}

function sqlIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError("invalid SQL table prefix")
  return value
}

function recordFromRow<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (row === undefined) return undefined
  const payload = row.payload
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  return clone(parseWire(text) as T)
}

function serializeRecord(record: unknown): string {
  return stringifyWire(record)
}

export class PostgresDurableRecordBackend implements DurableRecordBackend {
  readonly recordsTable: string
  readonly leasesTable: string
  constructor(
    private readonly client: PostgresClient,
    options: { readonly tablePrefix?: string } = {},
  ) {
    const prefix = sqlIdentifier(options.tablePrefix ?? "nifra_durable")
    this.recordsTable = `${prefix}_records`
    this.leasesTable = `${prefix}_leases`
  }

  async migrate(): Promise<void> {
    await this.client.query(
      "CREATE TABLE IF NOT EXISTS " +
        this.recordsTable +
        " (kind TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, updated_at BIGINT NOT NULL, version BIGINT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY (kind, id))",
    )
    await this.client.query(
      "CREATE INDEX IF NOT EXISTS " +
        this.recordsTable +
        "_reconcile ON " +
        this.recordsTable +
        " (kind, state, updated_at, id)",
    )
    await this.client.query(
      "CREATE TABLE IF NOT EXISTS " +
        this.leasesTable +
        " (name TEXT PRIMARY KEY, owner TEXT, token TEXT, expires_at BIGINT NOT NULL DEFAULT 0, cursor TEXT)",
    )
  }

  async create(
    kind: DurableRecordKind,
    id: string,
    record: { readonly version: number; readonly state?: string; readonly updatedAt?: number },
  ): Promise<boolean> {
    const result = await this.client.query(
      "INSERT INTO " +
        this.recordsTable +
        " (kind,id,state,updated_at,version,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING id",
      [
        kind,
        id,
        record.state ?? "",
        record.updatedAt ?? 0,
        record.version,
        serializeRecord(record),
      ],
    )
    return result.rows.length === 1
  }
  async get<T extends { readonly version: number }>(
    kind: DurableRecordKind,
    id: string,
  ): Promise<T | undefined> {
    const result = await this.client.query(
      `SELECT payload FROM ${this.recordsTable} WHERE kind=$1 AND id=$2`,
      [kind, id],
    )
    return recordFromRow<T>(result.rows[0])
  }
  async compareAndSet(
    kind: DurableRecordKind,
    id: string,
    expectedVersion: number,
    record: { readonly version: number; readonly state?: string; readonly updatedAt?: number },
  ): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    const result = await this.client.query(
      "UPDATE " +
        this.recordsTable +
        " SET state=$4,updated_at=$5,version=$6,payload=$7::jsonb WHERE kind=$1 AND id=$2 AND version=$3 RETURNING id",
      [
        kind,
        id,
        expectedVersion,
        record.state ?? "",
        record.updatedAt ?? 0,
        record.version,
        serializeRecord(record),
      ],
    )
    return result.rows.length === 1
  }
  async scan<T extends { readonly state: string; readonly updatedAt: number }>(
    kind: DurableRecordKind,
    input: ReconciliationScanOptions<string>,
  ): Promise<ReconciliationScanPage<T>> {
    const result = await this.client.query(
      "SELECT id,payload FROM " +
        this.recordsTable +
        " WHERE kind=$1 AND state = ANY($2::text[]) AND ($3::bigint IS NULL OR updated_at <= $3) AND ($4::text IS NULL OR id > $4) ORDER BY id LIMIT $5",
      [kind, input.states, input.updatedBefore ?? null, input.cursor ?? null, input.limit + 1],
    )
    const hasMore = result.rows.length > input.limit
    const rows = result.rows.slice(0, input.limit)
    return Object.freeze({
      records: Object.freeze(rows.map((row) => recordFromRow<T>(row) as T)),
      ...(hasMore ? { cursor: String(rows.at(-1)?.id) } : {}),
    })
  }
  async acquireLease(
    input: Parameters<DurableRecordBackend["acquireLease"]>[0],
  ): Promise<ReconciliationLease | undefined> {
    const token = crypto.randomUUID()
    const expiresAt = input.now + input.leaseMs
    const result = await this.client.query(
      "INSERT INTO " +
        this.leasesTable +
        " (name,owner,token,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO UPDATE SET owner=EXCLUDED.owner,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE " +
        this.leasesTable +
        ".expires_at <= $5 RETURNING name,owner,token,expires_at,cursor",
      [input.name, input.owner, token, expiresAt, input.now],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return Object.freeze({
      name: String(row.name),
      owner: String(row.owner),
      token: String(row.token),
      expiresAt: Number(row.expires_at),
      ...(row.cursor === null || row.cursor === undefined ? {} : { cursor: String(row.cursor) }),
    })
  }
  async renewLease(input: Parameters<DurableRecordBackend["renewLease"]>[0]): Promise<boolean> {
    const result = await this.client.query(
      "UPDATE " +
        this.leasesTable +
        " SET expires_at=$4 WHERE name=$1 AND owner=$2 AND token=$3 AND expires_at>$5 RETURNING name",
      [input.name, input.owner, input.token, input.now + input.leaseMs, input.now],
    )
    return result.rows.length === 1
  }
  async checkpointLease(
    input: Parameters<DurableRecordBackend["checkpointLease"]>[0],
  ): Promise<boolean> {
    const result = await this.client.query(
      "UPDATE " +
        this.leasesTable +
        " SET cursor=$4 WHERE name=$1 AND owner=$2 AND token=$3 RETURNING name",
      [input.name, input.owner, input.token, input.cursor ?? null],
    )
    return result.rows.length === 1
  }
  async releaseLease(input: Parameters<DurableRecordBackend["releaseLease"]>[0]): Promise<boolean> {
    const result = await this.client.query(
      "UPDATE " +
        this.leasesTable +
        " SET owner=NULL,token=NULL,expires_at=0 WHERE name=$1 AND owner=$2 AND token=$3 RETURNING name",
      [input.name, input.owner, input.token],
    )
    return result.rows.length === 1
  }
}

export class PostgresDurableExecutionAdapter implements DurableExecutionAdapter {
  readonly effects: DurableEffectStore
  readonly approvals: ApprovalStore
  readonly sagas: SagaStore
  readonly leases: ReconciliationLeaseStore
  readonly backend: PostgresDurableRecordBackend
  constructor(client: PostgresClient, options: { readonly tablePrefix?: string } = {}) {
    this.backend = new PostgresDurableRecordBackend(client, options)
    const views = createDurableExecutionAdapter(this.backend)
    this.effects = views.effects
    this.approvals = views.approvals
    this.sagas = views.sagas
    this.leases = views.leases
  }
  migrate(): Promise<void> {
    return this.backend.migrate()
  }
}

// -------------------------------------------------------------------------------------------------
// SQLite (Bun SQLite and compatible drivers)

export interface SQLiteRunResult {
  readonly changes: number
}
export interface SQLiteStatement {
  run(...values: readonly unknown[]): SQLiteRunResult
  get(...values: readonly unknown[]): Record<string, unknown> | null | undefined
  all(...values: readonly unknown[]): readonly (Record<string, unknown> | undefined)[]
}
export interface SQLiteClient {
  exec(sql: string): unknown
  query(sql: string): SQLiteStatement
}

export class SQLiteDurableRecordBackend implements DurableRecordBackend {
  readonly recordsTable: string
  readonly leasesTable: string
  constructor(
    private readonly client: SQLiteClient,
    options: { readonly tablePrefix?: string } = {},
  ) {
    const prefix = sqlIdentifier(options.tablePrefix ?? "nifra_durable")
    this.recordsTable = `${prefix}_records`
    this.leasesTable = `${prefix}_leases`
  }
  migrate(): void {
    this.client.exec(
      "CREATE TABLE IF NOT EXISTS " +
        this.recordsTable +
        " (kind TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind,id));" +
        "CREATE INDEX IF NOT EXISTS " +
        this.recordsTable +
        "_reconcile ON " +
        this.recordsTable +
        " (kind,state,updated_at,id);" +
        "CREATE TABLE IF NOT EXISTS " +
        this.leasesTable +
        " (name TEXT PRIMARY KEY, owner TEXT, token TEXT, expires_at INTEGER NOT NULL DEFAULT 0, cursor TEXT);",
    )
  }
  async create(
    kind: DurableRecordKind,
    id: string,
    record: { readonly version: number; readonly state?: string; readonly updatedAt?: number },
  ): Promise<boolean> {
    const result = this.client
      .query(
        "INSERT OR IGNORE INTO " +
          this.recordsTable +
          " (kind,id,state,updated_at,version,payload) VALUES (?,?,?,?,?,?)",
      )
      .run(
        kind,
        id,
        record.state ?? "",
        record.updatedAt ?? 0,
        record.version,
        serializeRecord(record),
      )
    return result.changes === 1
  }
  async get<T extends { readonly version: number }>(
    kind: DurableRecordKind,
    id: string,
  ): Promise<T | undefined> {
    const row = this.client
      .query(`SELECT payload FROM ${this.recordsTable} WHERE kind=? AND id=?`)
      .get(kind, id)
    return recordFromRow<T>(row ?? undefined)
  }
  async compareAndSet(
    kind: DurableRecordKind,
    id: string,
    expectedVersion: number,
    record: { readonly version: number; readonly state?: string; readonly updatedAt?: number },
  ): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    const result = this.client
      .query(
        "UPDATE " +
          this.recordsTable +
          " SET state=?,updated_at=?,version=?,payload=? WHERE kind=? AND id=? AND version=?",
      )
      .run(
        record.state ?? "",
        record.updatedAt ?? 0,
        record.version,
        serializeRecord(record),
        kind,
        id,
        expectedVersion,
      )
    return result.changes === 1
  }
  async scan<T extends { readonly state: string; readonly updatedAt: number }>(
    kind: DurableRecordKind,
    input: ReconciliationScanOptions<string>,
  ): Promise<ReconciliationScanPage<T>> {
    if (input.states.length === 0) return { records: [] }
    const placeholders = input.states.map(() => "?").join(",")
    const rows = this.client
      .query(
        "SELECT id,payload FROM " +
          this.recordsTable +
          " WHERE kind=? AND state IN (" +
          placeholders +
          ") AND (? IS NULL OR updated_at <= ?) AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?",
      )
      .all(
        kind,
        ...input.states,
        input.updatedBefore ?? null,
        input.updatedBefore ?? null,
        input.cursor ?? null,
        input.cursor ?? null,
        input.limit + 1,
      )
    const present = rows.filter((row): row is Record<string, unknown> => row !== undefined)
    const hasMore = present.length > input.limit
    const page = present.slice(0, input.limit)
    return Object.freeze({
      records: Object.freeze(page.map((row) => recordFromRow<T>(row) as T)),
      ...(hasMore ? { cursor: String(page.at(-1)?.id) } : {}),
    })
  }
  async acquireLease(
    input: Parameters<DurableRecordBackend["acquireLease"]>[0],
  ): Promise<ReconciliationLease | undefined> {
    const token = crypto.randomUUID()
    const expiresAt = input.now + input.leaseMs
    const row = this.client
      .query(
        "INSERT INTO " +
          this.leasesTable +
          " (name,owner,token,expires_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,token=excluded.token,expires_at=excluded.expires_at WHERE " +
          this.leasesTable +
          ".expires_at <= ? RETURNING name,owner,token,expires_at,cursor",
      )
      .get(input.name, input.owner, token, expiresAt, input.now)
    if (row === undefined || row === null) return undefined
    return Object.freeze({
      name: String(row.name),
      owner: String(row.owner),
      token: String(row.token),
      expiresAt: Number(row.expires_at),
      ...(row.cursor === null || row.cursor === undefined ? {} : { cursor: String(row.cursor) }),
    })
  }
  async renewLease(input: Parameters<DurableRecordBackend["renewLease"]>[0]): Promise<boolean> {
    return (
      this.client
        .query(
          `UPDATE ${this.leasesTable} SET expires_at=? WHERE name=? AND owner=? AND token=? AND expires_at>?`,
        )
        .run(input.now + input.leaseMs, input.name, input.owner, input.token, input.now).changes ===
      1
    )
  }
  async checkpointLease(
    input: Parameters<DurableRecordBackend["checkpointLease"]>[0],
  ): Promise<boolean> {
    return (
      this.client
        .query(`UPDATE ${this.leasesTable} SET cursor=? WHERE name=? AND owner=? AND token=?`)
        .run(input.cursor ?? null, input.name, input.owner, input.token).changes === 1
    )
  }
  async releaseLease(input: Parameters<DurableRecordBackend["releaseLease"]>[0]): Promise<boolean> {
    return (
      this.client
        .query(
          "UPDATE " +
            this.leasesTable +
            " SET owner=NULL,token=NULL,expires_at=0 WHERE name=? AND owner=? AND token=?",
        )
        .run(input.name, input.owner, input.token).changes === 1
    )
  }
}

export class SQLiteDurableExecutionAdapter implements DurableExecutionAdapter {
  readonly effects: DurableEffectStore
  readonly approvals: ApprovalStore
  readonly sagas: SagaStore
  readonly leases: ReconciliationLeaseStore
  readonly backend: SQLiteDurableRecordBackend
  constructor(client: SQLiteClient, options: { readonly tablePrefix?: string } = {}) {
    this.backend = new SQLiteDurableRecordBackend(client, options)
    const views = createDurableExecutionAdapter(this.backend)
    this.effects = views.effects
    this.approvals = views.approvals
    this.sagas = views.sagas
    this.leases = views.leases
  }
  migrate(): void {
    this.backend.migrate()
  }
}

// -------------------------------------------------------------------------------------------------
// Cloudflare Durable Object storage

export interface DurableObjectStorageTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
  list<T = unknown>(options?: {
    readonly prefix?: string
    readonly startAfter?: string
    readonly limit?: number
  }): Promise<Map<string, T>>
}
export interface DurableObjectStorage extends DurableObjectStorageTransaction {
  transaction<T>(closure: (transaction: DurableObjectStorageTransaction) => Promise<T>): Promise<T>
}

interface DurableObjectLeaseValue {
  owner?: string
  token?: string
  expiresAt: number
  cursor?: string
}

export class DurableObjectRecordBackend implements DurableRecordBackend {
  constructor(private readonly storage: DurableObjectStorage) {}
  private recordKey(kind: DurableRecordKind, id: string): string {
    return `record:${kind}:${encodeURIComponent(id)}`
  }
  private leaseKey(name: string): string {
    return `lease:${encodeURIComponent(name)}`
  }
  async create(
    kind: DurableRecordKind,
    id: string,
    record: {
      readonly version: number
      readonly state?: string
      readonly updatedAt?: number
    },
  ): Promise<boolean> {
    return await this.storage.transaction(async (txn) => {
      const key = this.recordKey(kind, id)
      if ((await txn.get(key)) !== undefined) return false
      await txn.put(key, clone(record))
      return true
    })
  }
  async get<T extends { readonly version: number }>(
    kind: DurableRecordKind,
    id: string,
  ): Promise<T | undefined> {
    const value = await this.storage.get<T>(this.recordKey(kind, id))
    return value === undefined ? undefined : clone(value)
  }
  async compareAndSet(
    kind: DurableRecordKind,
    id: string,
    expectedVersion: number,
    record: {
      readonly version: number
      readonly state?: string
      readonly updatedAt?: number
    },
  ): Promise<boolean> {
    if (record.version !== expectedVersion + 1) return false
    return await this.storage.transaction(async (txn) => {
      const key = this.recordKey(kind, id)
      const current = await txn.get<{ readonly version: number }>(key)
      if (current?.version !== expectedVersion) return false
      await txn.put(key, clone(record))
      return true
    })
  }
  async scan<T extends { readonly state: string; readonly updatedAt: number }>(
    kind: DurableRecordKind,
    input: ReconciliationScanOptions<string>,
  ): Promise<ReconciliationScanPage<T>> {
    const prefix = `record:${kind}:`
    const listed = await this.storage.list<T>({
      prefix,
      ...(input.cursor === undefined
        ? {}
        : { startAfter: prefix + encodeURIComponent(input.cursor) }),
      limit: input.limit + 1,
    })
    const selected: Array<{ id: string; record: T }> = []
    let lastVisited: string | undefined
    for (const [key, record] of listed) {
      lastVisited = decodeURIComponent(key.slice(prefix.length))
      if (
        input.states.includes(record.state) &&
        (input.updatedBefore === undefined || record.updatedAt <= input.updatedBefore)
      ) {
        selected.push({ id: lastVisited, record })
      }
      if (selected.length > input.limit) break
    }
    const hasMore = selected.length > input.limit || listed.size > input.limit
    const page = selected.slice(0, input.limit)
    return Object.freeze({
      records: Object.freeze(page.map(({ record }) => clone(record))),
      ...(hasMore && lastVisited !== undefined ? { cursor: lastVisited } : {}),
    })
  }
  async acquireLease(
    input: Parameters<DurableRecordBackend["acquireLease"]>[0],
  ): Promise<ReconciliationLease | undefined> {
    return await this.storage.transaction(async (txn) => {
      const key = this.leaseKey(input.name)
      const current = await txn.get<DurableObjectLeaseValue>(key)
      if (current?.owner !== undefined && current.expiresAt > input.now) return undefined
      const token = crypto.randomUUID()
      const next: DurableObjectLeaseValue = {
        owner: input.owner,
        token,
        expiresAt: input.now + input.leaseMs,
        ...(current?.cursor === undefined ? {} : { cursor: current.cursor }),
      }
      await txn.put(key, next)
      return Object.freeze({
        name: input.name,
        owner: input.owner,
        token,
        expiresAt: next.expiresAt,
        ...(next.cursor === undefined ? {} : { cursor: next.cursor }),
      })
    })
  }
  async renewLease(input: Parameters<DurableRecordBackend["renewLease"]>[0]): Promise<boolean> {
    return await this.storage.transaction(async (txn) => {
      const key = this.leaseKey(input.name)
      const current = await txn.get<DurableObjectLeaseValue>(key)
      if (
        current?.owner !== input.owner ||
        !safeEqual(current.token, input.token) ||
        current.expiresAt <= input.now
      )
        return false
      await txn.put(key, { ...current, expiresAt: input.now + input.leaseMs })
      return true
    })
  }
  async checkpointLease(
    input: Parameters<DurableRecordBackend["checkpointLease"]>[0],
  ): Promise<boolean> {
    return await this.storage.transaction(async (txn) => {
      const key = this.leaseKey(input.name)
      const current = await txn.get<DurableObjectLeaseValue>(key)
      if (current?.owner !== input.owner || !safeEqual(current.token, input.token)) return false
      const next = { ...current }
      if (input.cursor === undefined) delete next.cursor
      else next.cursor = input.cursor
      await txn.put(key, next)
      return true
    })
  }
  async releaseLease(input: Parameters<DurableRecordBackend["releaseLease"]>[0]): Promise<boolean> {
    return await this.storage.transaction(async (txn) => {
      const key = this.leaseKey(input.name)
      const current = await txn.get<DurableObjectLeaseValue>(key)
      if (current?.owner !== input.owner || !safeEqual(current.token, input.token)) return false
      const next = { ...current, expiresAt: 0 }
      delete next.owner
      delete next.token
      await txn.put(key, next)
      return true
    })
  }
}

export class DurableObjectExecutionAdapter implements DurableExecutionAdapter {
  readonly effects: DurableEffectStore
  readonly approvals: ApprovalStore
  readonly sagas: SagaStore
  readonly leases: ReconciliationLeaseStore
  readonly backend: DurableObjectRecordBackend
  constructor(storage: DurableObjectStorage) {
    this.backend = new DurableObjectRecordBackend(storage)
    const views = createDurableExecutionAdapter(this.backend)
    this.effects = views.effects
    this.approvals = views.approvals
    this.sagas = views.sagas
    this.leases = views.leases
  }
}
