/**
 * `@nifrajs/mcp-db/engine` - the read-only SQLite engine behind `@nifrajs/mcp-db`, without the MCP
 * layer, plus the result shape and refusal codes both database engines share.
 *
 * Read-only is enforced by SQLite, not promised by a parser: {@link openReadOnlySqlite} opens the file
 * with the `readonly` flag and sets `PRAGMA query_only = ON`, so the engine rejects every write. The
 * statement gates ({@link gateSqliteStatement}: one statement, SELECT/WITH only, every named relation
 * exposed) and a table check on the compiled statement (every table its bytecode opens must be
 * exposed, so views and aliases cannot hide one) sit in front of it, and the caps
 * ({@link shapeRows}, {@link fitToBytes}) bound what comes back.
 *
 *   const db = await openReadOnlySqlite("./data/app.db")
 *   const result = querySqlite(db, "SELECT status, count(*) FROM orders GROUP BY 1", {
 *     exclude: ["sessions"],
 *     maxRows: 100,
 *     maxResultBytes: 100 * 1024,
 *   })
 *   if ("code" in result) console.error(result.code, result.fix)
 */

import type { Database } from "bun:sqlite"
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  boundedSqliteQuery,
  type DbPlan,
  type DbRedaction,
  type DbRefusal,
  type DbRows,
  type DbSchemaReport,
  type DbSchemaTable,
  dbRefusal,
  fitToBytes,
  gateSqliteStatement,
  type ShapeRowsOptions,
  shapeRows,
  sqliteCteNames,
} from "./internal/shared.ts"

export {
  boundedSqliteQuery,
  countSqliteQuery,
  type DbPlan,
  type DbRedaction,
  type DbRefusal,
  type DbRefusalCode,
  type DbRows,
  type DbSchemaColumn,
  type DbSchemaForeignKey,
  type DbSchemaIndex,
  type DbSchemaReport,
  type DbSchemaTable,
  dbRefusal,
  fitToBytes,
  gateSqliteStatement,
  isDbRefusal,
  REDACTED_CELL,
  type ShapeRowsOptions,
  type SqliteDatabaseLike,
  type SqliteGate,
  shapeRows,
  toJsonCell,
  unexposedPlanRelation,
} from "./internal/shared.ts"

// ---------------------------------------------------------------------------------------------------
// SQLite: open, scope, query, explain, schema
// ---------------------------------------------------------------------------------------------------

const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve a database file against the project root. The file must exist and its real path (symlinks
 * followed) must sit inside the root's real path, unless `allowFiles` names it.
 */
export function resolveSqliteFile(
  root: string,
  file: string,
  allowFiles: readonly string[] = [],
): string | DbRefusal {
  const candidate = resolve(root, file)
  if (!existsSync(candidate)) return dbRefusal("NIFRA_DB_DRIVER", `no database file at ${file}`)
  let real: string
  let realRoot: string
  try {
    real = realpathSync(candidate)
    realRoot = realpathSync(root)
  } catch (error) {
    return dbRefusal("NIFRA_DB_DRIVER", `could not resolve ${file}: ${String(error)}`)
  }
  if (isInside(realRoot, real)) return real
  for (const allowed of allowFiles) {
    try {
      if (realpathSync(resolve(root, allowed)) === real) return real
    } catch {
      // An allowFiles entry that does not exist allows nothing.
    }
  }
  return dbRefusal(
    "NIFRA_DB_OUTSIDE_ROOT",
    `${file} resolves to ${real}, outside the project root ${realRoot}`,
  )
}

