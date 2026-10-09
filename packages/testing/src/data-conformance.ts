/**
 * Behavioral conformance checks for durable data adapters.
 *
 * The framework does not own a SQL dialect or a tenant model. This harness therefore accepts a
 * small adapter-specific operation map and verifies the guarantees that are portable across
 * Postgres, SQLite, D1, Durable Objects, and other implementations.
 */

export interface DataConformanceScope {
  readonly token: string
}

export interface DataConformancePage<Row, Cursor = string> {
  readonly items: readonly Row[]
  readonly cursor?: Cursor
}

export interface DataConformanceTransaction<Row> {
  write(row: Row): Promise<void>
}

export interface DataAdapterConformanceTarget<Adapter, Row, Snapshot, Cursor = string> {
  /** Return a fresh adapter handle. Two handles must observe shared durable state. */
  readonly createAdapter: (instance: string) => Adapter | Promise<Adapter>
  /** Insert a fixture row under the adapter's tenant/RLS boundary. */
  readonly seed: (adapter: Adapter, scope: DataConformanceScope, row: Row) => Promise<void>
  /** Read rows visible to one scope. */
  readonly read: (adapter: Adapter, scope: DataConformanceScope) => Promise<readonly Row[]>
  /** Perform one cancellable write. */
  readonly write: (
    adapter: Adapter,
    scope: DataConformanceScope,
    row: Row,
    signal: AbortSignal,
  ) => Promise<void>
  /** Execute writes atomically; a rejected callback must roll back all writes. */
  readonly transaction: <T>(
    adapter: Adapter,
    scope: DataConformanceScope,
    run: (transaction: DataConformanceTransaction<Row>) => Promise<T>,
  ) => Promise<T>
  /** Return one cursor page. The cursor is adapter-owned and must be treated as opaque. */
  readonly page: (
    adapter: Adapter,
    scope: DataConformanceScope,
    cursor?: Cursor,
  ) => Promise<DataConformancePage<Row, Cursor>>
  /** Capture and restore a durable snapshot for backup/restore testing. */
  readonly snapshot: (adapter: Adapter) => Promise<Snapshot>
  readonly restore: (adapter: Adapter, snapshot: Snapshot) => Promise<void>
  /** Stable row identity used to detect cross-tenant leaks and pagination duplicates. */
  readonly rowKey: (row: Row) => string
  /** Optional cleanup for an adapter handle. */
  readonly close?: (adapter: Adapter) => Promise<void>
}

export type DataConformanceCheck =
  | "rls-isolation"
  | "transaction-rollback"
  | "cancellation"
  | "pagination"
  | "backup-restore"
  | "multi-instance"

export interface DataConformanceFailure {
  readonly check: DataConformanceCheck
  readonly message: string
}

export interface DataAdapterConformanceReport {
  readonly ok: boolean
  readonly checks: Readonly<Record<DataConformanceCheck, "pass" | "fail">>
  readonly failures: readonly DataConformanceFailure[]
}

export class DataAdapterConformanceError extends Error {
  readonly report: DataAdapterConformanceReport

  constructor(report: DataAdapterConformanceReport) {
    super(
      `data adapter conformance failed: ${report.failures
        .map((failure) => `${failure.check}: ${failure.message}`)
        .join("; ")}`,
    )
    this.name = "DataAdapterConformanceError"
    this.report = report
  }
}

const CHECKS: readonly DataConformanceCheck[] = [
  "rls-isolation",
  "transaction-rollback",
  "cancellation",
  "pagination",
  "backup-restore",
  "multi-instance",
]

const defaultScopes = Object.freeze({
  left: Object.freeze({ token: "nifra-conformance/tenant-left" }),
  right: Object.freeze({ token: "nifra-conformance/tenant-right" }),
})

const defaultRows = Object.freeze({
  left: Object.freeze({ id: "left" }),
  right: Object.freeze({ id: "right" }),
  rollback: Object.freeze({ id: "rollback" }),
  shared: Object.freeze({ id: "shared" }),
})

