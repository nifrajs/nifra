/**
 * `@nifrajs/mcp-db/postgres` - a read-only Postgres engine for a development database, on Bun's
 * built-in `Bun.SQL` (no npm driver). Every layer below is enforced on each call, in this order:
 *
 *  1. Host gate ({@link connectPostgres}): loopback, `*.localhost` or a unix socket, else only a host
 *     named in `allowHosts`. Connection fields are passed explicitly, so `DATABASE_URL`/`PG*` in the
 *     environment can never redirect the connection.
 *  2. Role gate: a superuser, a member of a superuser role or of `pg_execute_server_program` /
 *     `pg_read_server_files` / `pg_write_server_files`, or a role that may execute the server-file
 *     functions is refused - a read-only transaction does not stop `COPY ... TO PROGRAM` or
 *     `pg_read_file`. {@link postgresRoleSql} prints the role to use instead.
 *  3. Extension gate: `dblink`, `postgres_fdw`, `file_fdw` or an untrusted language the role can use
 *     is refused unless `allowExtensions` names it - `dblink_exec` writes to another database from a
 *     read-only transaction.
 *  4. Transaction: every connection starts with `default_transaction_read_only=on`; each call runs in
 *     `BEGIN READ ONLY` with `statement_timeout`, `lock_timeout` and
 *     `idle_in_transaction_session_timeout` set locally, and always rolls back.
 *  5. Statement gate: the query goes over the extended protocol (the server refuses a second
 *     statement) as `DECLARE ... NO SCROLL CURSOR` (the server accepts only a query there), and at most
 *     `maxRows + 1` rows are fetched. A tokenizer in front refuses side-effect functions.
 *  6. Table scope: the plan's relations (and every table they inherit from) must sit in the allowed
 *     schemas and outside `exclude`. A function can still read a table internally; hard isolation
 *     comes from the role's grants, which {@link postgresRoleSql} writes with a REVOKE per exclusion.
 *
 *   const target = parsePostgresUrl("postgres://nifra_dev_reader@localhost:5432/app")
 *   const client = connectPostgres(target, { timeoutMs: 5000 })
 *   const rows = await queryPostgres(client, "SELECT status, count(*) FROM orders GROUP BY 1", {
 *     timeoutMs: 5000, maxRows: 100, maxResultBytes: 100 * 1024,
 *   })
 */

import {
  explainThroughServer,
  fetchThroughCursor,
  inReadOnlyTransaction,
  type PgConnection,
  type PlanReads,
  type PlanRelation,
  type PostgresClient,
  records,
} from "./internal/pg-exec.ts"
import { DENIED_FUNCTION_PREFIXES, lintPostgres, withoutTerminator } from "./internal/pg-lexer.ts"
import {
  type DbPlan,
  type DbRedaction,
  type DbRefusal,
  type DbRows,
  type DbSchemaReport,
  type DbSchemaTable,
  dbRefusal,
  fitToBytes,
  isDbRefusal,
  type ShapeRowsOptions,
  shapeRows,
} from "./internal/shared.ts"

export type { PgConnection, PgQuery, PostgresClient } from "./internal/pg-exec.ts"

/** Where to connect, parsed from a `postgres://` URL. */
export interface PostgresTarget {
  /** TCP host; absent for a unix socket. */
  readonly host?: string
  /** Unix socket file path. */
  readonly socket?: string
  readonly port: number
  readonly username: string
  readonly password?: string
  readonly database: string
  readonly tls?: "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full"
}

const SSL_MODES = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"] as const

/**
 * Parse a `postgres://` (or `postgresql://`) URL. Only the host, port, user, password, database and
 * `sslmode` are read - any other parameter (`options=-c ...` included) is ignored, so a URL cannot
 * switch off the read-only session settings.
 */
