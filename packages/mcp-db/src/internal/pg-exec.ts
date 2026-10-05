/**
 * The server-enforced layers of `@nifrajs/mcp-db/postgres`: the read-only transaction with its
 * timeouts, the extended-protocol statement, the cursor, and the plan-level table scope. Nothing here
 * parses the caller's SQL - the refusals in this file come from the server, and the only text lexed
 * is the expressions of the server's own verbose plan.
 *
 * Bun 1.4.2 sends `sql.unsafe(text)` and `sql.unsafe(text, [])` over the SIMPLE protocol, which runs
 * several `;`-separated statements. Only a tagged-template call (or `unsafe` with a non-empty value
 * list) uses the EXTENDED protocol, where the server refuses a second statement with "cannot insert
 * multiple commands into a prepared statement". So every statement carrying caller text goes through
 * {@link extended}; `unsafe` is used only for fixed text this file writes.
 */

import { lexPostgres } from "./pg-lexer.ts"
import { type DbRefusal, dbRefusal } from "./shared.ts"

/** A pending query: awaitable for object rows, or `.values()` for array rows (checked by readers). */
export interface PgQuery extends PromiseLike<readonly unknown[]> {
  values(): PromiseLike<readonly unknown[]>
}

/** Rows as records: a driver row that is not an object is dropped, never cast. */
export function records(rows: readonly unknown[]): Record<string, unknown>[] {
  return rows.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  )
}

/** One connection reserved from the pool (`Bun.SQL`'s `ReservedSQL`, structurally). */
export interface PgConnection {
  (strings: TemplateStringsArray, ...values: unknown[]): PgQuery
  unsafe(text: string): PgQuery
  release(): void
}

/** A Postgres client (`Bun.SQL`, structurally): the engine reserves one connection per call. */
export interface PostgresClient {
  reserve(): Promise<PgConnection>
  close(options?: { readonly timeout?: number }): Promise<void>
}

/** Run caller text as ONE extended-protocol statement with no parameters. */
export function extended(connection: PgConnection, text: string): PgQuery {
  const strings: TemplateStringsArray = Object.assign([text], { raw: [text] })
  return connection(strings)
}

const WRITE_KEYWORD =
  /at or near "(insert|update|delete|merge|call|do|copy|create|drop|alter|truncate|grant|revoke|lock|vacuum|analyze|cluster|reindex|refresh|comment|security|import|listen|notify|load|discard|reset|set|show|begin|commit|rollback|savepoint|release|prepare|execute|deallocate|declare|fetch|move|close|checkpoint|explain)"/i

/** Map a driver error to a refusal by its SQLSTATE; only a genuine query error is a failure. */
export function pgFailure(error: unknown, context = "query failed"): DbRefusal {
  // Bun.SQL puts the SQLSTATE on `errno`.
  const state =
    typeof error === "object" && error !== null && "errno" in error ? error.errno : undefined
  const message = `${context}: ${error instanceof Error ? error.message : String(error)}`
  if (typeof state !== "string" || !/^[0-9A-Z]{5}$/.test(state)) {
    return dbRefusal("NIFRA_DB_DRIVER", message)
  }
  const text = error instanceof Error ? error.message : ""
  if (state === "25006" || state === "25001") return dbRefusal("NIFRA_DB_WRITE_REFUSED", message)
  if (state === "0A000" && /data-modifying/i.test(text)) {
    return dbRefusal("NIFRA_DB_WRITE_REFUSED", message)
  }
  if (
    state === "42601" &&
    (/multiple commands/i.test(text) ||
      /INTO is not allowed/i.test(text) ||
      WRITE_KEYWORD.test(text))
  ) {
    return dbRefusal("NIFRA_DB_WRITE_REFUSED", message)
  }
  if (state === "57014" || state === "55P03" || state === "25P03") {
    return dbRefusal("NIFRA_DB_TIMEOUT", message)
  }
  if (state === "42501") {
    return dbRefusal(
      /for (table|view|relation|schema|sequence|materialized view|foreign table)\b/i.test(text)
        ? "NIFRA_DB_TABLE_EXCLUDED"
        : "NIFRA_DB_FUNCTION_REFUSED",
      message,
    )
  }
  if (/^(08|28|3D|53|57P|XX)/.test(state)) return dbRefusal("NIFRA_DB_DRIVER", message)
  return dbRefusal("NIFRA_DB_QUERY_FAILED", message)
}