function isAbortLike(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`))
  )
}

async function closeAll<Adapter>(
  target: DataAdapterConformanceTarget<Adapter, unknown, unknown, unknown>,
  adapters: readonly Adapter[],
): Promise<void> {
  if (target.close === undefined) return
  await Promise.all(adapters.map((adapter) => target.close!(adapter)))
}

/**
 * Run the portable data-adapter contract and return machine-readable evidence.
 *
 * The harness intentionally uses fresh handles and opaque scope tokens. It does not inspect SQL,
 * tenant columns, transaction objects, provider errors, or credentials.
 */
export async function runDataAdapterConformance<Adapter, Row, Snapshot, Cursor = string>(
  target: DataAdapterConformanceTarget<Adapter, Row, Snapshot, Cursor>,
  options: {
    readonly scopes?: { readonly left: DataConformanceScope; readonly right: DataConformanceScope }
    readonly rows?: {
      readonly left: Row
      readonly right: Row
      readonly rollback: Row
      readonly shared: Row
    }
  } = {},
): Promise<DataAdapterConformanceReport> {
  const scopes = options.scopes ?? defaultScopes
  const rows =
    options.rows ??
    (defaultRows as unknown as {
      readonly left: Row
      readonly right: Row
      readonly rollback: Row
      readonly shared: Row
    })
  const adapters: Adapter[] = []
  const failures: DataConformanceFailure[] = []
  const checks: Record<DataConformanceCheck, "pass" | "fail"> = {
    "rls-isolation": "fail",
    "transaction-rollback": "fail",
    cancellation: "fail",
    pagination: "fail",
    "backup-restore": "fail",
    "multi-instance": "fail",
  }

  const run = async (check: DataConformanceCheck, action: () => Promise<void>): Promise<void> => {
    try {
      await action()
      checks[check] = "pass"
    } catch {
      failures.push({
        check,
        // Provider errors can contain credentials, SQL, tenant identifiers, or request values.
        // The portable report is safe to serialize and log, so retain only the stable check name.
        message: `${check} conformance check failed`,
      })
    }
  }

  try {
    const primary = await target.createAdapter("primary")
    const secondary = await target.createAdapter("secondary")
    adapters.push(primary, secondary)

    await run("rls-isolation", async () => {
      await target.seed(primary, scopes.left, rows.left)
      await target.seed(primary, scopes.right, rows.right)
      const left = await target.read(primary, scopes.left)
      const right = await target.read(primary, scopes.right)
      const leftKeys = new Set(left.map(target.rowKey))
      const rightKeys = new Set(right.map(target.rowKey))
      if (!leftKeys.has(target.rowKey(rows.left)) || leftKeys.has(target.rowKey(rows.right))) {
        throw new Error("left scope can read another scope's row")
      }
      if (!rightKeys.has(target.rowKey(rows.right)) || rightKeys.has(target.rowKey(rows.left))) {
        throw new Error("right scope can read another scope's row")
      }
    })

    await run("transaction-rollback", async () => {
      const before = new Set((await target.read(primary, scopes.left)).map(target.rowKey))
      let rejectedCallback = false
      try {
        await target.transaction(primary, scopes.left, async (transaction) => {
          await transaction.write(rows.rollback)
          throw new Error("conformance rollback")
        })
      } catch {
        rejectedCallback = true
      }
      if (!rejectedCallback) throw new Error("transaction accepted a rejected callback")
      const after = new Set((await target.read(primary, scopes.left)).map(target.rowKey))
      if (after.has(target.rowKey(rows.rollback)) || [...after].some((key) => !before.has(key))) {
        throw new Error("rejected transaction changed durable state")
      }
    })

    const keysIn = async (scope: DataConformanceScope): Promise<ReadonlySet<string>> =>
      new Set((await target.read(primary, scope)).map(target.rowKey))
    const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
      a.size === b.size && [...a].every((key) => b.has(key))

    await run("cancellation", async () => {
      const controller = new AbortController()
      controller.abort()
      let refused = false
      try {
        await target.write(primary, scopes.left, rows.rollback, controller.signal)
      } catch (error) {
        // Any other failure (a refused connection, a rejected row) proves nothing about the signal.
        if (!isAbortLike(error) && error !== controller.signal.reason) throw error
        refused = true
      }
      if (!refused) throw new Error("cancelled write resolved successfully")
      if ((await keysIn(scopes.left)).has(target.rowKey(rows.rollback)))
        throw new Error("cancelled write reached durable state")
    })

    await run("pagination", async () => {
      const expected = await keysIn(scopes.left)
      const seen: string[] = []
      const cursors = new Set<string>()
      let cursor: Cursor | undefined
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await target.page(primary, scopes.left, cursor)
        seen.push(...page.items.map(target.rowKey))
        if (page.cursor === undefined) break
        const next = String(page.cursor)
        if (cursors.has(next)) throw new Error("pagination cursor repeated")
        cursors.add(next)
        cursor = page.cursor
        if (pageNumber === 99) throw new Error("pagination did not terminate")
      }
      if (new Set(seen).size !== seen.length) throw new Error("pagination returned a duplicate row")
      if (!sameKeys(new Set(seen), expected))
        throw new Error("pagination did not return exactly the scope's rows")
    })

    await run("backup-restore", async () => {
      const left = await keysIn(scopes.left)
      const right = await keysIn(scopes.right)
      const snapshot = await target.snapshot(primary)
      await target.seed(primary, scopes.left, rows.rollback)
      await target.restore(primary, snapshot)
      // Restore returns every scope to the snapshot: no later row, and no row the snapshot held lost.
      if (
        !sameKeys(await keysIn(scopes.left), left) ||
        !sameKeys(await keysIn(scopes.right), right)
      )
        throw new Error("restore did not return the snapshot's rows")
    })

    await run("multi-instance", async () => {
      await target.seed(primary, scopes.left, rows.shared)
      const visible = new Set((await target.read(secondary, scopes.left)).map(target.rowKey))
      if (!visible.has(target.rowKey(rows.shared))) {
        throw new Error("a second adapter instance cannot observe committed durable state")
      }
    })
  } catch {
    failures.push({
      check: "multi-instance",
      message: "multi-instance conformance check failed",
    })
  } finally {
    try {
      await closeAll(
        target as unknown as DataAdapterConformanceTarget<Adapter, unknown, unknown, unknown>,
        adapters,
      )
    } catch {
      failures.push({ check: "multi-instance", message: "adapter cleanup failed" })
    }
  }

  const failed = new Set(failures.map((failure) => failure.check))
  for (const check of CHECKS) {
    if (failed.has(check)) checks[check] = "fail"
  }
  return Object.freeze({
    ok: failures.length === 0,
    checks: Object.freeze({ ...checks }),
    failures: Object.freeze([...failures]),
  })
}

export async function assertDataAdapterConformance<Adapter, Row, Snapshot, Cursor = string>(
  target: DataAdapterConformanceTarget<Adapter, Row, Snapshot, Cursor>,
  options: Parameters<typeof runDataAdapterConformance<Adapter, Row, Snapshot, Cursor>>[1] = {},
): Promise<void> {
  const report = await runDataAdapterConformance(target, options)
  if (!report.ok) throw new DataAdapterConformanceError(report)
}