/** True when the file's header says WAL mode (format versions 2/2 at bytes 18-19). */
function isWalDatabase(file: string): boolean {
  const header = new Uint8Array(20)
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    return readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2 && header[19] === 2
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const SQLITE_BUSY_TIMEOUT_MS = 2_000

/**
 * Open a SQLite file read-only: the `readonly` flag plus `PRAGMA query_only = ON`.
 *
 * Trap: a read-only connection cannot create a WAL database's `-wal` file, so while no writer has the
 * database open (no `-wal` on disk) the first read fails with SQLITE_CANTOPEN. Only in that case the
 * file is reopened read-write with `query_only` on, which creates the WAL files the way any client
 * would and still rejects every write at the engine. With a live writer the `-wal` exists and the
 * read-only open works.
 */
export async function openReadOnlySqlite(file: string): Promise<Database> {
  const { Database } = await import("bun:sqlite")
  const probe = (db: Database): Database => {
    db.run("PRAGMA query_only = ON")
    // A writer that is mid-recovery or holds the journal lock answers SQLITE_BUSY: wait, not fail.
    db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    db.prepare("SELECT count(*) FROM sqlite_master").all()
    return db
  }
  // safeIntegers: an INTEGER beyond 2^53 comes back exact (as a bigint) instead of rounded.
  const readonly = new Database(file, { readonly: true, safeIntegers: true })
  try {
    return probe(readonly)
  } catch (error) {
    readonly.close()
    if (
      sqliteCode(error) !== "SQLITE_CANTOPEN" ||
      !isWalDatabase(file) ||
      existsSync(`${file}-wal`)
    ) {
      throw error
    }
  }
  const fallback = new Database(file, { readwrite: true, safeIntegers: true })
  try {
    return probe(fallback)
  } catch (error) {
    fallback.close()
    throw error
  }
}

/** The tables and views of a SQLite database, lowercased: all of them, and those not excluded. */
export function sqliteRelations(
  db: Pick<Database, "prepare">,
  exclude: readonly string[] = [],
): { readonly all: ReadonlySet<string>; readonly exposed: ReadonlySet<string> } {
  const excluded = new Set(exclude.map((name) => name.toLowerCase()))
  const rows = db
    .prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .all()
  const all = new Set(rows.map((row) => row.name.toLowerCase()))
  return { all, exposed: new Set([...all].filter((name) => !excluded.has(name))) }
}

const SQLITE_WRITE_SYNTAX =
  /near "(insert|update|delete|replace|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)": syntax error/i

/** The `SQLITE_*` code bun:sqlite puts on an error, if any. */
const sqliteCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined

/** Map a SQLite error to a refusal: a write the engine rejected is a refusal, not a failure. */
function sqliteFailure(error: unknown, context: string): DbRefusal {
  const code = sqliteCode(error)
  const message = `${context}: ${error instanceof Error ? error.message : String(error)}`
  if (typeof code === "string") {
    if (code.startsWith("SQLITE_READONLY") || code === "SQLITE_AUTH") {
      return dbRefusal("NIFRA_DB_WRITE_REFUSED", message)
    }
    if (code === "SQLITE_INTERRUPT") return dbRefusal("NIFRA_DB_TIMEOUT", message)
    // SQLite has no data-modifying CTE: `WITH d AS (DELETE ...)` fails to parse at the write.
    if (code === "SQLITE_ERROR" && SQLITE_WRITE_SYNTAX.test(message)) {
      return dbRefusal("NIFRA_DB_WRITE_REFUSED", message)
    }
    if (
      code.startsWith("SQLITE_CANTOPEN") ||
      code.startsWith("SQLITE_CORRUPT") ||
      code.startsWith("SQLITE_IOERR") ||
      code === "SQLITE_NOTADB"
    ) {
      return dbRefusal("NIFRA_DB_DRIVER", message)
    }
  }
  return dbRefusal("NIFRA_DB_QUERY_FAILED", message)
}

/** Options for {@link querySqlite} and {@link explainSqlite}. */
export interface SqliteQueryOptions extends ShapeRowsOptions {
  /** Tables and views the query may not read (case-insensitive). */
  readonly exclude?: readonly string[]
}

type Verified = { readonly ok: true; readonly query: string } | DbRefusal

const GATE_MESSAGES = {
  empty: "empty query",
  multiple: "only a single statement is allowed",
  "not-read": "only a read-only query (SELECT, or WITH ... SELECT) is allowed",
} as const

function verifySqlite(
  db: Pick<Database, "prepare">,
  sql: string,
  exclude: readonly string[] | undefined,
  masked?: (column: string) => boolean,
): Verified {
  const { all, exposed } = sqliteRelations(db, exclude)
  const unexposed = (relation: string): DbRefusal =>
    dbRefusal(
      "NIFRA_DB_TABLE_EXCLUDED",
      all.has(relation.toLowerCase())
        ? `the query reads ${JSON.stringify(relation)}, which devDatabase.exclude leaves out`
        : `the query reads ${JSON.stringify(relation)}, which is not a table or view of this database`,
    )
  const ctes = new Set(sqliteCteNames(sql))
  const gate = gateSqliteStatement(sql, (relation) => exposed.has(relation) || ctes.has(relation))
  if (!gate.ok) {
    if (gate.reason === "unexposed") return unexposed(gate.relation ?? "")
    return dbRefusal("NIFRA_DB_WRITE_REFUSED", GATE_MESSAGES[gate.reason])
  }
  let reads: BytecodeReads
  try {
    reads = bytecodeReads(db, gate.query, masked)
  } catch (error) {
    return sqliteFailure(error, "query failed to plan")
  }
  const relation = reads.tables.find((name) => !exposed.has(name.toLowerCase()))
  if (relation !== undefined) return unexposed(relation)
  if (reads.masked.length > 0) {
    return dbRefusal(
      "NIFRA_DB_COLUMN_REFUSED",
      `the query reads ${reads.masked.join(", ")}, masked as ${reads.masked.length === 1 ? "a credential" : "credentials"}`,
    )
  }
  return { ok: true, query: gate.query }
}

const READ_OPCODES = new Set(["OpenRead", "ReopenIdx", "OpenWrite", "VOpen"])

// Each compares a cursor's leading key fields (P4 of them, all when P4 is not a count) with values.
const KEY_COMPARE_OPCODES = new Set([
  "SeekGE",
  "SeekGT",
  "SeekLE",
  "SeekLT",
  "IdxGE",
  "IdxGT",
  "IdxLE",
  "IdxLT",
  "Found",
  "NotFound",
  "NoConflict",
  "IfNoHope",
])
const ROWID_OPCODES = new Set(["Rowid", "SeekRowid", "NotExists", "IdxRowid"])

interface BytecodeReads {
  readonly tables: readonly string[]
  /** Masked columns the statement reads, filters on or compares, as `table.column`. */
  readonly masked: readonly string[]
}

interface ProgramStep {
  readonly opcode: string
  readonly p1: number | bigint
  readonly p2: number | bigint
  readonly p3: number | bigint
  readonly p4: unknown
}

interface CatalogEntry {
  readonly type: string
  readonly name: string
  readonly table: string
  readonly sql: string | null
}

/** What a cursor's record holds: the columns each field position reads, and how many lead as key. */
interface CursorLayout {
  readonly table: string
  readonly fields: readonly (readonly string[])[]
  readonly keyCount: number
  /** The INTEGER PRIMARY KEY column the rowid is, if the table has one. */
  readonly rowid: string | undefined
}

/**
 * The record layout behind a cursor on `entry`, from SQLite's own catalog. A rowid table stores its
 * non-virtual columns in order, then its virtual ones; a WITHOUT ROWID table and an index store the
 * fields `pragma_index_xinfo` lists. An expression field reads every column its index SQL names.
 */
function cursorLayout(db: Pick<Database, "prepare">, entry: CatalogEntry): CursorLayout {
  const columns = db
    .prepare<
      { name: string; type: string; pk: number | bigint; hidden: number | bigint },
      [string]
    >("SELECT name, type, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid")
    .all(entry.table)
  let withoutRowid: boolean
  try {
    withoutRowid =
      Number(
        db
          .prepare<{ wr: number | bigint }, [string]>(
            "SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?",
          )
          .get(entry.table)?.wr ?? 0,
      ) === 1
  } catch {
    // pragma_table_list is SQLite 3.37+; Bun on macOS links the system library, which can be older.
    const created = db
      .prepare<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(entry.table)?.sql
    withoutRowid = /\)\s*(?:STRICT\s*,\s*)?WITHOUT\s+ROWID\b/i.test(created ?? "")
  }
  const keys = columns.filter((column) => Number(column.pk) > 0)
  const rowid =
    !withoutRowid && keys.length === 1 && keys[0]?.type.toUpperCase() === "INTEGER"
      ? keys[0].name
      : undefined
  let index = entry.type === "index" ? entry.name : undefined
  if (entry.type === "table" && withoutRowid) {
    index = db
      .prepare<{ name: string }, [string]>(
        "SELECT name FROM pragma_index_list(?) WHERE origin = 'pk'",
      )
      .get(entry.table)?.name
  }
  if (index === undefined) {
    const stored = [
      ...columns.filter((column) => Number(column.hidden) !== 2),
      ...columns.filter((column) => Number(column.hidden) === 2),
    ]
    return { table: entry.table, fields: stored.map((column) => [column.name]), keyCount: 0, rowid }
  }
  // A substring match can only over-count: an expression field then reads one column too many.
  const source = (entry.sql ?? "").toLowerCase()
  const named = columns
    .map((column) => column.name)
    .filter((name) => source.includes(name.toLowerCase()))
  const xinfo = db
    .prepare<{ cid: number | bigint; name: string | null; key: number | bigint }, [string]>(
      "SELECT cid, name, key FROM pragma_index_xinfo(?) ORDER BY seqno",
    )
    .all(index)
  return {
    table: entry.table,
    fields: xinfo.map((field) =>
      field.name !== null
        ? [field.name]
        : Number(field.cid) === -1
          ? rowid === undefined
            ? []
            : [rowid]
          : named,
    ),
    keyCount: xinfo.filter((field) => Number(field.key) === 1).length,
    rowid,
  }
}

