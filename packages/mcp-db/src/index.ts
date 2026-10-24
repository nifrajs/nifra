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
 * and verification of the compiled statement that a query reads ONLY allowlisted tables. Results are
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
import {
  boundedSqliteQuery,
  cellBoundedSqliteQuery,
  countSqliteQuery,
  fitToBytes,
  gateSqliteStatement,
  type SqliteDatabaseLike,
  unexposedProgramRelation,
} from "./internal/shared.ts"
import { openQuerySession, QueryTimeoutError } from "./internal/sqlite-session.ts"

export type { SqliteDatabaseLike } from "./internal/shared.ts"

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
  /**
   * Max serialized result size in bytes (default 100 KB). It also bounds what is read: a text or
   * blob cell longer than this arrives as `"<n bytes>"`, and rows stop being read once their cells
   * pass it, so a query cannot make the server hold more than about one row past the budget.
   */
  readonly maxResultBytes?: number
  /**
   * Maximum wall-clock time for planning, execution, and optional counting (default 5 seconds). It
   * also bounds `list_tables`' row counts, at the same 5-second default when `runQuery` is omitted.
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
   * `run_query` still gates on SELECT/WITH + compiled-statement verification, but the engine-level guarantee is
   * yours to provide (e.g. open a second, read-only connection for the MCP mount - preferred).
   */
  readonly enforceQueryOnly?: boolean
  /**
   * Host allowlist for the HTTP transport (e.g. `["localhost", "127.0.0.1"]`). Set it when the server
   * listens on localhost or a private network: the same-origin default alone does not stop a
   * DNS-rebound browser page from reading the schema tools.
   */
  readonly allowedHosts?: readonly string[]
}

export class McpDbConfigError extends Error {
  constructor(message: string) {
    super(`@nifrajs/mcp-db: ${message}`)
    this.name = "McpDbConfigError"
  }
}

// A count reads the whole table and the schema tools answer anyone, so one count per table serves
// every listing for this long instead of each call scanning again.
const ROW_COUNT_TTL_MS = 10_000

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

function assertResultLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new McpDbConfigError(`${name} must be a finite positive safe integer`)
  }
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
  // One lane for the life of the server, picked once here and shared by the row counts and run_query.
  const session = openQuerySession(db)

  const countTables = async (): Promise<{ table: string; rows: unknown }[]> => {
    const deadline = Date.now() + queryTimeoutMs
    const tables: { table: string; rows: unknown }[] = []
    for (const table of options.tables) {
      let rows: unknown = null
      try {
        const [count] = await session.run(
          // nifra-expect sql-dynamic: table name from the operator-configured allowlist, escaped by sqlIdentifier; SQL cannot bind an identifier as a parameter
          sqlIdentifiers`SELECT count(*) AS n FROM "${table}"`,
          deadline,
        )
        if (typeof count === "object" && count !== null && "n" in count) rows = count.n
      } catch (error) {
        if (!(error instanceof QueryTimeoutError)) throw error
      }
      tables.push({ table, rows })
    }
    return tables
  }
  let listing: { readonly at: number; readonly tables: ReturnType<typeof countTables> } | undefined

  const listTables = defineMcpTool({
    name: "list_tables",
    description:
      "List the tables this server exposes, with row counts (refreshed at most every 10 seconds; null when a count runs past the query time limit).",
    handler: async () => {
      if (listing === undefined || Date.now() - listing.at >= ROW_COUNT_TTL_MS) {
        const tables = countTables()
        const current = { at: Date.now(), tables }
        listing = current
        tables.catch(() => {
          if (listing === current) listing = undefined
        })
      }
      const rows = await listing.tables
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
          const gate = gateSqliteStatement(String(args.sql ?? ""), (relation) =>
            allowlist.has(relation),
          )
          if (!gate.ok) return { isError: true, text: gate.text }

          const deadline = Date.now() + queryTimeoutMs
          const query = gate.query
          let catalog: unknown[]
          let program: unknown[]
          try {
            catalog = await session.run(
              "SELECT tbl_name, rootpage FROM sqlite_master WHERE rootpage > 0",
              deadline,
            )
            program = await session.run(`EXPLAIN ${query}`, deadline)
          } catch (error) {
            if (error instanceof QueryTimeoutError) return { isError: true, text: error.message }
            return { isError: true, text: `query failed to plan: ${String(error)}` }
          }
          // The program names each table it opens by root page. EXPLAIN QUERY PLAN cannot stand in:
          // it names a scan by its alias (`FROM habits h` plans as `SCAN h`).
          const unexposed = unexposedProgramRelation(program, catalog, (relation) =>
            allowlist.has(relation),
          )
          if (unexposed !== undefined) {
            return {
              isError: true,
              text: `query touches ${JSON.stringify(unexposed)}, which is not exposed`,
            }
          }

          let limitedRows: unknown[]
          let cut = false
          try {
            // Fetch at most one row beyond the advertised cap, so `SELECT * FROM a_huge_table`
            // cannot make the driver materialize every row. Where the driver names the columns,
            // oversized cells and rows past the byte budget are never copied out either.
            const bounded = boundedSqliteQuery(query, maxRows)
            const columns = await session.columns(bounded, deadline)
            if (columns.length === 0) {
              limitedRows = await session.run(bounded, deadline)
            } else {
              const read = await session.read(
                cellBoundedSqliteQuery(query, columns, maxRows, maxResultBytes),
                deadline,
                maxResultBytes,
              )
              limitedRows = read.rows
              cut = read.cut
            }
          } catch (error) {
            if (error instanceof QueryTimeoutError) return { isError: true, text: error.message }
            return { isError: true, text: `query failed: ${String(error)}` }
          }

          const wasLimited = limitedRows.length > maxRows || cut
          let total: number | null = limitedRows.length
          if (wasLimited && options.runQuery?.exactTotal === true) {
            try {
              const countRows = (await session.run(countSqliteQuery(query), deadline)) as Array<{
                __nifra_total?: unknown
              }>
              const count = countRows[0]?.__nifra_total
              if (
                typeof count !== "number" ||
                !Number.isSafeInteger(count) ||
                count < limitedRows.length
              ) {
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
          const fit = fitToBytes(
            Math.min(limitedRows.length, maxRows),
            (shown): Record<string, unknown> => ({
              rows: limitedRows.slice(0, shown),
              ...(wasLimited || shown < limitedRows.length ? { truncated: true, total } : {}),
            }),
            maxResultBytes,
          )
          if (fit === undefined) {
            return { isError: true, text: "query result exceeds maxResultBytes" }
          }
          return { text: fit.serialized, structuredContent: fit.value }
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
    ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
  })

  const runQueryOptions = options.runQuery
  if (runQueryOptions === undefined) return { ...server, close: () => session.close() }

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