export function parsePostgresUrl(url: string): PostgresTarget | DbRefusal {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return dbRefusal("NIFRA_DB_CONFIG", "devDatabase.url is not a valid URL")
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return dbRefusal(
      "NIFRA_DB_CONFIG",
      "devDatabase.url must start with postgres:// or postgresql://",
    )
  }
  const params = parsed.searchParams
  const queryHost = params.get("host") ?? undefined
  const host = (queryHost ?? decodeURIComponent(parsed.hostname)).replace(/^\[(.*)\]$/, "$1")
  if (host.includes(",")) {
    return dbRefusal("NIFRA_DB_CONFIG", "devDatabase.url names several hosts; name one")
  }
  const port = Number(parsed.port || params.get("port") || 5432)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return dbRefusal("NIFRA_DB_CONFIG", "devDatabase.url has an invalid port")
  }
  const username = decodeURIComponent(parsed.username) || params.get("user") || "postgres"
  const password = decodeURIComponent(parsed.password) || params.get("password") || undefined
  const database =
    decodeURIComponent(parsed.pathname.replace(/^\//, "")) || params.get("dbname") || username
  const sslmode = params.get("sslmode") ?? undefined
  const tls = SSL_MODES.find((mode) => mode === sslmode)
  if (sslmode !== undefined && tls === undefined) {
    return dbRefusal("NIFRA_DB_CONFIG", `devDatabase.url has an unknown sslmode ${sslmode}`)
  }
  const location =
    host === "" || host.startsWith("/")
      ? { socket: `${host === "" ? "/tmp" : host.replace(/\/$/, "")}/.s.PGSQL.${port}` }
      : { host }
  return {
    ...location,
    port,
    username,
    database,
    ...(password === undefined ? {} : { password }),
    ...(tls === undefined ? {} : { tls }),
  }
}

/** True for `localhost`, `*.localhost`, 127.0.0.0/8 and `::1` (also as an IPv4-mapped address). */
export function isLocalPostgresHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[(.*)\]$/, "$1")
  if (name === "localhost" || name.endsWith(".localhost")) return true
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number)
    return octets.every((octet) => octet <= 255) && octets[0] === 127
  }
  return name === "::1" || name === "0:0:0:0:0:0:0:1"
}

/** Refuse a TCP host that is neither local nor named in `allowHosts`. */
export function postgresHostRefusal(
  target: PostgresTarget,
  allowHosts: readonly string[] = [],
): DbRefusal | undefined {
  if (target.socket !== undefined || target.host === undefined) return undefined
  if (isLocalPostgresHost(target.host)) return undefined
  const host = target.host.toLowerCase()
  if (allowHosts.some((allowed) => allowed.toLowerCase() === host)) return undefined
  return dbRefusal(
    "NIFRA_DB_REMOTE_HOST",
    `${target.host} is not a local host, and devDatabase.allowHosts does not name it`,
  )
}

/** Options for {@link connectPostgres}. */
export interface ConnectPostgresOptions {
  readonly timeoutMs: number
  readonly allowHosts?: readonly string[]
}

/**
 * Open a one-connection `Bun.SQL` client for `target` after the host gate. Every session starts
 * read-only with `standard_conforming_strings` on (the statement tokenizer reads strings that way).
 */
export function connectPostgres(
  target: PostgresTarget,
  options: ConnectPostgresOptions,
): PostgresClient | DbRefusal {
  const refusal = postgresHostRefusal(target, options.allowHosts)
  if (refusal !== undefined) return refusal
  if (typeof Bun === "undefined") {
    return dbRefusal("NIFRA_DB_DRIVER", "the Postgres engine needs Bun (it uses Bun.SQL)")
  }
  return new Bun.SQL({
    adapter: "postgres",
    ...(target.socket === undefined ? { hostname: target.host } : { path: target.socket }),
    port: target.port,
    username: target.username,
    ...(target.password === undefined ? {} : { password: target.password }),
    database: target.database,
    ...(target.tls === undefined ? {} : { tls: target.tls }),
    max: 1,
    bigint: true,
    connectionTimeout: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
    connection: {
      application_name: "nifra-db",
      default_transaction_read_only: "on",
      standard_conforming_strings: "on",
      statement_timeout: options.timeoutMs,
      idle_in_transaction_session_timeout: options.timeoutMs,
    },
  })
}

