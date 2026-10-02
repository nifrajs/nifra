/**
 * What both database engines share and the MCP layer reuses: the refusal codes, the SQLite statement
 * gates, the caps and the JSON-safe result shape. No runtime imports, so `@nifrajs/mcp-db` itself
 * stays free of `node:*` modules; `engine.ts` re-exports all of it.
 */

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

// ---------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------

/** Every reason a database call is refused or fails, as a stable code. */
export type DbRefusalCode =
  | "NIFRA_DB_NOT_DECLARED"
  | "NIFRA_DB_CONFIG"
  | "NIFRA_DB_OUTSIDE_ROOT"
  | "NIFRA_DB_REMOTE_HOST"
  | "NIFRA_DB_SUPERUSER"
  | "NIFRA_DB_EXTENSION"
  | "NIFRA_DB_QUERY_OFF"
  | "NIFRA_DB_WRITE_REFUSED"
  | "NIFRA_DB_FUNCTION_REFUSED"
  | "NIFRA_DB_TABLE_EXCLUDED"
  | "NIFRA_DB_TIMEOUT"
  | "NIFRA_DB_QUERY_FAILED"
  | "NIFRA_DB_DRIVER"

/** A refused or failed call: what happened, the fix, and its anchor under `https://nifra.dev/docs/`. */
export interface DbRefusal {
  readonly code: DbRefusalCode
  readonly message: string
  readonly fix: string
  readonly docsAnchor: string
}

const REFUSAL_FIXES: Readonly<Record<DbRefusalCode, string>> = {
  NIFRA_DB_NOT_DECLARED:
    'Export devDatabase from nifra.config.ts, e.g. export const devDatabase = { kind: "sqlite", file: "./data/app.db" }. nifra never reads DATABASE_URL on its own.',
  NIFRA_DB_CONFIG:
    "Correct the devDatabase field the message names. Unknown fields are refused, so a misspelled guard cannot silently drop out.",
  NIFRA_DB_OUTSIDE_ROOT:
    "Keep the database file inside the project, or list its path in devDatabase.allowFiles.",
  NIFRA_DB_REMOTE_HOST:
    "Point devDatabase.url at a local database (localhost, 127.0.0.1, ::1, *.localhost or a unix socket), or name the host in devDatabase.allowHosts.",
  NIFRA_DB_SUPERUSER:
    "Connect as a read-only role: run `nifra db role`, apply the SQL it prints, and use that role in devDatabase.url. `nifra db schema` keeps working meanwhile.",
  NIFRA_DB_EXTENSION:
    "Connect as a role that cannot use the extension or language, or name it in devDatabase.allowExtensions to accept that a query can reach outside this database.",
  NIFRA_DB_QUERY_OFF:
    "devDatabase.query is false. Remove it to allow read-only queries, or use `nifra db schema`.",
  NIFRA_DB_WRITE_REFUSED:
    "Send one read-only SELECT (or WITH ... SELECT). Writes, DDL, CALL, DO, COPY and several statements at once are refused.",
  NIFRA_DB_FUNCTION_REFUSED:
    "Remove the named function: it reaches outside a read-only query (server files, other sessions, settings, locks, sequences, notifications or another database).",
  NIFRA_DB_TABLE_EXCLUDED:
    "The query reads a relation the declaration does not expose: a table in devDatabase.exclude, a system catalog, a schema outside the allowed ones, or a name that does not exist. Run `nifra db schema` for what is exposed.",
  NIFRA_DB_TIMEOUT:
    "Narrow the query (a WHERE clause, an index, a LIMIT) or raise devDatabase.timeoutMs.",
  NIFRA_DB_QUERY_FAILED: "The database rejected the statement. Correct the SQL and retry.",
  NIFRA_DB_DRIVER:
    "Check that the database is running and that devDatabase points at it. The message carries the driver's error.",
}

/** Build a {@link DbRefusal} for `code` with its fix and docs anchor. */
export function dbRefusal(code: DbRefusalCode, message: string): DbRefusal {
  return {
    code,
    message,
    fix: REFUSAL_FIXES[code],
    docsAnchor: `agents#${code
      .toLowerCase()
      .replace(/^nifra_/, "")
      .replaceAll("_", "-")}`,
  }
}