/** Validated milliseconds for a `SET LOCAL` (an integer, so it can be written into the text). */
function millis(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive integer")
  }
  return timeoutMs
}

/**
 * Run `work` inside `BEGIN READ ONLY` on one reserved connection, with the statement, lock and
 * idle-in-transaction timeouts set for this transaction only. Always rolls back, so nothing a call
 * does (a `set_config`, a session setting) outlives it.
 */
export async function inReadOnlyTransaction<T>(
  client: PostgresClient,
  timeoutMs: number,
  work: (connection: PgConnection) => Promise<T | DbRefusal>,
): Promise<T | DbRefusal> {
  const ms = millis(timeoutMs)
  let connection: PgConnection
  try {
    connection = await client.reserve()
  } catch (error) {
    return pgFailure(error, "could not connect")
  }
  try {
    // nifra-expect sql-dynamic: fixed statements; the one interpolation is a validated integer of milliseconds
    await connection.unsafe(
      `BEGIN READ ONLY; SET LOCAL statement_timeout = ${ms}; SET LOCAL lock_timeout = ${ms}; SET LOCAL idle_in_transaction_session_timeout = ${ms}`,
    )
    return await work(connection)
  } catch (error) {
    return pgFailure(error)
  } finally {
    try {
      await connection.unsafe("ROLLBACK")
    } catch {
      // A connection the server already closed has nothing to roll back.
    }
    connection.release()
  }
}

/** A relation (or a function scanned as one) the plan reads, as the plan names it. */
export interface PlanRelation {
  readonly schema: string
  readonly name: string
}

/** A column of a scanned relation that a plan expression names; `*` is a whole-row reference. */
export interface PlanColumn {
  readonly relation: PlanRelation
  readonly column: string
}

/** What an `EXPLAIN (VERBOSE, FORMAT JSON)` plan reads, InitPlans and SubPlans included. */
export interface PlanReads {
  readonly relations: readonly PlanRelation[]
  /** Functions in FROM (Function Scan nodes): a system view such as `pg_stat_activity` plans as one. */
  readonly functions: readonly PlanRelation[]
  /**
   * Every relation column an expression of the plan uses: output, filter, join, sort or index
   * condition. A verbose plan qualifies each one with its scan's unique alias, so an alias or an
   * expression in the query still names the column it reads.
   */
  readonly columns: readonly PlanColumn[]
  /**
   * Outputs left out of `columns` because they may be a physical target list: a node under an
   * aggregate, join or result emitting plain columns of one relation. The planner emits every column
   * there whether or not the parent uses it, and the parent's own expressions name what it does use.
   * When the list is not the relation's full column list, it is exactly what was asked for and counts.
   */
  readonly outputs: readonly PlanOutput[]
}

/** Plain columns of one relation that a node outputs, as listed. */
export interface PlanOutput {
  readonly relation: PlanRelation
  readonly columns: readonly string[]
}

// Nodes that pass their child's rows up unchanged: whether a child's output is used is decided above.
const PASS_THROUGH_NODES = new Set([
  "Limit",
  "Sort",
  "Incremental Sort",
  "Material",
  "Memoize",
  "Hash",
  "Gather",
  "Gather Merge",
  "Unique",
  "LockRows",
])

// Nodes whose own expressions a verbose plan prints in terms of the base columns they use.
const PROJECTING_NODES = new Set([
  "Aggregate",
  "Group",
  "WindowAgg",
  "Nested Loop",
  "Hash Join",
  "Merge Join",
  "Result",
  "ProjectSet",
])

