/**
 * The execution lanes `run_query` uses: a reusable read-only worker for a file-backed database, and an
 * in-process lane for one that cannot be reopened. Not part of the public engine - the CLI's database
 * tool runs each query in its own subprocess instead, which bounds the work by killing the process.
 */

import type { SqliteDatabaseLike } from "./shared.ts"

export class QueryTimeoutError extends Error {
  constructor() {
    super("query exceeded the time limit")
    this.name = "QueryTimeoutError"
  }
}

/** One execution lane for `run_query`: `run` resolves rows, or rejects once the deadline passes. */
export interface QuerySession {
  run(sql: string, deadline: number): Promise<unknown[]>
  close(): Promise<void>
}

/**
 * The isolated lane. The worker reopens the SAME database FILE read-only and answers one statement
 * at a time; it is spawned once and reused for the life of the server. It deliberately does not
 * take a `serialize()` snapshot - that copies the whole database into memory on EVERY call, which
 * is a larger availability problem than the slow query the deadline exists to bound.
 */
const SQLITE_WORKER_SOURCE = `
const { Database } = require("bun:sqlite")
let db
self.onmessage = (event) => {
  const { id, filename, sql, type } = event.data
  if (type === "close") {
    let response
    try {
      // prepare().all() leaves a statement alive until it is finalized or collected. Bun's
      // default close(false) preserves those statements and can keep the database file locked;
      // close(true) finalizes every outstanding statement before the worker exits.
      db?.close(true)
      db = undefined
      response = { id, closed: true, ok: true }
    } catch (error) {
      response = { id, closed: true, ok: false, error: String(error) }
    }
    // A forced parent-side terminate can leave native SQLite handles locked on Windows even after
    // close() returns. Let the worker exit its own event turn so the runtime can finish releasing
    // those handles before the parent considers graceful cleanup complete.
    self.postMessage(response)
    self.close()
    return
  }
  try {
    if (db === undefined) {
      db = new Database(filename, { readonly: true })
      db.run("PRAGMA query_only = ON")
    }
    self.postMessage({ id, ok: true, rows: db.prepare(sql).all() })
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error) })
  }
}
`

function isWorkerAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined"
}

/** Only a file-backed database can be reopened in a worker. `:memory:` and the anonymous temp
 * database live in this process alone, so they take the in-process lane instead. */
function reopenableFilename(db: SqliteDatabaseLike): string | undefined {
  const filename = db.filename
  if (typeof filename !== "string" || filename === "" || filename === ":memory:") return undefined
  return filename.startsWith("file::memory:") ? undefined : filename
}

interface PendingQuery {
  readonly deadline: number
  resolve(rows: unknown[]): void
  reject(error: Error): void
}

interface PendingClose {
  readonly id: number
  resolve(graceful?: boolean): void
}

const WORKER_CLOSE_TIMEOUT_MS = 1_000