/** What the role gate and extension gate read about the connected role. */
export interface PostgresRoleReport {
  readonly role: string
  readonly superuser: boolean
  readonly serverVersionNum: number
  /** Superuser roles the role is a member of. */
  readonly superuserRoles: readonly string[]
  /** Server-file and server-program roles the role is a member of. */
  readonly serverRoles: readonly string[]
  /** Server-file functions the role may execute. */
  readonly fileFunctions: readonly string[]
  /** `dblink`, `postgres_fdw`, `file_fdw`: installed and usable by the role. */
  readonly extensions: readonly string[]
  /** Untrusted procedural languages the role can use or call functions in. */
  readonly languages: readonly string[]
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

async function readRole(connection: PgConnection): Promise<PostgresRoleReport> {
  const [row] = records(
    await connection`
    SELECT current_user::text AS role,
      r.rolsuper AS superuser,
      pg_catalog.current_setting('server_version_num')::int AS version,
      to_json(ARRAY(SELECT s.rolname::text FROM pg_catalog.pg_roles s
        WHERE s.rolsuper AND s.rolname <> current_user
          AND pg_catalog.pg_has_role(current_user, s.oid, 'MEMBER') ORDER BY 1)) AS superuser_roles,
      to_json(ARRAY(SELECT p.rolname::text FROM pg_catalog.pg_roles p
        WHERE p.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
          AND pg_catalog.pg_has_role(current_user, p.oid, 'MEMBER') ORDER BY 1)) AS server_roles,
      to_json(ARRAY(SELECT DISTINCT f.proname::text FROM pg_catalog.pg_proc f
        WHERE f.pronamespace = 'pg_catalog'::regnamespace
          AND f.proname IN ('pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export')
          AND pg_catalog.has_function_privilege(f.oid, 'EXECUTE') ORDER BY 1)) AS file_functions,
      to_json(ARRAY(
        SELECT e.extname::text FROM pg_catalog.pg_extension e
        WHERE e.extname = 'dblink' AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_proc p ON p.oid = d.objid
          WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.refclassid = 'pg_catalog.pg_extension'::regclass
            AND d.refobjid = e.oid AND d.deptype = 'e' AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE'))
        UNION
        SELECT w.fdwname::text FROM pg_catalog.pg_foreign_data_wrapper w
        WHERE w.fdwname IN ('postgres_fdw', 'file_fdw') AND (
          pg_catalog.has_foreign_data_wrapper_privilege(w.oid, 'USAGE') OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_foreign_table ft JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver
            WHERE fs.srvfdw = w.oid AND pg_catalog.has_table_privilege(ft.ftrelid, 'SELECT')))
        ORDER BY 1)) AS extensions,
      to_json(ARRAY(SELECT l.lanname::text FROM pg_catalog.pg_language l
        WHERE NOT l.lanpltrusted AND l.lanname NOT IN ('c', 'internal') AND (
          pg_catalog.has_language_privilege(l.oid, 'USAGE') OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_proc p WHERE p.prolang = l.oid
              AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')))
        ORDER BY 1)) AS languages
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  )
  if (row === undefined) throw new Error("the connected role is not in pg_roles")
  return {
    role: String(row.role),
    superuser: row.superuser === true,
    serverVersionNum: Number(row.version),
    superuserRoles: asStrings(row.superuser_roles),
    serverRoles: asStrings(row.server_roles),
    fileFunctions: asStrings(row.file_functions),
    extensions: asStrings(row.extensions),
    languages: asStrings(row.languages),
  }
}

/** Read the connected role's privileges, in a read-only transaction. */
export function inspectPostgresRole(
  client: PostgresClient,
  options: { readonly timeoutMs: number },
): Promise<PostgresRoleReport | DbRefusal> {
  return inReadOnlyTransaction(client, options.timeoutMs, readRole)
}

/** The role gate and the extension gate, as one decision over a {@link PostgresRoleReport}. */
export function postgresRoleRefusal(
  report: PostgresRoleReport,
  options: { readonly allowExtensions?: readonly string[] } = {},
): DbRefusal | undefined {
  const role = JSON.stringify(report.role)
  if (report.superuser) return dbRefusal("NIFRA_DB_SUPERUSER", `role ${role} is a superuser`)
  if (report.superuserRoles.length > 0) {
    return dbRefusal(
      "NIFRA_DB_SUPERUSER",
      `role ${role} is a member of the superuser role ${report.superuserRoles.join(", ")}`,
    )
  }
  if (report.serverRoles.length > 0) {
    return dbRefusal(
      "NIFRA_DB_SUPERUSER",
      `role ${role} is a member of ${report.serverRoles.join(", ")}, which reach server programs or files`,
    )
  }
  if (report.fileFunctions.length > 0) {
    return dbRefusal(
      "NIFRA_DB_SUPERUSER",
      `role ${role} may execute ${report.fileFunctions.join(", ")}, which read or write server files`,
    )
  }
  const allowed = new Set((options.allowExtensions ?? []).map((name) => name.toLowerCase()))
  const usable = [...report.extensions, ...report.languages].filter(
    (name) => !allowed.has(name.toLowerCase()),
  )
  if (usable.length > 0) {
    return dbRefusal(
      "NIFRA_DB_EXTENSION",
      `role ${role} can use ${usable.join(", ")}, which can reach outside this database`,
    )
  }
  return undefined
}

/** Refuse what the tokenizer layer refuses: a non-query, several statements, a denied function. */
export function lintPostgresStatement(sql: string): DbRefusal | undefined {
  const refusal = lintPostgres(sql)
  if (refusal === undefined) return undefined
  return dbRefusal(
    refusal.kind === "function" ? "NIFRA_DB_FUNCTION_REFUSED" : "NIFRA_DB_WRITE_REFUSED",
    refusal.message,
  )
}

/** Which relations a query may read. */
export interface PostgresScope {
  /** Schemas a query may read (default `["public"]`). */
  readonly schemas?: readonly string[]
  /** Tables a query may not read: `name` in any allowed schema, or `schema.name`. */
  readonly exclude?: readonly string[]
}

function scopeMatcher(scope: PostgresScope): (relation: PlanRelation) => string | undefined {
  const schemas = new Set((scope.schemas ?? ["public"]).map((name) => name.toLowerCase()))
  const excluded = new Set((scope.exclude ?? []).map((name) => name.toLowerCase()))
  return ({ schema, name }) => {
    const qualified = `${schema}.${name}`
    if (!schemas.has(schema.toLowerCase())) {
      return `the query reads ${qualified}, outside the allowed schemas (${[...schemas].join(", ")})`
    }
    if (excluded.has(name.toLowerCase()) || excluded.has(qualified.toLowerCase())) {
      return `the query reads ${qualified}, which devDatabase.exclude leaves out`
    }
    return undefined
  }
}

/**
 * The plan-level table check: each relation, and every table it inherits from (partitions too). A
 * `pg_*` function in FROM reads server state the way a catalog does - a system view such as
 * `pg_stat_activity` plans as one once the planner drops its catalog joins - so it is out of scope too.
 * With `masked`, a plan expression that uses a masked column, or a whole row holding one, is refused.
 */
function checkScope(scope: PostgresScope, masked?: (column: string) => boolean) {
  const outOfScope = scopeMatcher(scope)
  return async (connection: PgConnection, reads: PlanReads): Promise<DbRefusal | undefined> => {
    for (const fn of reads.functions) {
      const name = fn.name.toLowerCase()
      if (fn.schema === "pg_catalog" && name.startsWith("pg_")) {
        return dbRefusal(
          "NIFRA_DB_TABLE_EXCLUDED",
          `the query reads server state through ${fn.schema}.${fn.name}(), a system catalog function`,
        )
      }
      if (DENIED_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        return dbRefusal(
          "NIFRA_DB_FUNCTION_REFUSED",
          `the query calls ${fn.schema}.${fn.name}(), which reaches outside a read-only query`,
        )
      }
    }
    const { relations } = reads
    for (const relation of relations) {
      const reason = outOfScope(relation)
      if (reason !== undefined) return dbRefusal("NIFRA_DB_TABLE_EXCLUDED", reason)
    }
    if (relations.length === 0) return undefined
    const ancestors = records(
      await connection`
      WITH RECURSIVE planned AS (
        SELECT pg_catalog.to_regclass(pg_catalog.quote_ident(r.schema) || '.' || pg_catalog.quote_ident(r.name))::oid AS oid
        FROM pg_catalog.json_to_recordset(${[...relations]}::json) AS r(schema text, name text)
      ), up(oid) AS (
        SELECT i.inhparent FROM pg_catalog.pg_inherits i JOIN planned p ON i.inhrelid = p.oid
        UNION
        SELECT i.inhparent FROM pg_catalog.pg_inherits i JOIN up ON i.inhrelid = up.oid
      )
      SELECT n.nspname::text AS schema, c.relname::text AS name
      FROM up JOIN pg_catalog.pg_class c ON c.oid = up.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    )
    for (const row of ancestors) {
      const reason = outOfScope({ schema: String(row.schema), name: String(row.name) })
      if (reason !== undefined) return dbRefusal("NIFRA_DB_TABLE_EXCLUDED", reason)
    }
    if (masked === undefined) return undefined
    const hits = new Set<string>()
    const wholeRows: PlanRelation[] = []
    for (const { relation, column } of reads.columns) {
      if (column === "*") wholeRows.push(relation)
      else if (masked(column)) hits.add(`${relation.name}.${column}`)
    }
    const listed = [...wholeRows, ...reads.outputs.map((output) => output.relation)]
    if (listed.length > 0) {
      const live = new Map<string, string[]>()
      const rows = records(
        await connection`
        SELECT r.schema, r.name, a.attname::text AS column
        FROM pg_catalog.json_to_recordset(${listed}::json) AS r(schema text, name text)
        JOIN pg_catalog.pg_attribute a
          ON a.attrelid = pg_catalog.to_regclass(pg_catalog.quote_ident(r.schema) || '.' || pg_catalog.quote_ident(r.name))
        WHERE a.attnum > 0 AND NOT a.attisdropped`,
      )
      for (const row of rows) {
        const key = `${String(row.schema)}.${String(row.name)}`
        live.set(key, [...(live.get(key) ?? []), String(row.column)])
      }
      const columnsOf = (relation: PlanRelation): readonly string[] =>
        live.get(`${relation.schema}.${relation.name}`) ?? []
      for (const relation of wholeRows) {
        for (const column of columnsOf(relation))
          if (masked(column)) hits.add(`${relation.name}.${column}`)
      }
      for (const output of reads.outputs) {
        const all = columnsOf(output.relation)
        // Every column is the physical target list: the parent's expressions say what it uses.
        if (all.length > 0 && all.every((column) => output.columns.includes(column))) continue
        for (const column of output.columns)
          if (masked(column)) hits.add(`${output.relation.name}.${column}`)
      }
    }
    if (hits.size === 0) return undefined
    return dbRefusal(
      "NIFRA_DB_COLUMN_REFUSED",
      `the query reads ${[...hits].join(", ")}, masked as ${hits.size === 1 ? "a credential" : "credentials"}`,
    )
  }
}