/**
 * The tables a statement's bytecode opens, mapped from each cursor's root page through
 * `sqlite_master`: a view reads as its base tables, an alias cannot rename a table (the query plan
 * would print `SCAN o` for `orders AS o`), and an index read counts as a read of its table. Root
 * page 1 is `sqlite_master` itself; a cursor on another schema (temp, attached) or a virtual table
 * (`pragma_*`, `dbstat`, `json_each`) is never exposed.
 *
 * With `masked`, also every masked column a cursor on a table or index yields (`Column`), compares
 * (a seek or index range check, so a filter counts) or reads as the rowid. Values the statement
 * derives from those reads live in other cursors and registers, so an alias or an expression
 * cannot hide the column it started from.
 */
function bytecodeReads(
  db: Pick<Database, "prepare">,
  query: string,
  masked?: (column: string) => boolean,
): BytecodeReads {
  const pages = new Map<number, CatalogEntry>([
    [1, { type: "table", name: "sqlite_master", table: "sqlite_master", sql: null }],
  ])
  const catalog = db
    .prepare<CatalogEntry & { rootpage: number | bigint }, []>(
      'SELECT type, name, tbl_name AS "table", rootpage, sql FROM sqlite_master WHERE rootpage > 0',
    )
    .all()
  for (const entry of catalog) pages.set(Number(entry.rootpage), entry)
  const program = db.prepare<ProgramStep, []>(`EXPLAIN ${query}`).all()
  const reads = new Set<string>()
  const cursors = new Map<number, CatalogEntry>()
  for (const step of program) {
    if (!READ_OPCODES.has(step.opcode)) continue
    const page = Number(step.p2)
    const entry = Number(step.p3) === 0 ? pages.get(page) : undefined
    if (entry !== undefined && step.opcode !== "VOpen") cursors.set(Number(step.p1), entry)
    reads.add(
      step.opcode === "VOpen"
        ? "<virtual table>"
        : Number(step.p3) === 0
          ? (entry?.table ?? `<root page ${page}>`)
          : `<schema ${step.p3}>`,
    )
  }
  if (masked === undefined) return { tables: [...reads], masked: [] }

  const layouts = new Map<number, CursorLayout>()
  const layoutOf = (cursor: number): CursorLayout | undefined => {
    const entry = cursors.get(cursor)
    if (entry === undefined || entry.name === "sqlite_master") return undefined
    let layout = layouts.get(cursor)
    if (layout === undefined) {
      layout = cursorLayout(db, entry)
      layouts.set(cursor, layout)
    }
    return layout
  }
  const hits = new Set<string>()
  const read = (layout: CursorLayout, names: readonly string[]): void => {
    for (const name of names) if (masked(name)) hits.add(`${layout.table}.${name}`)
  }
  for (const step of program) {
    const layout = layoutOf(Number(step.p1))
    if (layout === undefined) continue
    if (step.opcode === "Column") read(layout, layout.fields[Number(step.p2)] ?? [])
    else if (KEY_COMPARE_OPCODES.has(step.opcode)) {
      const count = Number(step.p4)
      const compared = Number.isInteger(count) && count > 0 ? count : layout.keyCount
      for (const field of layout.fields.slice(0, compared)) read(layout, field)
    } else if (ROWID_OPCODES.has(step.opcode) && layout.rowid !== undefined) {
      read(layout, [layout.rowid])
    }
  }
  return { tables: [...reads], masked: [...hits] }
}