// Fields that name a node or a relation rather than hold an expression.
const PLAN_NAME_FIELDS = new Set([
  "Node Type",
  "Relation Name",
  "Schema",
  "Alias",
  "Index Name",
  "CTE Name",
  "Function Name",
  "Subplan Name",
  "Parent Relationship",
])

/** Every relation and every FROM-clause function a verbose JSON plan scans, and the columns it uses. */
export function planReads(plan: unknown): PlanReads {
  const relations = new Map<string, PlanRelation>()
  const functions = new Map<string, PlanRelation>()
  const aliases = new Map<string, PlanRelation>()
  const expressions: string[] = []
  // Outputs under a projecting parent, resolved once every alias is known.
  const underProjection: (readonly string[])[] = []
  const visit = (node: unknown, depth: number, projected: boolean): void => {
    if (depth > 256 || typeof node !== "object" || node === null) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, projected)
      return
    }
    const field = (key: string): unknown => Reflect.get(node, key)
    const declared = field("Schema")
    const schema = typeof declared === "string" ? declared : ""
    for (const [key, found] of [
      ["Relation Name", relations],
      ["Function Name", functions],
    ] as const) {
      const name = field(key)
      if (typeof name === "string") found.set(`${schema}.${name}`, { schema, name })
    }
    const relation = field("Relation Name")
    const alias = field("Alias")
    if (typeof relation === "string") {
      aliases.set(typeof alias === "string" ? alias : relation, { schema, name: relation })
    }
    // A SubPlan's or InitPlan's result reaches its parent as `(SubPlan n)`, not as base columns.
    const role = field("Parent Relationship")
    const own = projected && role !== "SubPlan" && role !== "InitPlan"
    for (const [key, value] of Object.entries(node)) {
      if (PLAN_NAME_FIELDS.has(key)) continue
      if (typeof value === "string") expressions.push(value)
      else if (Array.isArray(value)) {
        const texts = value.filter((item): item is string => typeof item === "string")
        if (key === "Output" && own) underProjection.push(texts)
        else expressions.push(...texts)
      }
    }
    const type = String(field("Node Type"))
    visit(field("Plan"), depth + 1, false)
    visit(
      field("Plans"),
      depth + 1,
      PASS_THROUGH_NODES.has(type) ? own : PROJECTING_NODES.has(type),
    )
  }
  visit(plan, 0, false)

  const outputs: PlanOutput[] = []
  for (const list of underProjection) {
    // Plain `alias.column` items of one relation (a dropped column shows as a NULL constant).
    let relation: PlanRelation | undefined
    const listed: string[] = []
    for (const text of list) {
      if (text.startsWith("NULL::")) continue
      const tokens = lexPostgres(text).tokens
      const [qualifier, dot, column] = tokens
      const named = qualifier?.kind === "word" ? aliases.get(qualifier.value) : undefined
      if (
        tokens.length !== 3 ||
        named === undefined ||
        dot?.value !== "." ||
        column?.kind !== "word" ||
        (relation !== undefined && relation !== named)
      ) {
        relation = undefined
        break
      }
      relation = named
      listed.push(column.value)
    }
    if (relation !== undefined) outputs.push({ relation, columns: listed })
    else expressions.push(...list)
  }

  const columns = new Map<string, PlanColumn>()
  for (const text of expressions) {
    const { tokens } = lexPostgres(text)
    for (let i = 0; i + 2 < tokens.length; i++) {
      const [qualifier, dot, column] = [tokens[i], tokens[i + 1], tokens[i + 2]]
      if (qualifier?.kind !== "word" || dot?.kind !== "punct" || dot.value !== ".") continue
      const relation = aliases.get(qualifier.value)
      if (relation === undefined || column === undefined) continue
      if (column.kind === "word" || (column.kind === "punct" && column.value === "*")) {
        columns.set(`${relation.schema}.${relation.name}.${column.value}`, {
          relation,
          column: column.value,
        })
      }
    }
  }
  return {
    relations: [...relations.values()],
    functions: [...functions.values()],
    columns: [...columns.values()],
    outputs,
  }
}