/** Options for {@link queryPostgres}. */
export interface PostgresQueryOptions extends ShapeRowsOptions, PostgresScope {
  readonly timeoutMs: number
  /** Extensions or untrusted languages to accept although the role can use them. */
  readonly allowExtensions?: readonly string[]
}

async function gated<T>(
  client: PostgresClient,
  sql: string,
  options: PostgresQueryOptions,
  work: (connection: PgConnection, statement: string) => Promise<T | DbRefusal>,
): Promise<T | DbRefusal> {
  const linted = lintPostgresStatement(sql)
  if (linted !== undefined) return linted
  return inReadOnlyTransaction(client, options.timeoutMs, async (connection) => {
    const refusal = postgresRoleRefusal(await readRole(connection), options)
    if (refusal !== undefined) return refusal
    return work(connection, withoutTerminator(sql.trim()))
  })
}

/**
 * Run one read-only query through every layer and return capped rows. A column `redaction.column`
 * masks is refused wherever the plan uses it (selected under any alias, inside an expression, in a
 * filter, or within a whole row); a matching result name is masked as well.
 */
export async function queryPostgres(
  client: PostgresClient,
  sql: string,
  options: PostgresQueryOptions,
): Promise<DbRows | DbRefusal> {
  const fetched = await gated(client, sql, options, (connection, statement) =>
    fetchThroughCursor(connection, statement, {
      maxRows: options.maxRows,
      scope: checkScope(options, options.redaction?.column),
    }),
  )
  if (isDbRefusal(fetched)) return fetched
  return shapeRows(fetched.columns, fetched.rows, options)
}

