/**
 * `@nifrajs/mcp-db` - serve a SQLite database as an MCP server, fail-closed.
 *
 * Out of the box only SCHEMA tools are exposed (`list_tables`, `describe_table`), and only for
 * tables on the explicit `tables` allowlist. Query execution is OPT-IN and requires BOTH the
 * allowlist and an `authorize` hook - a database is PII by default, and an MCP client is an LLM;
 * this package refuses to be mounted open rather than defaulting open.
 *
 * Read-only is enforced in layers, not promised: `PRAGMA query_only = ON` on the connection
 * (SQLite rejects every write at the engine), a single-statement gate, a SELECT/WITH-only gate,
 * and `EXPLAIN QUERY PLAN` verification that a query touches ONLY allowlisted tables. Results are
 * capped by rows and bytes (an LLM does not need 100k rows; a transport does not want them) with
 * an explicit `truncated` marker.
 *
 * Bun/Node SQLite only (anything `bun:sqlite`-shaped, bound structurally - no driver dependency).
 * There is deliberately NO D1 mode: D1 has no `query_only`, so read-only cannot be guaranteed.
 *
 *   import { Database } from "bun:sqlite"
 *   const mcp = serveDatabaseAsMcp(new Database("app.db"), {
 *     tables: ["habits", "entries"],
 *     runQuery: { authorize: (ctx) => ctx.request?.headers.get("x-api-key") === env.MCP_KEY },
 *   })
 *   app.mount("/mcp", mcp.fetch)
 */

import { createMcpServer, defineMcpTool, type JsonRpcResponse, type McpServer } from "@nifrajs/mcp"

/** The structural slice of `bun:sqlite`'s `Database` this package needs. */
export interface SqliteDatabaseLike {
  /** Prepare a statement; `all` runs it and returns row objects. */
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  /** Execute a statement for its side effect (used only for `PRAGMA query_only`). */
  run(sql: string): unknown
  /** Optional path this database was opened from; a file-backed one can be reopened read-only in a
   * worker so `run_query` runs off the serving connection. `:memory:` and the empty anonymous
   * database cannot, and run in process. */
  readonly filename?: string
}

/** Context forwarded to `authorize` - the inbound HTTP Request carrying the `run_query` call. */
export interface McpDbAuthorizeContext {
  readonly toolName: "run_query"
  readonly request: Request
}

export interface RunQueryOptions {
  /**
   * REQUIRED. Authorize each `run_query` call at the transport boundary (inspect the inbound
   * Request's auth). Return false to reject with a JSON-RPC error. There is no unauthenticated
   * mode - schema tools are the anonymous surface. Note: `run_query` is therefore HTTP-only;
   * direct `handle()` dispatch rejects it (no Request to authorize - fails closed).
   */
  readonly authorize: (context: McpDbAuthorizeContext) => boolean | Promise<boolean>
  /** Max rows returned per query (default 100). */
  readonly maxRows?: number
  /** Max serialized result size in bytes (default 100 KB). */
  readonly maxResultBytes?: number
  /**
   * Maximum wall-clock time for planning, execution, and optional counting (default 5 seconds).
   * The deadline always bounds the RESPONSE. Whether it also stops the WORK depends on where the
   * query runs: a file-backed database runs it in a reusable read-only worker that is terminated
   * on expiry, while an in-memory database (or a shim with no `filename`) runs it on this thread,
   * where a synchronous statement cannot be preempted and the overrun is only reported after it
   * returns.
   */
  readonly queryTimeoutMs?: number
  /** Return an exact total after row truncation. Off by default because it re-executes the query. */
  readonly exactTotal?: boolean
  /** Maximum simultaneous run_query calls on this database connection (default 1). */
  readonly maxConcurrentQueries?: number
}