/** True for a value {@link dbRefusal} built. */
export function isDbRefusal(value: unknown): value is DbRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    Object.hasOwn(REFUSAL_FIXES, value.code) &&
    "message" in value &&
    typeof value.message === "string"
  )
}

// ---------------------------------------------------------------------------------------------------
// Statement gates
// ---------------------------------------------------------------------------------------------------

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
  const relationAt = (
    index: number,
  ): { readonly name: string; readonly next: number } | undefined => {
    const first = tokens[index]
    if (first === undefined || first.kind !== "word") return undefined // `FROM (subquery)` - nothing to name here
    // A qualified reference names the table second; an unqualified one names it first.
    const qualified = tokens[index + 1]?.value === "." && tokens[index + 2]?.kind === "word"
    const table = qualified ? (tokens[index + 2] as SqlToken).value : first.value
    return { name: table.toLowerCase(), next: qualified ? index + 3 : index + 1 }
  }
  const addRelation = (index: number): number | undefined => {
    const relation = relationAt(index)
    if (relation === undefined) return undefined
    if (relation.name !== "" && !ctes.has(relation.name)) names.push(relation.name)
    return relation.next
  }
  // Comma joins are part of the FROM table-source grammar but do not have a JOIN keyword. Walk the
  // source list after every FROM and collect each top-level comma operand. The walk is deliberately
  // conservative: an uncertain token is left for SQLite's plan check, while an apparent relation is
  // always added so an alias cannot hide an unexposed table.
  const clauseBoundary = new Set([
    "where",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "union",
    "except",
    "intersect",
    "window",
    "returning",
  ])
  for (let i = 0; i < tokens.length; i++) {
    const from = isKeyword(tokens[i], "from")
    const join = isKeyword(tokens[i], "join")
    if (!from && !join) continue
    const next = addRelation(i + 1)
    if (join || next === undefined) continue
    let depth = 0
    for (let j = next; j < tokens.length; j++) {
      const token = tokens[j]
      if (token === undefined) break
      if (token.value === "(") {
        depth++
        continue
      }
      if (token.value === ")") {
        if (depth === 0) break
        depth--
        continue
      }
      if (depth !== 0) continue
      if (token.bare && clauseBoundary.has(token.value.toLowerCase())) break
      if (token.value !== ",") continue
      // A comma at the source-list level is another table reference. If it is a subquery, the nested
      // FROM scan below still finds its base tables; no relation is inferred from the opening paren.
      const afterComma = addRelation(j + 1)
      if (afterComma !== undefined) j = afterComma - 1
    }
  }
  return [...new Set(names)]
}

/** Reject multi-statement input: allow one terminator only when it is the final character. */
/**
 * Names a statement defines as CTEs, column lists included (`WITH RECURSIVE c(x) AS (...)`), which
 * {@link gateSqliteStatement}'s relation scan does not see past. Only for callers whose own check of
 * the compiled statement is the authority on real tables: a CTE that reads a table still opens it.
 */
export function sqliteCteNames(sql: string): string[] {
  const tokens = tokenizeSql(stripSqlNoise(sql))
  const names = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i]
    if (name?.kind !== "word") continue
    let j = i + 1
    if (tokens[j]?.value === "(" && tokens[j]?.kind === "punct") {
      let depth = 0
      for (; j < tokens.length; j++) {
        const value = tokens[j]?.kind === "punct" ? tokens[j]?.value : undefined
        if (value === "(") depth++
        else if (value === ")" && --depth === 0) break
      }
      j++
    }
    if (!isKeyword(tokens[j], "as")) continue
    j++
    if (isKeyword(tokens[j], "not")) j++
    if (isKeyword(tokens[j], "materialized")) j++
    if (tokens[j]?.value === "(" && tokens[j]?.kind === "punct") names.add(name.value.toLowerCase())
  }
  return [...names]
}

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

/** The outcome of {@link gateSqliteStatement}. A refusal's `text` is the message `run_query` returns. */
export type SqliteGate =
  | { readonly ok: true; readonly query: string }
  | {
      readonly ok: false
      readonly reason: "empty" | "multiple" | "not-read" | "unexposed"
      readonly text: string
      readonly relation?: string
    }