/** Drop plan children below `depth` so an oversized plan still says what its top does. */
function prunePlan(node: unknown, depth: number): unknown {
  if (Array.isArray(node)) return node.map((item) => prunePlan(item, depth))
  if (typeof node !== "object" || node === null) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === "Plans") {
      if (depth > 0) out[key] = prunePlan(value, depth - 1)
    } else out[key] = key === "Plan" ? prunePlan(value, depth) : value
  }
  return out
}

/** `EXPLAIN (FORMAT JSON)` for one query, after the same layers as {@link queryPostgres}. */
export async function explainPostgres(
  client: PostgresClient,
  sql: string,
  options: PostgresQueryOptions & { readonly analyze?: boolean },
): Promise<DbPlan | DbRefusal> {
  const explained = await gated(client, sql, options, (connection, statement) =>
    explainThroughServer(connection, statement, {
      analyze: options.analyze === true,
      scope: checkScope(options),
    }),
  )
  if (isDbRefusal(explained)) return explained
  const full = JSON.stringify(explained.plan)
  if (new TextEncoder().encode(full).byteLength <= options.maxResultBytes) {
    return { plan: explained.plan, analyzed: options.analyze === true, truncated: false }
  }
  const fit = fitToBytes(32, (depth) => prunePlan(explained.plan, depth), options.maxResultBytes)
  return { plan: fit?.value ?? null, analyzed: options.analyze === true, truncated: true }
}