export interface ServeDatabaseAsMcpOptions {
  /**
   * REQUIRED allowlist of tables the MCP surface may see. `list_tables`/`describe_table` are
   * restricted to it and `run_query` plans are verified against it. Empty array → construction
   * throws; expose nothing by accident, ever.
   */
  readonly tables: readonly string[]
  /** Enable the `run_query` tool. Omitted → schema tools only. */
  readonly runQuery?: RunQueryOptions
  /** MCP server identity (defaults: name `nifra-db`, version `1.0.0`). */
  readonly name?: string
  readonly version?: string
  /**
   * Set `PRAGMA query_only = ON` on the connection at construction (default true). Disable ONLY
   * when the same connection must also serve writes elsewhere in the app - with it disabled,
   * `run_query` still gates on SELECT/WITH + plan verification, but the engine-level guarantee is
   * yours to provide (e.g. open a second, read-only connection for the MCP mount - preferred).
   */
  readonly enforceQueryOnly?: boolean
}

export class McpDbConfigError extends Error {
  constructor(message: string) {
    super(`@nifrajs/mcp-db: ${message}`)
    this.name = "McpDbConfigError"
  }
}

/** A safe SQL identifier - quoting is not enough for PRAGMA args, so reject instead. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Build SQL containing identifiers only after validating every substitution at this boundary. */
function sqlIdentifiers(strings: TemplateStringsArray, ...identifiers: readonly string[]): string {
  let sql = strings[0] ?? ""
  for (const [index, identifier] of identifiers.entries()) {
    if (!SAFE_IDENTIFIER.test(identifier)) {
      throw new McpDbConfigError(`unsafe SQL identifier ${JSON.stringify(identifier)}`)
    }
    sql += identifier + (strings[index + 1] ?? "")
  }
  return sql
}

const stripSqlNoise = (sql: string): string =>
  sql
    // Strings first so comment markers inside literals don't count.
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")

// SQLite's bare-identifier alphabet. Non-ASCII is included because SQLite treats any byte >= 0x80 as
// an identifier character; leaving it out would end a word early and split one table name into two.
const WORD_START = /[A-Za-z_\u0080-\uffff]/
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/

/** One lexical unit of SQL. `bare` distinguishes a keyword-capable word from a quoted identifier, so
 * `FROM "from"` reads the second token as a table name and not as another clause. */
interface SqlToken {
  readonly kind: "word" | "punct"
  /** Identifier text with quoting removed and escapes collapsed; the raw character for punctuation. */
  readonly value: string
  /** True for an unquoted word - only these can be SQL keywords. */
  readonly bare: boolean
}

/**
 * Tokenize far enough to name every relation. A regex cannot do this job: SQLite needs no separator
 * between a keyword and a quoted identifier (`FROM"users"` is legal), and it accepts four identifier
 * quotings - `"x"`, `[x]`, `` `x` ``, and bare. A `\s+`-anchored pattern silently reads none of
 * those as a table reference, which is exactly how an aliased `FROM"users"AS habits` slipped past
 * the allowlist and returned a non-exposed table's rows.
 *
 * String literals and comments become nothing, so a `FROM` inside attacker-controlled text is inert.
 */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let i = 0
  /** Read a quoted identifier, collapsing the doubled-delimiter escape SQLite uses for `"` and `` ` ``. */
  const readQuoted = (close: string, escapable: boolean): void => {
    let value = ""
    i++ // past the opening delimiter
    while (i < sql.length) {
      if (sql[i] === close) {
        if (escapable && sql[i + 1] === close) {
          value += close
          i += 2
          continue
        }
        i++
        tokens.push({ kind: "word", value, bare: false })
        return
      }
      value += sql[i]
      i++
    }
    // Unterminated - emit what we have. The caller's single-statement and plan checks still run.
    tokens.push({ kind: "word", value, bare: false })
  }
  while (i < sql.length) {
    const char = sql[i] as string
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f") {
      i++
    } else if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i)
      i = end === -1 ? sql.length : end + 1
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (char === "'") {
      // Literal: consumed and dropped, so its contents can never be read as SQL.
      i++
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
    } else if (char === '"') {
      readQuoted('"', true)
    } else if (char === "`") {
      readQuoted("`", true)
    } else if (char === "[") {
      readQuoted("]", false) // MSSQL-style bracket quoting: no escape form
    } else if (WORD_START.test(char)) {
      const start = i
      while (i < sql.length && WORD_PART.test(sql[i] as string)) i++
      tokens.push({ kind: "word", value: sql.slice(start, i), bare: true })
    } else if (char >= "0" && char <= "9") {
      while (i < sql.length && /[0-9A-Za-z._]/.test(sql[i] as string)) i++
    } else {
      tokens.push({ kind: "punct", value: char, bare: false })
      i++
    }
  }
  return tokens
}

