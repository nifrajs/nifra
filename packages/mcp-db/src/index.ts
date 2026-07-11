/**
 * `@nifrajs/mcp-db` — serve a SQLite database as an MCP server, fail-closed.
 *
 * Out of the box only SCHEMA tools are exposed (`list_tables`, `describe_table`), and only for
 * tables on the explicit `tables` allowlist. Query execution is OPT-IN and requires BOTH the
 * allowlist and an `authorize` hook — a database is PII by default, and an MCP client is an LLM;
 * this package refuses to be mounted open rather than defaulting open.
 *
 * Read-only is enforced in layers, not promised: `PRAGMA query_only = ON` on the connection
 * (SQLite rejects every write at the engine), a single-statement gate, a SELECT/WITH-only gate,
 * and `EXPLAIN QUERY PLAN` verification that a query touches ONLY allowlisted tables. Results are
 * capped by rows and bytes (an LLM does not need 100k rows; a transport does not want them) with
 * an explicit `truncated` marker.
 *
 * Bun/Node SQLite only (anything `bun:sqlite`-shaped, bound structurally — no driver dependency).
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
}

/** Context forwarded to `authorize` — the inbound HTTP Request carrying the `run_query` call. */
export interface McpDbAuthorizeContext {
  readonly toolName: "run_query"
  readonly request: Request
}

export interface RunQueryOptions {
  /**
   * REQUIRED. Authorize each `run_query` call at the transport boundary (inspect the inbound
   * Request's auth). Return false to reject with a JSON-RPC error. There is no unauthenticated
   * mode — schema tools are the anonymous surface. Note: `run_query` is therefore HTTP-only;
   * direct `handle()` dispatch rejects it (no Request to authorize — fails closed).
   */
  readonly authorize: (context: McpDbAuthorizeContext) => boolean | Promise<boolean>
  /** Max rows returned per query (default 100). */
  readonly maxRows?: number
  /** Max serialized result size in bytes (default 100 KB). */
  readonly maxResultBytes?: number
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
   * when the same connection must also serve writes elsewhere in the app — with it disabled,
   * `run_query` still gates on SELECT/WITH + plan verification, but the engine-level guarantee is
   * yours to provide (e.g. open a second, read-only connection for the MCP mount — preferred).
   */
  readonly enforceQueryOnly?: boolean
}

export class McpDbConfigError extends Error {
  constructor(message: string) {
    super(`@nifrajs/mcp-db: ${message}`)
    this.name = "McpDbConfigError"
  }
}

/** A safe SQL identifier — quoting is not enough for PRAGMA args, so reject instead. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const stripSqlNoise = (sql: string): string =>
  sql
    // Strings first so comment markers inside literals don't count.
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")

/** Reject multi-statement input: any `;` outside literals/comments except one trailing. */
const isSingleStatement = (sql: string): boolean => {
  const noise = stripSqlNoise(sql).trim().replace(/;$/, "")
  return !noise.includes(";")
}

const isReadStatement = (sql: string): boolean => {
  const head = stripSqlNoise(sql).trim().toLowerCase()
  return head.startsWith("select") || head.startsWith("with")
}

/**
 * Serve `db` as a mountable MCP server (`mcp.fetch` at `POST /mcp`). See module docs for the
 * security model. Throws {@link McpDbConfigError} on any unsafe configuration — always at
 * construction (boot), never at request time.
 */