const RELKINDS: Readonly<Record<string, DbSchemaTable["kind"]>> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
}

/** Options for {@link readPostgresSchema}. */
export interface PostgresSchemaOptions extends PostgresScope {
  readonly timeoutMs: number
  /** Describe only this table (`name` or `schema.name`). */
  readonly table?: string | undefined
  readonly redaction?: DbRedaction
}

const jsonValues = (value: unknown): unknown[] => {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
  return Array.isArray(parsed) ? parsed : []
}

const jsonStrings = (value: unknown): string[] => asStrings(jsonValues(value))

/**
 * Describe the readable tables and views in the allowed schemas from `pg_catalog`, with queries this
 * module writes (no caller SQL runs), so it works on any role: columns, primary keys, foreign keys,
 * indexes and the planner's row estimate.
 */
export async function readPostgresSchema(
  client: PostgresClient,
  options: PostgresSchemaOptions,
): Promise<DbSchemaReport | DbRefusal> {
  const schemas = [...(options.schemas ?? ["public"])]
  const excluded = new Set((options.exclude ?? []).map((name) => name.toLowerCase()))
  const isExcluded = (schema: string, name: string): boolean =>
    excluded.has(name.toLowerCase()) || excluded.has(`${schema}.${name}`.toLowerCase())
  const wanted = options.table?.toLowerCase()
  const matchesWanted = (schema: string, name: string): boolean =>
    wanted === undefined ||
    name.toLowerCase() === wanted ||
    `${schema}.${name}`.toLowerCase() === wanted
  return inReadOnlyTransaction(client, options.timeoutMs, async (connection) => {
    const relations = records(
      await connection`
      SELECT n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS kind,
        c.reltuples::float8 AS estimate,
        to_json(ARRAY(
          WITH RECURSIVE reach(oid) AS (
            SELECT c.oid
            UNION
            SELECT next.oid FROM reach, LATERAL (
              SELECT i.inhparent AS oid FROM pg_catalog.pg_inherits i WHERE i.inhrelid = reach.oid
              UNION ALL
              SELECT d.refobjid FROM pg_catalog.pg_rewrite w
              JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass
                AND d.objid = w.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass
              WHERE w.ev_class = reach.oid
            ) AS next
          )
          SELECT pg_catalog.json_build_array(pn.nspname::text, pc.relname::text) FROM reach
          JOIN pg_catalog.pg_class pc ON pc.oid = reach.oid
          JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
          WHERE reach.oid <> c.oid)) AS reaches
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
        AND n.nspname = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${schemas}::json)))
        AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
      ORDER BY 1, 2`,
    )
    const columns = records(
      await connection`
      SELECT n.nspname::text AS schema, c.relname::text AS table, a.attname::text AS name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
        EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
          WHERE k.conrelid = c.oid AND k.contype = 'p' AND a.attnum = ANY(k.conkey)) AS primary_key
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${schemas}::json)))
      ORDER BY 1, 2, a.attnum`,
    )
    const foreignKeys = records(
      await connection`
      SELECT n.nspname::text AS schema, c.relname::text AS table,
        to_json(ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY AS u(num, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num ORDER BY u.ord)) AS columns,
        fn.nspname::text AS ref_schema, fc.relname::text AS ref_table,
        to_json(ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY AS u(num, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.num ORDER BY u.ord)) AS ref_columns
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_class fc ON fc.oid = k.confrelid
      JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE k.contype = 'f'
        AND n.nspname = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${schemas}::json)))
      ORDER BY 1, 2, k.conname`,
    )
    const indexes = records(
      await connection`
      SELECT n.nspname::text AS schema, t.relname::text AS table, i.relname::text AS name,
        x.indisunique AS is_unique,
        to_json(ARRAY(SELECT pg_catalog.pg_get_indexdef(x.indexrelid, k, true)
          FROM generate_series(1, x.indnkeyatts) AS k ORDER BY k)) AS columns
      FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
      JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${schemas}::json)))
      ORDER BY 1, 2, 3`,
    )
    const key = (schema: unknown, name: unknown): string => `${String(schema)}.${String(name)}`
    const text = (value: string): string => options.redaction?.text?.(value) ?? value
    // What the query scope would refuse is hidden too: a table inheriting from an excluded one, and a
    // view reading one (or reading outside the allowed schemas).
    const allowedSchemas = new Set(schemas.map((name) => name.toLowerCase()))
    const outOfScope = (ancestor: unknown): boolean => {
      const [schema, name] = asStrings(ancestor)
      return (
        schema === undefined ||
        name === undefined ||
        !allowedSchemas.has(schema.toLowerCase()) ||
        isExcluded(schema, name)
      )
    }
    const visible = relations.filter(
      (row) =>
        !isExcluded(String(row.schema), String(row.name)) &&
        !jsonValues(row.reaches).some(outOfScope),
    )
    const shown = visible.filter((row) => matchesWanted(String(row.schema), String(row.name)))
    if (wanted !== undefined && shown.length === 0) {
      return dbRefusal(
        "NIFRA_DB_TABLE_EXCLUDED",
        `${JSON.stringify(options.table)} is not an exposed table or view of this database`,
      )
    }
    const tables: DbSchemaTable[] = shown.map((row) => {
      const id = key(row.schema, row.name)
      const kind = RELKINDS[String(row.kind)] ?? "table"
      const estimate = Number(row.estimate)
      return {
        schema: String(row.schema),
        name: String(row.name),
        kind,
        rowEstimate:
          kind === "view" || !Number.isFinite(estimate) || estimate < 0
            ? null
            : Math.round(estimate),
        columns: columns
          .filter((column) => key(column.schema, column.table) === id)
          .map((column) => ({
            name: String(column.name),
            type: String(column.type),
            nullable: column.nullable === true,
            default: typeof column.default_value === "string" ? text(column.default_value) : null,
            primaryKey: column.primary_key === true,
            redacted: options.redaction?.column?.(String(column.name)) === true,
          })),
        foreignKeys: foreignKeys
          .filter((fk) => key(fk.schema, fk.table) === id)
          .map((fk) => ({
            columns: jsonStrings(fk.columns),
            references: {
              schema: String(fk.ref_schema),
              table: String(fk.ref_table),
              columns: jsonStrings(fk.ref_columns),
            },
          })),
        indexes: indexes
          .filter((index) => key(index.schema, index.table) === id)
          .map((index) => ({
            name: String(index.name),
            unique: index.is_unique === true,
            columns: jsonStrings(index.columns),
          })),
      }
    })
    return { tables, excludedCount: relations.length - visible.length }
  })
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Options for {@link postgresRoleSql}. */
export interface PostgresRoleSqlOptions extends PostgresScope {
  readonly timeoutMs: number
  /** The role to create (default `nifra_dev_reader`). */
  readonly role?: string
}

/** The SQL that creates a read-only role for this database, for the developer to run themselves. */
export interface PostgresRoleSql {
  readonly role: string
  readonly database: string
  readonly serverVersionNum: number
  readonly statements: readonly string[]
}

/**
 * Write the SQL for a login role that can read the allowed schemas and nothing else: `pg_read_all_data`
 * on Postgres 14+ when nothing is excluded; otherwise `GRANT SELECT` per schema plus default
 * privileges, and a `REVOKE` for each excluded table and its partitions (`pg_read_all_data` would
 * override a REVOKE, so it is not used then). Nothing is executed.
 */
export async function postgresRoleSql(
  client: PostgresClient,
  options: PostgresRoleSqlOptions,
): Promise<PostgresRoleSql | DbRefusal> {
  const role = options.role ?? "nifra_dev_reader"
  const schemas = options.schemas ?? ["public"]
  const exclude = (options.exclude ?? []).map((name) => name.toLowerCase())
  return inReadOnlyTransaction(client, options.timeoutMs, async (connection) => {
    const [facts] = records(
      await connection`
      SELECT pg_catalog.current_database()::text AS database,
        pg_catalog.current_setting('server_version_num')::int AS version`,
    )
    const excluded =
      exclude.length === 0
        ? []
        : records(
            await connection`
      WITH RECURSIVE picked AS (
        SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${[...schemas]}::json)))
          AND (lower(c.relname) = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${exclude}::json)))
            OR lower(n.nspname || '.' || c.relname) = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${exclude}::json))))
        UNION
        SELECT i.inhrelid FROM pg_catalog.pg_inherits i JOIN picked p ON i.inhparent = p.oid
      )
      SELECT n.nspname::text AS schema, c.relname::text AS name
      FROM picked JOIN pg_catalog.pg_class c ON c.oid = picked.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      ORDER BY 1, 2`,
          )
    const database = String(facts?.database ?? "")
    const version = Number(facts?.version ?? 0)
    const who = quoteIdent(role)
    const statements = [
      `-- Run as the owner of the app's tables (or a superuser). Then set the password from psql with \\password ${role}`,
      `-- and point devDatabase.url at postgres://${role}:<password>@localhost/${database}`,
      `CREATE ROLE ${who} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
      `ALTER ROLE ${who} SET default_transaction_read_only = on;`,
      `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${who};`,
    ]
    if (version >= 140000 && excluded.length === 0) {
      statements.push(`GRANT pg_read_all_data TO ${who};`)
    } else {
      for (const schema of schemas) {
        statements.push(
          `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${who};`,
          `GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${who};`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schema)} GRANT SELECT ON TABLES TO ${who};`,
        )
      }
      for (const row of excluded) {
        statements.push(
          `REVOKE SELECT ON TABLE ${quoteIdent(String(row.schema))}.${quoteIdent(String(row.name))} FROM ${who};`,
        )
      }
    }
    return { role, database, serverVersionNum: version, statements }
  })
}