/**
 * Run one read-only query: the statement gates, the check that every table its bytecode opens is
 * exposed (every table and view minus `exclude`), the refusal of any column `redaction.column`
 * masks that the bytecode reads in any form, then at most `maxRows + 1` rows through
 * {@link shapeRows}. Synchronous: run it where the caller can stop the process (the CLI runs each
 * call in its own subprocess, killed at the deadline).
 */
export function querySqlite(
  db: Pick<Database, "prepare">,
  sql: string,
  options: SqliteQueryOptions,
): DbRows | DbRefusal {
  const verified = verifySqlite(db, sql, options.exclude, options.redaction?.column)
  if (!("ok" in verified)) return verified
  try {
    const statement = db.prepare(boundedSqliteQuery(verified.query, options.maxRows))
    const rows = statement.values()
    const columns = [...statement.columnNames]
    statement.finalize()
    return shapeRows(columns, rows, options)
  } catch (error) {
    return sqliteFailure(error, "query failed")
  }
}

/** `EXPLAIN QUERY PLAN` for one statement, after the same gates as {@link querySqlite}. */
export function explainSqlite(
  db: Pick<Database, "prepare">,
  sql: string,
  options: Pick<SqliteQueryOptions, "exclude" | "maxResultBytes">,
): DbPlan | DbRefusal {
  const verified = verifySqlite(db, sql, options.exclude)
  if (!("ok" in verified)) return verified
  try {
    const plan = db
      .prepare<{ id: number | bigint; parent: number | bigint; detail: string }, []>(
        `EXPLAIN QUERY PLAN ${verified.query}`,
      )
      .all()
    const steps = plan.map(({ id, parent, detail }) => ({
      id: Number(id),
      parent: Number(parent),
      detail,
    }))
    const fit = fitToBytes(steps.length, (shown) => steps.slice(0, shown), options.maxResultBytes)
    return {
      plan: fit?.value ?? [],
      analyzed: false,
      truncated: (fit?.shown ?? 0) < steps.length,
    }
  } catch (error) {
    return sqliteFailure(error, "query failed to plan")
  }
}

const quoteSqliteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

interface SqliteColumnRow {
  readonly name: string
  readonly type: string
  readonly required: number | bigint
  readonly dflt: string | null
  readonly pk: number | bigint
}

interface SqliteForeignKeyRow {
  readonly id: number | bigint
  readonly ref: string
  readonly col: string
  readonly refcol: string | null
}

/** Options for {@link readSqliteSchema}. */
export interface SqliteSchemaOptions {
  readonly exclude?: readonly string[]
  /** Describe only this table or view. */
  readonly table?: string | undefined
  readonly redaction?: DbRedaction
}

/**
 * Describe the exposed tables and views from SQLite's own catalog (`sqlite_master` and the
 * `pragma_*` table functions, each bound by parameter): columns, primary key, foreign keys, indexes,
 * and a row count per table.
 */
export function readSqliteSchema(
  db: Pick<Database, "prepare">,
  options: SqliteSchemaOptions = {},
): DbSchemaReport | DbRefusal {
  const excluded = new Set((options.exclude ?? []).map((name) => name.toLowerCase()))
  const wanted = options.table?.toLowerCase()
  let entries: { name: string; type: "table" | "view" }[]
  try {
    entries = db
      .prepare<{ name: string; type: "table" | "view" }, []>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all()
  } catch (error) {
    return sqliteFailure(error, "could not read the schema")
  }
  const exposed = entries.filter((entry) => !excluded.has(entry.name.toLowerCase()))
  if (wanted !== undefined && !exposed.some((entry) => entry.name.toLowerCase() === wanted)) {
    return dbRefusal(
      "NIFRA_DB_TABLE_EXCLUDED",
      `${JSON.stringify(options.table)} is not an exposed table or view of this database`,
    )
  }
  const text = (value: string): string => options.redaction?.text?.(value) ?? value
  const tables: DbSchemaTable[] = []
  try {
    for (const entry of exposed) {
      if (wanted !== undefined && entry.name.toLowerCase() !== wanted) continue
      const columns = db
        .prepare<SqliteColumnRow, [string]>(
          'SELECT name, type, "notnull" AS required, dflt_value AS dflt, pk FROM pragma_table_info(?) ORDER BY cid',
        )
        .all(entry.name)
      const keys = db
        .prepare<SqliteForeignKeyRow, [string]>(
          'SELECT id, "table" AS ref, "from" AS col, "to" AS refcol FROM pragma_foreign_key_list(?) ORDER BY id, seq',
        )
        .all(entry.name)
      const foreignKeys = new Map<number, { columns: string[]; table: string; refs: string[] }>()
      for (const key of keys) {
        const id = Number(key.id)
        const fk = foreignKeys.get(id) ?? { columns: [], table: key.ref, refs: [] }
        fk.columns.push(key.col)
        if (key.refcol !== null) fk.refs.push(key.refcol)
        foreignKeys.set(id, fk)
      }
      const indexes = db
        .prepare<{ name: string; uniq: number | bigint }, [string]>(
          'SELECT name, "unique" AS uniq FROM pragma_index_list(?) ORDER BY seq',
        )
        .all(entry.name)
        .map((index) => ({
          name: index.name,
          unique: Number(index.uniq) === 1,
          columns: db
            .prepare<{ name: string | null }, [string]>(
              "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
            )
            .all(index.name)
            .map((column) => column.name ?? "<expression>"),
        }))
      let rowEstimate: number | null = null
      if (entry.type === "table") {
        // nifra-expect sql-dynamic: the table name comes from sqlite_master, quoted as an identifier
        const counted = db
          .prepare<{ n: number | bigint }, []>(
            `SELECT count(*) AS n FROM ${quoteSqliteIdentifier(entry.name)}`,
          )
          .all()
        rowEstimate = counted[0] === undefined ? null : Number(counted[0].n)
      }
      tables.push({
        name: entry.name,
        kind: entry.type,
        rowEstimate,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type,
          nullable: Number(column.required) === 0 && Number(column.pk) === 0,
          default: column.dflt === null ? null : text(column.dflt),
          primaryKey: Number(column.pk) > 0,
          redacted: options.redaction?.column?.(column.name) === true,
        })),
        foreignKeys: [...foreignKeys.values()].map((fk) => ({
          columns: fk.columns,
          references: { table: fk.table, columns: fk.refs },
        })),
        indexes,
      })
    }
  } catch (error) {
    return sqliteFailure(error, "could not read the schema")
  }
  return { tables, excludedCount: entries.length - exposed.length }
}