export function serveDatabaseAsMcp(
  db: SqliteDatabaseLike,
  options: ServeDatabaseAsMcpOptions,
): McpServer {
  if (options.tables.length === 0) {
    throw new McpDbConfigError(
      "an explicit non-empty `tables` allowlist is required — this package never defaults to exposing a whole database",
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
        `could not set PRAGMA query_only on the connection (${String(error)}) — pass a bun:sqlite-shaped database or set enforceQueryOnly: false with a read-only connection`,
      )
    }
  }

  const maxRows = options.runQuery?.maxRows ?? 100
  const maxResultBytes = options.runQuery?.maxResultBytes ?? 100 * 1024

  const listTables = defineMcpTool({
    name: "list_tables",
    description: "List the tables this server exposes, with row counts.",
    handler: () => {
      const rows = options.tables.map((table) => {
        const [count] = db.prepare(`SELECT count(*) AS n FROM "${table}"`).all() as Array<{
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
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all()
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
      handler: (args) => {
        const sql = String(args.sql ?? "").trim()
        if (sql === "") return { isError: true, text: "empty query" }
        if (!isSingleStatement(sql)) {
          return { isError: true, text: "only a single statement is allowed" }
        }
        if (!isReadStatement(sql)) {
          return { isError: true, text: "only SELECT (or WITH…SELECT) statements are allowed" }
        }

        // Verify via the query plan that only allowlisted tables are touched. SQLite names every
        // scanned/searched relation in EXPLAIN QUERY PLAN detail rows.
        let planRows: Array<{ detail?: unknown }>
        try {
          planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: unknown }>
        } catch (error) {
          return { isError: true, text: `query failed to plan: ${String(error)}` }
        }
        for (const row of planRows) {
          const detail = typeof row.detail === "string" ? row.detail : ""
          const match = /(?:SCAN|SEARCH)\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(detail)
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

        let rows: unknown[]
        try {
          rows = db.prepare(sql).all()
        } catch (error) {
          return { isError: true, text: `query failed: ${String(error)}` }
        }

        const total = rows.length
        let shown = Math.min(total, maxRows)
        let payload = rows.slice(0, shown)
        let serialized = JSON.stringify(payload)
        while (serialized.length > maxResultBytes && shown > 0) {
          shown = Math.max(0, Math.floor(shown / 2))
          payload = rows.slice(0, shown)
          serialized = JSON.stringify(payload)
        }
        const truncated = shown < total
        const result: Record<string, unknown> = {
          rows: payload,
          ...(truncated ? { truncated: { shown, total } } : {}),
        }
        return { text: JSON.stringify(result), structuredContent: result }
      },
    })
    tools.push(runQuery)
  }

  const server = createMcpServer({
    name: options.name ?? "nifra-db",
    version: options.version ?? "1.0.0",
    tools,
  })

  if (options.runQuery === undefined) return server

  // `run_query` is authorized at the TRANSPORT boundary, where the inbound Request's credentials
  // are visible — the handler itself performs no auth, so every path to it must pass this gate:
  // the wrapped fetch authorizes, and direct handle() dispatch fails closed (no Request → no auth).
  const { authorize } = options.runQuery

  const rpcId = (id: unknown): string | number | null =>
    typeof id === "string" || typeof id === "number" ? id : null

  const unauthorizedResult = (id: unknown): JsonRpcResponse =>
    ({
      jsonrpc: "2.0",
      id: rpcId(id),
      result: {
        content: [{ type: "text", text: "unauthorized" }],
        isError: true,
      },
    }) as JsonRpcResponse

  const isRunQueryCall = (message: unknown): message is { id?: unknown } => {
    if (typeof message !== "object" || message === null) return false
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } }
    return method === "tools/call" && params?.name === "run_query"
  }

  return {
    ...server,
    async fetch(request: Request): Promise<Response> {
      if (request.method === "POST") {
        let body: unknown
        try {
          body = await request.clone().json()
        } catch {
          return server.fetch(request) // malformed JSON → the protocol layer's error handling
        }
        const messages = Array.isArray(body) ? body : [body]
        const queryCall = messages.find(isRunQueryCall)
        if (queryCall !== undefined) {
          const ok = await authorize({ toolName: "run_query", request })
          if (!ok) return Response.json(unauthorizedResult(queryCall.id))
        }
      }
      return server.fetch(request)
    },
    async handle(message) {
      if (isRunQueryCall(message)) return unauthorizedResult(message.id)
      return server.handle(message)
    },
  }
}