/**
 * Gate one statement before SQLite sees it: non-empty, a single statement, SELECT/WITH only, and every
 * relation it names after `FROM`/`JOIN` exposed. Returns the statement without its terminator, ready
 * to wrap. Relation names are checked here as well as in the plan because SQLite's plan names an
 * alias as the scan target (`users AS habits` plans as `SCAN habits`).
 */
export function gateSqliteStatement(
  input: string,
  exposed: (relation: string) => boolean,
): SqliteGate {
  const sql = input.trim()
  if (sql === "") return { ok: false, reason: "empty", text: "empty query" }
  if (!isSingleStatement(sql)) {
    return { ok: false, reason: "multiple", text: "only a single statement is allowed" }
  }
  if (!isReadStatement(sql)) {
    return {
      ok: false,
      reason: "not-read",
      text: "only SELECT (or WITH…SELECT) statements are allowed",
    }
  }
  const query = executableSql(sql)
  for (const relation of relationNames(query)) {
    if (!exposed(relation)) {
      return {
        ok: false,
        reason: "unexposed",
        relation,
        text: `query touches ${JSON.stringify(relation)}, which is not exposed`,
      }
    }
  }
  return { ok: true, query }
}

/**
 * The first relation an `EXPLAIN QUERY PLAN` result scans or searches that `exposed` rejects, as the
 * plan spells it, or `undefined` when every scanned relation is exposed.
 */
export function unexposedPlanRelation(
  planRows: readonly { readonly detail?: unknown }[],
  exposed: (relation: string) => boolean,
): string | undefined {
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
      if (!exposed(relation)) return match[1]
    }
  }
  return undefined
}

/** Wrap a gated query so SQLite materializes at most one row beyond `maxRows`. */
export function boundedSqliteQuery(query: string, maxRows: number): string {
  // nifra-expect sql-dynamic: wraps a query already through gateSqliteStatement in a bounding subselect; it runs on a query-only connection
  return `SELECT * FROM (${query}) AS "__nifra_result" LIMIT ${maxRows + 1}`
}

/** Wrap a gated query to count its rows (re-executes it). */
export function countSqliteQuery(query: string): string {
  // nifra-expect sql-dynamic: wraps a query already through gateSqliteStatement in a counting subselect; it runs on a query-only connection
  return `SELECT count(*) AS "__nifra_total" FROM (${query}) AS "__nifra_count"`
}

// ---------------------------------------------------------------------------------------------------
// Caps and result shape
// ---------------------------------------------------------------------------------------------------

/**
 * Serialize `build(shown)` for the largest `shown <= count` (halving from `count`) whose JSON fits
 * `maxBytes`. `undefined` when even `build(0)` does not fit.
 */
export function fitToBytes<T>(
  count: number,
  build: (shown: number) => T,
  maxBytes: number,
): { readonly value: T; readonly serialized: string; readonly shown: number } | undefined {
  const encoder = new TextEncoder()
  let shown = count
  let value = build(shown)
  let serialized = JSON.stringify(value)
  while (encoder.encode(serialized).byteLength > maxBytes && shown > 0) {
    shown = Math.max(0, Math.floor(shown / 2))
    value = build(shown)
    serialized = JSON.stringify(value)
  }
  if (encoder.encode(serialized).byteLength > maxBytes) return undefined
  return { value, serialized, shown }
}

/** What keeps secrets out of a result: which columns to mask, and how to scrub text. */
export interface DbRedaction {
  /** True for a column (or a key inside a JSON value) whose values must not leave the process. */
  readonly column?: (name: string) => boolean
  /** Scrub one string value: key formats, tokens, environment values. */
  readonly text?: (value: string) => string
}

/** The value a masked cell carries. */
export const REDACTED_CELL = "[redacted]"

const MAX_CELL_DEPTH = 32
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * One database value as JSON: bytes become `<n bytes>`, a bigint outside the safe range a string,
 * a date an ISO string, a non-finite number a string. Strings go through `redaction.text`, and a
 * key inside a JSON value that `redaction.column` matches is masked.
 */