/** True when `token` is the unquoted keyword `word` (case-insensitive). */
const isKeyword = (token: SqlToken | undefined, word: string): boolean =>
  token?.bare === true && token.value.toLowerCase() === word

/**
 * Every relation the statement names after `FROM`/`JOIN`, lowercased, with CTE names excluded.
 * A schema qualifier resolves to its table (`main.habits` -> `habits`); a subquery contributes
 * nothing of its own because its inner `FROM` is tokenized alongside everything else.
 */
function relationNames(sql: string): string[] {
  const tokens = tokenizeSql(sql)
  // `name AS (` only ever introduces a CTE - a column alias cannot be followed by a paren - so this
  // needs no `WITH` tracking to be exact.
  const ctes = new Set<string>()
  for (let i = 1; i < tokens.length - 1; i++) {
    const name = tokens[i - 1] as SqlToken
    if (isKeyword(tokens[i], "as") && tokens[i + 1]?.value === "(" && name.kind === "word") {
      ctes.add(name.value.toLowerCase())
    }
  }
  const names: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (!isKeyword(tokens[i], "from") && !isKeyword(tokens[i], "join")) continue
    const first = tokens[i + 1]
    if (first === undefined || first.kind !== "word") continue // `FROM (subquery)` - nothing to name here
    // A qualified reference names the table second; an unqualified one names it first.
    const qualified = tokens[i + 2]?.value === "." && tokens[i + 3]?.kind === "word"
    const table = qualified ? (tokens[i + 3] as SqlToken).value : first.value
    if (table !== "" && !ctes.has(table.toLowerCase())) names.push(table.toLowerCase())
  }
  return names
}

/** Reject multi-statement input: allow one terminator only when it is the final character. */
const isSingleStatement = (sql: string): boolean => {
  let quote: "'" | '"' | null = null
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const next = sql[i + 1]
    if (lineComment) {
      if (char === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        i++
      }
      continue
    }
    if (quote !== null) {
      if (char === quote) {
        if (next === quote) i++
        else quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "-" && next === "-") {
      lineComment = true
      i++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      i++
      continue
    }
    if (char === ";") {
      return sql.slice(i + 1).trim() === ""
    }
  }
  return true
}

const isReadStatement = (sql: string): boolean => {
  const head = stripSqlNoise(sql).trim().toLowerCase()
  return head.startsWith("select") || head.startsWith("with")
}

/** Remove one trailing statement terminator (and anything after it) while preserving literals and
 * identifiers. Wrapping the query in a bounded subquery must not let a trailing comment consume the
 * wrapper's closing parenthesis. */
function executableSql(sql: string): string {
  let quote: "'" | '"' | null = null
  let lineComment = false
  let lineCommentStart = -1
  let blockComment = false
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const next = sql[i + 1]
    if (lineComment) {
      if (char === "\n") {
        lineComment = false
        lineCommentStart = -1
      }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        i++
      }
      continue
    }
    if (quote !== null) {
      if (char === quote) {
        if (next === quote) i++
        else quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "-" && next === "-") {
      lineComment = true
      lineCommentStart = i
      i++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      i++
      continue
    }
    if (char === ";") return sql.slice(0, i).trim()
  }
  if (lineComment && lineCommentStart >= 0) return sql.slice(0, lineCommentStart).trim()
  return sql.trim()
}

function assertResultLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new McpDbConfigError(`${name} must be a finite positive safe integer`)
  }
}

class QueryTimeoutError extends Error {
  constructor() {
    super("query exceeded the time limit")
    this.name = "QueryTimeoutError"
  }
}

/** One execution lane for `run_query`: `run` resolves rows, or rejects once the deadline passes. */
interface QuerySession {
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
    const remaining = deadline - Date.now()
    if (remaining <= 0) return Promise.reject(new QueryTimeoutError())
    const active = ensureWorker()
    const id = ++nextId
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => discard(new QueryTimeoutError()), remaining)
      pending.set(id, {
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
function openQuerySession(db: SqliteDatabaseLike): QuerySession {
  const filename = reopenableFilename(db)
  if (filename !== undefined && isWorkerAvailable()) return workerSession(filename)
  return inProcessSession(db)
}

/**
 * Serve `db` as a mountable MCP server (`mcp.fetch` at `POST /mcp`). See module docs for the
 * security model. Throws {@link McpDbConfigError} on any unsafe configuration - always at
 * construction (boot), never at request time.
 */
export function serveDatabaseAsMcp(
  db: SqliteDatabaseLike,
  options: ServeDatabaseAsMcpOptions,
): McpServer {
  if (options.tables.length === 0) {
    throw new McpDbConfigError(
      "an explicit non-empty `tables` allowlist is required - this package never defaults to exposing a whole database",
    )
  }
  for (const table of options.tables) {
    if (!SAFE_IDENTIFIER.test(table)) {
      throw new McpDbConfigError(
        `allowlisted table ${JSON.stringify(table)} is not a plain SQL identifier`,
      )
    }
  }
  const allowlist = new Set(options.tables.map((table) => table.toLowerCase()))

  if (options.enforceQueryOnly !== false) {
    try {
      db.run("PRAGMA query_only = ON")
    } catch (error) {
      throw new McpDbConfigError(
        `could not set PRAGMA query_only on the connection (${String(error)}) - pass a bun:sqlite-shaped database or set enforceQueryOnly: false with a read-only connection`,
      )
    }
  }

  const maxRows = options.runQuery?.maxRows ?? 100
  const maxResultBytes = options.runQuery?.maxResultBytes ?? 100 * 1024
  const queryTimeoutMs = options.runQuery?.queryTimeoutMs ?? 5_000
  const maxConcurrentQueries = options.runQuery?.maxConcurrentQueries ?? 1
  assertResultLimit(maxRows, "maxRows")
  assertResultLimit(maxResultBytes, "maxResultBytes")
  assertResultLimit(queryTimeoutMs, "queryTimeoutMs")
  assertResultLimit(maxConcurrentQueries, "maxConcurrentQueries")
  let activeQueries = 0
  let session: QuerySession | undefined

  const listTables = defineMcpTool({
    name: "list_tables",
    description: "List the tables this server exposes, with row counts.",
    handler: () => {
      const rows = options.tables.map((table) => {
        // nifra-expect sql-dynamic: table name from the operator-configured allowlist, escaped by sqlIdentifier; SQL cannot bind an identifier as a parameter
        const [count] = db
          .prepare(sqlIdentifiers`SELECT count(*) AS n FROM "${table}"`)
          .all() as Array<{
          n: number
        }>
        return { table, rows: count?.n ?? 0 }
      })
      return { text: JSON.stringify(rows), structuredContent: { tables: rows } }
    },
  })

  const describeTable = defineMcpTool({
    name: "describe_table",
    description: "Describe an exposed table: columns, types, nullability, primary key.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string", description: "Table name (must be exposed)" } },
      required: ["table"],
    },
    handler: (args) => {
      const table = String(args.table ?? "")
      if (!allowlist.has(table.toLowerCase())) {
        return { isError: true, text: `table ${JSON.stringify(table)} is not exposed` }
      }
      // Identifier is allowlist-verified (and the allowlist is identifier-checked at boot),
      // so interpolation here cannot inject.
      const columns = db.prepare(sqlIdentifiers`PRAGMA table_info("${table}")`).all()
      return { text: JSON.stringify(columns), structuredContent: { table, columns } }
    },
  })

  const tools = [listTables, describeTable]

  if (options.runQuery !== undefined) {
    // One lane for the life of the server: picked once here, so the handler below always has it.
    const querySession = openQuerySession(db)
    session = querySession
    const runQuery = defineMcpTool({
      name: "run_query",
      description:
        "Run one read-only SELECT against the exposed tables. Results are capped by rows and bytes.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "A single SELECT (or WITH…SELECT) statement" },
        },
        required: ["sql"],
      },
      intent: "table",
      handler: async (args) => {
        if (activeQueries >= maxConcurrentQueries) {
          return { isError: true, text: "too many concurrent queries" }
        }
        activeQueries += 1
        try {
          const sql = String(args.sql ?? "").trim()
          if (sql === "") return { isError: true, text: "empty query" }
          if (!isSingleStatement(sql)) {
            return { isError: true, text: "only a single statement is allowed" }
          }
          if (!isReadStatement(sql)) {
            return { isError: true, text: "only SELECT (or WITH…SELECT) statements are allowed" }
          }

          const deadline = Date.now() + queryTimeoutMs

          // Verify SQL relation tokens before the plan check. SQLite's plan output uses aliases as
          // scan targets (e.g. `users AS habits` becomes `SCAN habits`), so plan-only validation can
          // mistake an attacker-controlled alias for an allowlisted table.
          const executable = executableSql(sql)
          for (const relation of relationNames(executable)) {
            if (!allowlist.has(relation)) {
              return {
                isError: true,
                text: `query touches ${JSON.stringify(relation)}, which is not exposed`,
              }
            }
          }

          // Verify via the query plan that only allowlisted tables are touched. SQLite names every
          // scanned/searched relation in EXPLAIN QUERY PLAN detail rows.
          const query = executable
          let planRows: Array<{ detail?: unknown }>
          try {
            planRows = (await querySession.run(`EXPLAIN QUERY PLAN ${query}`, deadline)) as Array<{
              detail?: unknown
            }>
          } catch (error) {
            if (error instanceof QueryTimeoutError) return { isError: true, text: error.message }
            return { isError: true, text: `query failed to plan: ${String(error)}` }
          }
          for (const row of planRows) {
            const detail = typeof row.detail === "string" ? row.detail : ""
            // SQLite also emits non-table nodes such as `SCAN CONSTANT ROW` for a
            // constant-only SELECT. Only treat a scan/search target as a relation
            // when it is not one of those planner pseudo-nodes.
            if (
              /^SCAN\s+CONSTANT\s+ROW$/i.test(detail.trim()) ||
              /^SCAN\s+SUBQUERY\s+\d+$/i.test(detail.trim())
            ) {
              continue
            }
            // A schema-qualified reference plans as `SCAN main.habits`. The table is the last dotted
            // segment; reading the first would reject `main.habits` as a table literally named "main".
            const match =
              /(?:SCAN|SEARCH)\s+(?:TABLE\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
                detail,
              )
            if (match !== null) {
              const relation = match[1]?.toLowerCase() ?? ""
              if (!allowlist.has(relation)) {
                return {
                  isError: true,
                  text: `query touches ${JSON.stringify(match[1])}, which is not exposed`,
                }
              }
            }
          }

          let limitedRows: unknown[]
          try {
            // Fetch at most one row beyond the advertised cap. This keeps the database driver's
            // materialization bounded even when the caller submits `SELECT * FROM a_huge_table`.
            // nifra-expect sql-dynamic: wraps the caller's already-allowlisted read-only query (guarded above) in a bounding subselect; the query text is the tool's input, run on a read-only session
            limitedRows = await querySession.run(
              `SELECT * FROM (${query}) AS "__nifra_result" LIMIT ${maxRows + 1}`,
              deadline,
            )
          } catch (error) {
            if (error instanceof QueryTimeoutError) return { isError: true, text: error.message }
            return { isError: true, text: `query failed: ${String(error)}` }
          }

          const wasLimited = limitedRows.length > maxRows
          let total: number | null = limitedRows.length
          if (wasLimited && options.runQuery?.exactTotal === true) {
            try {
              // nifra-expect sql-dynamic: wraps the caller's already-allowlisted read-only query (guarded above) in a counting subselect; the query text is the tool's input, run on a read-only session
              const countRows = (await querySession.run(
                `SELECT count(*) AS "__nifra_total" FROM (${query}) AS "__nifra_count"`,
                deadline,
              )) as Array<{ __nifra_total?: unknown }>
              const count = countRows[0]?.__nifra_total
              if (typeof count !== "number" || !Number.isSafeInteger(count) || count < maxRows) {
                return { isError: true, text: "query failed: invalid row count" }
              }
              total = count
            } catch (error) {
              if (error instanceof QueryTimeoutError) return { isError: true, text: error.message }
              return { isError: true, text: `query failed to count results: ${String(error)}` }
            }
          } else if (wasLimited) {
            total = null
          }
          let shown = Math.min(limitedRows.length, maxRows)
          let payload = limitedRows.slice(0, shown)
          let result: Record<string, unknown> = {
            rows: payload,
            ...(wasLimited || shown < limitedRows.length ? { truncated: true, total } : {}),
          }
          let serialized = JSON.stringify(result)
          const encoded = new TextEncoder()
          while (encoded.encode(serialized).byteLength > maxResultBytes && shown > 0) {
            shown = Math.max(0, Math.floor(shown / 2))
            payload = limitedRows.slice(0, shown)
            result = {
              rows: payload,
              ...(wasLimited || shown < limitedRows.length ? { truncated: true, total } : {}),
            }
            serialized = JSON.stringify(result)
          }
          if (encoded.encode(serialized).byteLength > maxResultBytes) {
            return { isError: true, text: "query result exceeds maxResultBytes" }
          }
          return { text: serialized, structuredContent: result }
        } finally {
          activeQueries -= 1
        }
      },
    })
    tools.push(runQuery)
  }

  const server = createMcpServer({
    name: options.name ?? "nifra-db",
    version: options.version ?? "1.0.0",
    tools,
  })

  const runQueryOptions = options.runQuery
  if (session === undefined || runQueryOptions === undefined) return server

  // `run_query` is authorized at the TRANSPORT boundary, where the inbound Request's credentials
  // are visible - the handler itself performs no auth, so every path to it must pass this gate:
  // the wrapped fetch authorizes, and direct handle() dispatch fails closed (no Request → no auth).
  const { authorize } = runQueryOptions

  return {
    ...server,
    close: () => session.close(),
    fetch: (request: Request) =>
      server.fetch(request, {
        authorizeMessage: async (message, inbound) =>
          message.method !== "tools/call" || message.params?.name !== "run_query"
            ? true
            : authorize({ toolName: "run_query", request: inbound }),
      }),
    async handle(message) {
      if (message.method === "tools/call" && message.params?.name === "run_query") {
        return {
          jsonrpc: "2.0",
          id: typeof message.id === "string" || typeof message.id === "number" ? message.id : null,
          result: { content: [{ type: "text", text: "unauthorized" }], isError: true },
        } as JsonRpcResponse
      }
      return server.handle(message)
    },
  }
}