function workerSession(filename: string): QuerySession {
  let worker: Worker | undefined
  let sourceUrl: string | undefined
  let nextId = 0
  const pending = new Map<number, PendingQuery>()
  let lane: Promise<unknown> = Promise.resolve()
  let closed = false
  let closePromise: Promise<void> | undefined
  let pendingClose: PendingClose | undefined

  const detachWorker = (active: Worker | undefined = worker): void => {
    if (active === undefined) return
    if (worker !== active) return
    worker = undefined
    if (sourceUrl !== undefined) URL.revokeObjectURL(sourceUrl)
    sourceUrl = undefined
  }

  const releaseWorker = (active: Worker | undefined = worker): void => {
    if (active === undefined) return
    active.terminate()
    detachWorker(active)
  }

  const rejectPending = (error: Error): void => {
    const waiters = [...pending.values()]
    pending.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  /** Drop the worker and fail everything riding on it. The only bound this side can enforce over a
   * statement already running inside native SQLite is to stop owning the connection it runs on. */
  const discard = (error: Error): void => {
    const closing = pendingClose
    pendingClose = undefined
    releaseWorker()
    rejectPending(error)
    closing?.resolve()
  }

  const ensureWorker = (): Worker => {
    if (worker !== undefined) return worker
    sourceUrl = URL.createObjectURL(new Blob([SQLITE_WORKER_SOURCE], { type: "text/javascript" }))
    const spawned = new Worker(sourceUrl)
    spawned.onmessage = (
      event: MessageEvent<{
        id?: number
        ok?: boolean
        rows?: unknown[]
        error?: string
        closed?: boolean
      }>,
    ) => {
      const { id, ok, rows, error } = event.data
      if (typeof id !== "number") return
      if (event.data.closed === true) {
        const closing = pendingClose
        if (closing?.id !== id) return
        pendingClose = undefined
        closing.resolve(event.data.ok === true)
        return
      }
      const waiter = pending.get(id)
      if (waiter === undefined) return
      if (Date.now() >= waiter.deadline) {
        discard(new QueryTimeoutError())
        return
      }
      pending.delete(id)
      if (ok === true) waiter.resolve(rows ?? [])
      else waiter.reject(new Error(error ?? "query failed in worker"))
    }
    spawned.onerror = () => discard(new Error("query failed in worker"))
    // An in-flight query holds its own deadline timer on the loop, so an IDLE worker must not be
    // what keeps the process alive.
    ;(spawned as { unref?: () => void }).unref?.()
    worker = spawned
    return spawned
  }

  const dispatch = (sql: string, deadline: number): Promise<unknown[]> => {
    if (closed) return Promise.reject(new Error("query session is closed"))
    const active = ensureWorker()
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      discard(new QueryTimeoutError())
      return Promise.reject(new QueryTimeoutError())
    }
    const id = ++nextId
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => discard(new QueryTimeoutError()), remaining)
      pending.set(id, {
        deadline,
        resolve: (rows) => {
          clearTimeout(timer)
          resolve(rows)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        active.postMessage({ id, filename, sql })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    run(sql, deadline) {
      // One worker owns the connection, so overlapping calls queue behind each other rather than
      // interleaving statements on it.
      const result = lane.then(() => dispatch(sql, deadline))
      lane = result.catch(() => undefined)
      return result
    },
    close() {
      if (closePromise !== undefined) return closePromise
      closed = true
      closePromise = (async () => {
        const active = worker
        if (active !== undefined) {
          await new Promise<void>((resolve) => {
            const id = ++nextId
            let settled = false
            const finish = (error?: Error, graceful = false): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              if (pendingClose?.id === id) pendingClose = undefined
              if (error !== undefined) rejectPending(error)
              if (graceful) detachWorker(active)
              else releaseWorker(active)
              resolve()
            }
            const timer = setTimeout(() => {
              finish(new Error("query session is closed"))
            }, WORKER_CLOSE_TIMEOUT_MS)
            pendingClose = { id, resolve: (graceful) => finish(undefined, graceful) }
            try {
              active.postMessage({ id, type: "close" })
            } catch {
              finish(new Error("query session is closed"))
            }
          })
        }
        await lane
      })()
      return closePromise
    },
  }
}

/**
 * The in-process lane, used when the database cannot be reopened elsewhere. The deadline is checked
 * around the statement and nothing more: `prepare().all()` is synchronous, so it holds the only
 * thread there is and no timer of ours can fire while it runs. That makes this lane BEST EFFORT -
 * it reports an overrun, it does not cut one short.
 */
function inProcessSession(db: SqliteDatabaseLike): QuerySession {
  return {
    async run(sql, deadline) {
      if (Date.now() >= deadline) throw new QueryTimeoutError()
      const rows = db.prepare(sql).all()
      if (Date.now() > deadline) throw new QueryTimeoutError()
      return rows
    },
    async close() {},
  }
}

/**
 * Pick the lane once, at construction. A file-backed database is isolated in a reusable read-only
 * worker, which is the only arrangement that can actually stop a running statement. Anything else
 * runs in process - every database keeps working, none is refused.
 */
export function openQuerySession(db: SqliteDatabaseLike): QuerySession {
  const filename = reopenableFilename(db)
  if (filename !== undefined && isWorkerAvailable()) return workerSession(filename)
  return inProcessSession(db)
}