/** The JSON document an `EXPLAIN (FORMAT JSON)` row carries, whatever the driver parsed it into. */
export function planDocument(rows: readonly unknown[]): unknown {
  const value = records(rows)[0]?.["QUERY PLAN"]
  if (typeof value !== "string") return value
  const parsed: unknown = JSON.parse(value)
  return parsed
}

/** Refuse when anything the plan reads (or a table it inherits from) is out of scope. */
export type ScopeCheck = (
  connection: PgConnection,
  reads: PlanReads,
) => Promise<DbRefusal | undefined>

/** Options for {@link fetchThroughCursor}. */
export interface CursorOptions {
  readonly maxRows: number
  readonly scope: ScopeCheck
}

/**
 * Declare the caller's query as a NO SCROLL cursor (the server accepts only SELECT/VALUES there and
 * refuses a data-modifying WITH), check the plan's relations, then FETCH at most `maxRows + 1` rows.
 *
 * The query is wrapped as a subquery so each row also carries the result's column names: Bun returns
 * array rows without names, and object rows lose a duplicated name. The wrapper's first column is a
 * JSON array of the names, read from the first row.
 */
export async function fetchThroughCursor(
  connection: PgConnection,
  sql: string,
  options: CursorOptions,
): Promise<{ readonly columns: string[]; readonly rows: unknown[][] } | DbRefusal> {
  const wrapped = `SELECT (SELECT json_agg(nifra_k)::text FROM json_object_keys(row_to_json(nifra_q)) AS nifra_k) AS nifra_columns, nifra_q.* FROM (\n${sql}\n) AS nifra_q`
  await extended(connection, `DECLARE nifra_c NO SCROLL CURSOR FOR ${wrapped}`)
  const plan = planDocument(await extended(connection, `EXPLAIN (VERBOSE, FORMAT JSON) ${wrapped}`))
  const refusal = await options.scope(connection, planReads(plan))
  if (refusal !== undefined) return refusal
  const rowCap = options.maxRows + 1
  const fetched =
    // nifra-expect sql-dynamic: a fixed FETCH whose one interpolation is the integer row cap
    (await connection.unsafe(`FETCH FORWARD ${rowCap} FROM nifra_c`).values()).filter(
      (row): row is unknown[] => Array.isArray(row),
    )
  const first = fetched[0]?.[0]
  const names: unknown = typeof first === "string" ? JSON.parse(first) : []
  const columns = Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : []
  return { columns, rows: fetched.map((row) => row.slice(1)) }
}

/** Options for {@link explainThroughServer}. */
export interface ExplainOptions {
  readonly analyze: boolean
  readonly scope: ScopeCheck
}

/**
 * Plan the caller's query. The cursor declaration runs first purely as the statement gate (then is
 * closed), the VERBOSE plan feeds the scope check, and the returned plan is plain `FORMAT JSON` -
 * with `analyze`, executed inside the same read-only transaction and timeout.
 */
export async function explainThroughServer(
  connection: PgConnection,
  sql: string,
  options: ExplainOptions,
): Promise<{ readonly plan: unknown } | DbRefusal> {
  await extended(connection, `DECLARE nifra_c NO SCROLL CURSOR FOR ${sql}`)
  await connection.unsafe("CLOSE nifra_c")
  const verbose = planDocument(await extended(connection, `EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`))
  const refusal = await options.scope(connection, planReads(verbose))
  if (refusal !== undefined) return refusal
  const mode = options.analyze ? "ANALYZE, FORMAT JSON" : "FORMAT JSON"
  return { plan: planDocument(await extended(connection, `EXPLAIN (${mode}) ${sql}`)) }
}