export function toJsonCell(value: unknown, redaction: DbRedaction = {}, depth = 0): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case "string":
      return redaction.text === undefined ? value : redaction.text(value)
    case "number":
      return Number.isFinite(value) ? value : String(value)
    case "bigint":
      return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString()
    case "boolean":
      return value
    case "object":
      break
    default:
      return String(value)
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return `<${value.byteLength} bytes>`
  }
  if (depth >= MAX_CELL_DEPTH) return "[nested]"
  if (Array.isArray(value)) return value.map((item) => toJsonCell(item, redaction, depth + 1))
  // Null prototype: a `__proto__` key in database JSON stays an ordinary key.
  const out: Record<string, unknown> = Object.create(null)
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      item !== null && redaction.column?.(key) === true
        ? REDACTED_CELL
        : toJsonCell(item, redaction, depth + 1)
  }
  return out
}

/** Options for {@link shapeRows}. */
export interface ShapeRowsOptions {
  readonly maxRows: number
  readonly maxResultBytes: number
  readonly redaction?: DbRedaction
}

/** Rows ready to leave the process: capped, masked and JSON-safe. */
export interface DbRows {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly unknown[])[]
  readonly rowCount: number
  /** More rows exist than `rows` carries (the row cap or the byte cap cut them). */
  readonly truncated: boolean
  /** Columns whose values were replaced by {@link REDACTED_CELL}. */
  readonly redactedColumns: readonly string[]
}

/**
 * Cap, mask and normalize rows fetched as arrays (at most `maxRows + 1`, so truncation is known
 * without counting). The byte cap halves the row count until the JSON fits.
 */
export function shapeRows(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: ShapeRowsOptions,
): DbRows {
  const redaction = options.redaction ?? {}
  const masked = columns.map((column) => redaction.column?.(column) === true)
  const kept = rows.slice(0, options.maxRows)
  const cells = kept.map((row) =>
    row.map((value, index) =>
      masked[index] === true
        ? value === null || value === undefined
          ? null
          : REDACTED_CELL
        : toJsonCell(value, redaction),
    ),
  )
  const fit = fitToBytes(
    cells.length,
    (shown) => ({ columns, rows: cells.slice(0, shown) }),
    options.maxResultBytes,
  )
  const shown = fit?.shown ?? 0
  return {
    columns,
    rows: cells.slice(0, shown),
    rowCount: shown,
    truncated: rows.length > options.maxRows || shown < cells.length,
    redactedColumns: columns.filter((_, index) => masked[index] === true),
  }
}

/** A plan for a statement, as the engine reports it. */
export interface DbPlan {
  readonly plan: unknown
  /** True when the plan carries actual timings (Postgres `EXPLAIN ANALYZE`). */
  readonly analyzed: boolean
  readonly truncated: boolean
}

/** A column in {@link DbSchemaTable}. */
export interface DbSchemaColumn {
  readonly name: string
  readonly type: string
  readonly nullable: boolean
  readonly default: string | null
  readonly primaryKey: boolean
  /** Query results mask this column's values. */
  readonly redacted: boolean
}

/** A foreign key in {@link DbSchemaTable}. */
export interface DbSchemaForeignKey {
  readonly columns: readonly string[]
  readonly references: {
    readonly schema?: string
    readonly table: string
    readonly columns: readonly string[]
  }
}

/** An index in {@link DbSchemaTable}. */
export interface DbSchemaIndex {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
}

/** One exposed table or view. */
export interface DbSchemaTable {
  readonly schema?: string
  readonly name: string
  readonly kind: "table" | "view" | "materialized view" | "foreign table" | "partitioned table"
  /** Rows, estimated by the engine's statistics; `null` when it keeps none. */
  readonly rowEstimate: number | null
  readonly columns: readonly DbSchemaColumn[]
  readonly foreignKeys: readonly DbSchemaForeignKey[]
  readonly indexes: readonly DbSchemaIndex[]
}

/** The exposed schema, built only from catalog queries the engine writes itself. */
export interface DbSchemaReport {
  readonly tables: readonly DbSchemaTable[]
  /** Relations left out: named in `exclude`, or (Postgres) inheriting from or reading one. */
  readonly excludedCount: number
}
