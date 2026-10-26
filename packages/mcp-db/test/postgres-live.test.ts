/**
 * Every layer of `@nifrajs/mcp-db/postgres` against a real server.
 *
 * Gate: NIFRA_TEST_POSTGRES_URL, a superuser URL of a THROWAWAY server. The suite creates its own
 * databases and roles (suffixed per run) and drops them afterwards. Without the variable it skips.
 *
 *   docker run -d --rm --name nifra-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:18
 *   NIFRA_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55432/postgres bun test packages/mcp-db
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SQL } from "bun"
import { isDbRefusal } from "../src/engine.ts"
import {
  explainThroughServer,
  extended,
  fetchThroughCursor,
  inReadOnlyTransaction,
  records,
} from "../src/internal/pg-exec.ts"
import { checkScope } from "../src/internal/pg-scope.ts"
import {
  connectPostgres,
  explainPostgres,
  inspectPostgresRole,
  type PostgresClient,
  type PostgresQueryOptions,
  type PostgresTarget,
  parsePostgresUrl,
  postgresRoleRefusal,
  postgresRoleSql,
  queryPostgres,
  readPostgresSchema,
} from "../src/postgres.ts"
import { HOSTILE_CORPUS } from "./fixtures/hostile-corpus.ts"

const ADMIN_URL = process.env.NIFRA_TEST_POSTGRES_URL ?? ""
const SKIP = ADMIN_URL === ""
const SUITE = SKIP
  ? "postgres live (skipped: set NIFRA_TEST_POSTGRES_URL to a superuser URL of a throwaway server)"
  : "postgres live"
if (SKIP) {
  console.info(
    "[mcp-db] Postgres live tests skipped: set NIFRA_TEST_POSTGRES_URL to a superuser URL of a throwaway server",
  )
}

const run = `${process.pid}_${Date.now().toString(36)}`
const DB = `nifra_live_${run}`
const OTHER = `${DB}_other`
const PASSWORD = `live-${crypto.randomUUID()}`
const ROLE = {
  reader: `nifra_live_reader_${run}`,
  weak: `nifra_live_weak_${run}`,
  program: `nifra_live_program_${run}`,
  files: `nifra_live_files_${run}`,
  fileFunction: `nifra_live_filefn_${run}`,
  generated: `nifra_live_generated_${run}`,
  granted: `nifra_live_granted_${run}`,
  group: `nifra_live_group_${run}`,
}
const TIMEOUT_MS = 5_000
const SCOPE = { schemas: ["public"], exclude: ["secrets", "audit"] }
const OPTIONS: PostgresQueryOptions = {
  ...SCOPE,
  timeoutMs: TIMEOUT_MS,
  maxRows: 50,
  maxResultBytes: 64 * 1024,
  // dblink is installed and PUBLIC may execute it; the extension gate has its own test below.
  allowExtensions: ["dblink"],
}
const masked = (name: string) => name === "password_hash"
const LONG_NAME = `volatile_${"x".repeat(54)}`
const MASKED: PostgresQueryOptions = { ...OPTIONS, redaction: { column: masked } }

let admin: PostgresTarget
let hasDblink = false
let serverVersion = 0
const clients: PostgresClient[] = []

function rawClient(database: string): SQL {
  const options: SQL.PostgresOrMySQLOptions = {
    adapter: "postgres",
    hostname: admin.host ?? "127.0.0.1",
    port: admin.port,
    username: admin.username,
    database,
    max: 1,
  }
  if (admin.password !== undefined) options.password = admin.password
  return new SQL(options)
}

async function asOwner(statement: string): Promise<void> {
  const db = rawClient(DB)
  try {
    await db.unsafe(statement)
  } finally {
    await db.close()
  }
}

/** A read-only engine client as `role` (the admin when omitted). */
function engineClient(role?: string, timeoutMs = TIMEOUT_MS): PostgresClient {
  const password = role === undefined ? admin.password : PASSWORD
  const base = { host: admin.host ?? "127.0.0.1", port: admin.port, database: DB }
  const target: PostgresTarget =
    password === undefined
      ? { ...base, username: role ?? admin.username }
      : { ...base, username: role ?? admin.username, password }
  const client = connectPostgres(target, { timeoutMs })
  if (isDbRefusal(client)) throw new Error(client.message)
  clients.push(client)
  return client
}

const code = (value: unknown): string | undefined => (isDbRefusal(value) ? value.code : undefined)

/** A driver error as `SQLSTATE message`. */
const failure = (error: unknown): { state: string; message: string } => ({
  state:
    typeof error === "object" && error !== null && "errno" in error ? String(error.errno) : "?",
  message: error instanceof Error ? error.message : String(error),
})

/**
 * What the server alone does with `sql`: the statement goes through the read-only transaction and
 * the cursor, with the tokenizer, the role gate and the plan scope all bypassed.
 */
async function serverOnly(
  client: PostgresClient,
  sql: string,
): Promise<{ ran: true } | { ran: false; state: string; message: string }> {
  let outcome: { ran: true } | { ran: false; state: string; message: string } | undefined
  const result = await inReadOnlyTransaction(client, 3_000, async (connection) => {
    try {
      await fetchThroughCursor(connection, sql, { maxRows: 5, scope: async () => undefined })
      outcome = { ran: true }
    } catch (error) {
      outcome = { ran: false, ...failure(error) }
    }
    return outcome
  })
  if (outcome !== undefined) return outcome
  return { ran: false, state: "?", message: isDbRefusal(result) ? result.message : String(result) }
}

describe.skipIf(SKIP)(SUITE, () => {
  beforeAll(async () => {
    const parsed = parsePostgresUrl(ADMIN_URL)
    if (isDbRefusal(parsed)) throw new Error(`NIFRA_TEST_POSTGRES_URL: ${parsed.message}`)
    admin = parsed
    const server = rawClient(admin.database)
    try {
      const [version] = await server`SELECT current_setting('server_version_num')::int AS v`
      serverVersion = Number(version?.v)
      await server.unsafe(`CREATE DATABASE "${DB}"`)
      await server.unsafe(`CREATE DATABASE "${OTHER}"`)
      for (const role of Object.values(ROLE)) {
        await server.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${PASSWORD}'`)
      }
      const readAll =
        serverVersion >= 140000
          ? `GRANT pg_read_all_data TO "${ROLE.reader}", "${ROLE.program}"`
          : `SELECT 1`
      await server.unsafe(readAll)
      await server.unsafe(`GRANT pg_execute_server_program TO "${ROLE.program}"`)
      await server.unsafe(`GRANT pg_read_server_files TO "${ROLE.files}"`)
    } finally {
      await server.close()
    }
    const db = rawClient(DB)
    try {
      await db.unsafe(`
        CREATE TABLE orders (id bigserial PRIMARY KEY, status text NOT NULL, total bigint,
          placed timestamptz DEFAULT '2026-01-02T03:04:05Z', blob bytea);
        CREATE TABLE users (id serial PRIMARY KEY, email text, password_hash text, note text);
        CREATE TABLE secrets (id serial PRIMARY KEY, value text);
        CREATE TABLE child_secret (extra int) INHERITS (secrets);
        -- Inheritance two levels down from an excluded table, and a chain beside it that hides nothing.
        CREATE TABLE grand_secret (deeper int) INHERITS (child_secret);
        CREATE TABLE base_open (x int);
        CREATE TABLE kid_open (y int) INHERITS (base_open);
        CREATE VIEW secret_view AS SELECT * FROM secrets;
        CREATE VIEW order_summary AS SELECT status, count(*) AS n FROM orders GROUP BY status;
        CREATE TABLE audit (id int, at date NOT NULL) PARTITION BY RANGE (at);
        CREATE TABLE audit_2026 PARTITION OF audit FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
        CREATE INDEX orders_status ON orders (status);
        CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$;
        CREATE FUNCTION owner_hash(int) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
          AS $$ SELECT password_hash FROM users WHERE id = $1 $$;
        CREATE FUNCTION bump() RETURNS int LANGUAGE sql VOLATILE AS $$ SELECT 1 $$;
        CREATE FUNCTION ${LONG_NAME}() RETURNS int LANGUAGE sql VOLATILE AS $$ SELECT 1 $$;
        CREATE FUNCTION shout(text) RETURNS text LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN upper($1); END $$;
        CREATE VIEW hash_lookup AS SELECT id, owner_hash(id::int) AS h FROM orders;
        -- SECURITY DEFINER code a query reaches without naming it.
        CREATE FUNCTION folded_secret(int) RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
          AS $$ SELECT value FROM secrets LIMIT 1 $$;
        CREATE VIEW folded_view AS SELECT folded_secret(1) AS s;
        CREATE FUNCTION op_secret(int, int) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
          AS $$ SELECT value FROM secrets LIMIT 1 $$;
        CREATE OPERATOR ### (LEFTARG = int, RIGHTARG = int, FUNCTION = op_secret);
        CREATE TYPE boxed AS (a int);
        CREATE FUNCTION boxed_text(boxed) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
          AS $$ SELECT value FROM secrets LIMIT 1 $$;
        CREATE CAST (boxed AS text) WITH FUNCTION boxed_text(boxed);
        CREATE FUNCTION secret_step(text, int) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
          AS $$ SELECT value FROM secrets LIMIT 1 $$;
        CREATE AGGREGATE secret_agg(int) (SFUNC = secret_step, STYPE = text);
        CREATE FUNCTION calls_folded() RETURNS text LANGUAGE sql STABLE AS $$ SELECT folded_secret(1) $$;
        CREATE FUNCTION calls_agg() RETURNS text LANGUAGE sql STABLE
          AS $$ SELECT secret_agg(x) FROM generate_series(1, 2) AS g(x) $$;
        REVOKE EXECUTE ON FUNCTION owner_hash(int), folded_secret(int), op_secret(int, int),
          boxed_text(boxed), secret_step(text, int), secret_agg(int) FROM PUBLIC;
        CREATE SCHEMA private;
        CREATE TABLE private.notes (id int);
        INSERT INTO orders (status, total, blob) VALUES ('paid', 9007199254740993, '\\x0102'), ('open', 5, NULL);
        INSERT INTO users (email, password_hash, note)
          VALUES ('a@example.com', 'hash-value', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl');
        INSERT INTO secrets (value) VALUES ('top secret');
        INSERT INTO audit VALUES (1, '2026-05-01');
        CREATE MATERIALIZED VIEW secret_copy AS SELECT value FROM secrets;
        CREATE MATERIALIZED VIEW hash_copy AS SELECT id, password_hash AS ph FROM users;
        ANALYZE;
      `)
      if (serverVersion < 140000) {
        await db.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${ROLE.reader}"`)
      }
      await db.unsafe(`GRANT EXECUTE ON FUNCTION pg_read_file(text) TO "${ROLE.fileFunction}"`)
      try {
        await db.unsafe("CREATE EXTENSION dblink")
        hasDblink = true
      } catch {
        hasDblink = false
      }
    } finally {
      await db.close()
    }
    // ROLE.granted holds exactly the grants `nifra db role` writes for the masked declaration.
    const role = await postgresRoleSql(engineClient(), {
      ...SCOPE,
      timeoutMs: TIMEOUT_MS,
      role: ROLE.granted,
      redaction: { column: masked },
    })
    if (isDbRefusal(role)) throw new Error(role.message)
    const granting = rawClient(DB)
    try {
      for (const statement of role.statements) {
        if (statement.startsWith("--") || statement.startsWith("CREATE ROLE")) continue
        await granting.unsafe(statement)
      }
    } finally {
      await granting.close()
    }
  })

  afterAll(async () => {
    for (const client of clients) await client.close({ timeout: 0 }).catch(() => {})
    if (admin === undefined) return
    const server = rawClient(admin.database)
    try {
      for (const database of [DB, OTHER]) {
        await server.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      }
      for (const role of Object.values(ROLE)) {
        await server.unsafe(`DROP ROLE IF EXISTS "${role}"`)
      }
    } finally {
      await server.close()
    }
  })

  test("Bun.SQL: unsafe() runs several statements (simple protocol); a template refuses them", async () => {
    const db = rawClient(DB)
    try {
      const connection = await db.reserve()
      try {
        const simple = await connection.unsafe("SELECT 1 AS a; SELECT 2 AS b")
        expect(simple.length).toBeGreaterThan(0)
        const refused = await Promise.resolve(
          extended(connection, "SELECT 1 AS a; SELECT 2 AS b"),
        ).then(() => undefined, failure)
        expect(refused?.state).toBe("42601")
        expect(refused?.message).toContain(
          "cannot insert multiple commands into a prepared statement",
        )
      } finally {
        connection.release()
      }
    } finally {
      await db.close()
    }
  })

  test("every session starts read-only with the timeouts set and JIT off", async () => {
    const client = engineClient(ROLE.reader, 2_500)
    const connection = await client.reserve()
    try {
      const [session] = records(await connection`SHOW default_transaction_read_only`)
      expect(session?.default_transaction_read_only).toBe("on")
      const [standard] = records(await connection`SHOW standard_conforming_strings`)
      expect(standard?.standard_conforming_strings).toBe("on")
    } finally {
      connection.release()
    }
    const inside = await inReadOnlyTransaction(client, 1_234, async (tx) => {
      const [readOnly] = records(await tx`SHOW transaction_read_only`)
      const [timeout] = records(await tx`SHOW statement_timeout`)
      const [jit] = records(await tx`SHOW jit`)
      return {
        readOnly: readOnly?.transaction_read_only,
        timeout: timeout?.statement_timeout,
        jit: jit?.jit,
      }
    })
    expect(inside).toEqual({ readOnly: "on", timeout: "1234ms", jit: "off" })
  })

  test("the cursor accepts only SELECT and VALUES; a data-modifying WITH is refused by the server", async () => {
    const su = engineClient()
    const insert = await serverOnly(su, "INSERT INTO orders (status) VALUES ('x') RETURNING id")
    expect(insert).toMatchObject({ ran: false, state: "42601" })
    const cte = await serverOnly(su, "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d")
    expect(cte).toMatchObject({
      ran: false,
      state: "0A000",
      message: expect.stringContaining("data-modifying"),
    })
    const declared = await inReadOnlyTransaction(su, 3_000, async (connection) => {
      try {
        await extended(
          connection,
          "DECLARE c NO SCROLL CURSOR FOR WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
        )
        return "ran"
      } catch (error) {
        const { state, message } = failure(error)
        return `${state} ${message}`
      }
    })
    expect(String(declared)).toMatch(
      /^0A000 DECLARE CURSOR must not contain data-modifying statements in WITH/,
    )
    expect(await serverOnly(su, "VALUES (1), (2)")).toEqual({ ran: true })
    const [count] = await rawCount("SELECT count(*)::int AS n FROM orders")
    expect(count?.n).toBe(2)
  })

  test("the hostile corpus is refused with the expected code through every layer", async () => {
    const client = engineClient(ROLE.granted)
    const outcomes: Record<string, string | undefined> = {}
    const expected: Record<string, string | undefined> = {}
    for (const entry of HOSTILE_CORPUS) {
      if (entry.postgres === null) continue
      outcomes[entry.name] = code(await queryPostgres(client, entry.sql, OPTIONS))
      expected[entry.name] = entry.postgres
    }
    expect(outcomes).toEqual(expected)
    const [count] = await rawCount("SELECT count(*)::int AS n FROM orders")
    expect(count?.n).toBe(2)
  })

  test("below the gates: what the server alone refuses, and what only the function allowlist stops", async () => {
    const su = engineClient()
    const reader = engineClient(ROLE.reader)
    const refusedBySuperuserServer = [
      "INSERT INTO orders (status) VALUES ('x')",
      "UPDATE orders SET status = 'x'",
      "DELETE FROM orders",
      "CALL p()",
      "DO $$ BEGIN PERFORM 1; END $$",
      "COPY (SELECT 1) TO PROGRAM 'id'",
      "SELECT nextval('orders_id_seq')",
      "SELECT * FROM orders FOR UPDATE",
      "SELECT * INTO orders_copy FROM orders",
      "SELECT set_config('transaction_read_only', 'off', false)",
      "SELECT 1; SELECT 2",
    ]
    for (const sql of refusedBySuperuserServer) {
      expect({ sql, outcome: await serverOnly(su, sql) }).toMatchObject({
        sql,
        outcome: { ran: false },
      })
    }
    // A superuser's read-only transaction still runs these: the function allowlist is what stops them.
    const ranForSuperuser = [
      "SELECT set_config('role', 'postgres', true)",
      "SELECT pg_read_file('PG_VERSION')",
      "SELECT pg_ls_dir('.')",
      "SELECT pg_advisory_lock(42)",
      "SELECT pg_notify('nifra_live', 'x')",
      "SELECT query_to_xml('select * from secrets', true, false, '')",
      "SELECT word FROM ts_stat('SELECT to_tsvector(''simple'', value) FROM secrets')",
      "SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, plainto_tsquery(value) FROM secrets')",
    ]
    const granted = engineClient(ROLE.granted)
    for (const sql of ranForSuperuser) {
      expect({ sql, outcome: await serverOnly(su, sql) }).toEqual({ sql, outcome: { ran: true } })
      expect({ sql, code: code(await queryPostgres(granted, sql, OPTIONS)) }).toEqual({
        sql,
        code: "NIFRA_DB_FUNCTION_REFUSED",
      })
    }
    // A non-superuser role is refused most of them by privileges, but not locks or notifications.
    const readerDenied = [
      "SELECT set_config('role', 'postgres', true)",
      "SELECT pg_read_file('PG_VERSION')",
      "SELECT lo_import('/etc/hosts')",
      "SELECT nextval('orders_id_seq')",
    ]
    for (const sql of readerDenied) {
      expect({ sql, outcome: await serverOnly(reader, sql) }).toMatchObject({
        sql,
        outcome: { ran: false, state: "42501" },
      })
    }
    // The superuser's session lock on 42 outlived its rolled-back transaction: the reader now waits
    // on it until statement_timeout.
    expect(await serverOnly(reader, "SELECT pg_advisory_lock(42)")).toMatchObject({
      ran: false,
      state: "57014",
    })
    for (const sql of ["SELECT pg_advisory_lock(43)", "SELECT pg_notify('nifra_live', 'x')"]) {
      expect({ sql, outcome: await serverOnly(reader, sql) }).toEqual({
        sql,
        outcome: { ran: true },
      })
    }
  })

  test("dblink_exec writes another database from a read-only superuser session; the allowlist refuses it", async () => {
    if (!hasDblink) {
      console.info("[mcp-db live] dblink is not available on this server: dblink checks skipped")
      return
    }
    const su = engineClient()
    const call = `SELECT dblink_exec('dbname=${OTHER}', 'CREATE TABLE pwned (x int)')`
    expect(await serverOnly(su, call)).toEqual({ ran: true })
    const other = rawClient(OTHER)
    try {
      const [made] = await other`SELECT to_regclass('public.pwned')::text AS t`
      expect(made?.t).toBe("pwned")
    } finally {
      await other.close()
    }
    const reader = engineClient(ROLE.reader)
    const readerCall = await serverOnly(reader, call)
    expect(readerCall).toMatchObject({ ran: false, state: "2F003" })
    expect(code(await queryPostgres(engineClient(ROLE.granted), call, OPTIONS))).toBe(
      "NIFRA_DB_FUNCTION_REFUSED",
    )
  })

  test("a query past timeoutMs is cancelled by the server's statement_timeout", async () => {
    const client = engineClient(ROLE.granted, 1_000)
    const started = performance.now()
    const result = await queryPostgres(client, "SELECT count(*) FROM generate_series(1, 1e11)", {
      ...OPTIONS,
      timeoutMs: 1_000,
    })
    expect(code(result)).toBe("NIFRA_DB_TIMEOUT")
    expect(performance.now() - started).toBeLessThan(4_000)
  })

  test("the role gate: superuser, server-program, server-file roles and file functions", async () => {
    const report = async (role?: string) => {
      const value = await inspectPostgresRole(engineClient(role), { timeoutMs: TIMEOUT_MS })
      if (isDbRefusal(value)) throw new Error(value.message)
      return value
    }
    const su = await report()
    expect(su.superuser).toBe(true)
    expect(postgresRoleRefusal(su)?.code).toBe("NIFRA_DB_SUPERUSER")
    expect(code(await queryPostgres(engineClient(), "SELECT 1", OPTIONS))).toBe(
      "NIFRA_DB_SUPERUSER",
    )
    const program = await report(ROLE.program)
    expect(program.serverRoles).toEqual(["pg_execute_server_program"])
    expect(postgresRoleRefusal(program)?.code).toBe("NIFRA_DB_SUPERUSER")
    const files = await report(ROLE.files)
    expect(files.serverRoles).toEqual(["pg_read_server_files"])
    expect(postgresRoleRefusal(files)?.code).toBe("NIFRA_DB_SUPERUSER")
    const fileFunction = await report(ROLE.fileFunction)
    expect(fileFunction.fileFunctions).toEqual(["pg_read_file"])
    expect(postgresRoleRefusal(fileFunction)?.code).toBe("NIFRA_DB_SUPERUSER")
    const reader = await report(ROLE.reader)
    expect(reader).toMatchObject({ superuser: false, serverRoles: [], fileFunctions: [] })
    expect(reader.serverVersionNum).toBe(serverVersion)
  })

  test("the extension gate: a role that can execute dblink is refused unless it is allowed", async () => {
    if (!hasDblink) return
    const reader = engineClient(ROLE.reader)
    const { allowExtensions: _, ...strict } = OPTIONS
    const refused = await queryPostgres(reader, "SELECT 1", strict)
    expect(refused).toMatchObject({
      code: "NIFRA_DB_EXTENSION",
      message: expect.stringContaining("dblink"),
    })
    expect(
      code(await queryPostgres(engineClient(ROLE.granted), "SELECT 1", OPTIONS)),
    ).toBeUndefined()
  })

  test("the granted role queries: duplicate names, int8 beyond 2^53, bytes, dates, redaction", async () => {
    const reader = engineClient(ROLE.granted)
    const rows = await queryPostgres(
      reader,
      "SELECT o.id, o.id, o.total, o.blob, o.placed, 'shown' AS password_hash, u.note FROM orders o CROSS JOIN users u ORDER BY o.id;",
      {
        ...OPTIONS,
        redaction: {
          column: (name) => name === "password_hash",
          text: (value) => value.replace(/eyJ[\w.-]+/g, "[redacted:JWT]"),
        },
      },
    )
    if (isDbRefusal(rows)) throw new Error(rows.message)
    expect(rows.columns).toEqual(["id", "id", "total", "blob", "placed", "password_hash", "note"])
    expect(rows.rows[0]).toEqual([
      1,
      1,
      "9007199254740993",
      "<2 bytes>",
      "2026-01-02T03:04:05.000Z",
      "[redacted]",
      "token [redacted:JWT]",
    ])
    expect(rows.redactedColumns).toEqual(["password_hash"])
    const capped = await queryPostgres(reader, "SELECT * FROM generate_series(1, 500)", OPTIONS)
    expect(capped).toMatchObject({ rowCount: 50, truncated: true })
    const view = await queryPostgres(reader, "SELECT * FROM order_summary ORDER BY status", OPTIONS)
    expect(view).toMatchObject({ columns: ["status", "n"], rowCount: 2 })
  })

  const MASKED_READS = [
    "SELECT password_hash FROM users",
    "SELECT password_hash AS p FROM users",
    "SELECT upper(u.password_hash) FROM users u",
    "SELECT row_to_json(u) FROM users u",
    "SELECT u::text FROM users u",
    "SELECT id FROM users WHERE password_hash LIKE 'h%'",
    "SELECT string_agg(password_hash, ',') FROM users",
    "SELECT * FROM users",
    "SELECT (SELECT password_hash FROM users LIMIT 1)",
    "WITH c AS MATERIALIZED (SELECT password_hash AS q FROM users) SELECT q FROM c",
    "SELECT o.id FROM orders o JOIN users u ON u.password_hash = 'x'",
    "SELECT note FROM users UNION ALL SELECT password_hash FROM users",
    "SELECT id FROM users ORDER BY password_hash LIMIT 1",
    // A table alias list renames columns in the plan, so it can hand password_hash another's name.
    "SELECT c FROM users AS t(a, b, c)",
    "SELECT id FROM users AS t(a, b, id)",
    "SELECT t.* FROM users t(a, b, c)",
    "SELECT 1 FROM users t(a, b, c) WHERE c LIKE 'h%'",
  ]
  const UNMASKED_READS = [
    "SELECT count(*) FROM users",
    "SELECT note, count(*) FROM users GROUP BY note",
    "SELECT o.id FROM orders o CROSS JOIN users u",
    "SELECT note FROM users WHERE note IS NOT NULL",
    "SELECT s FROM orders AS o(i, s)",
    "SELECT n FROM generate_series(1, 2) AS g(n) CROSS JOIN users u",
  ]

  test("a masked column: the granted role's privileges refuse it in every form, and only then", async () => {
    const granted = engineClient(ROLE.granted)
    for (const sql of MASKED_READS) {
      expect({ sql, code: code(await queryPostgres(granted, sql, MASKED)) }).toEqual({
        sql,
        code: "NIFRA_DB_COLUMN_REFUSED",
      })
      // A plan's row counts and estimates answer questions about the column too.
      for (const analyze of [false, true]) {
        const explained = await explainPostgres(granted, sql, { ...MASKED, analyze })
        expect({ sql, analyze, code: code(explained) }).toEqual({
          sql,
          analyze,
          code: "NIFRA_DB_COLUMN_REFUSED",
        })
      }
      // The server refuses it with every layer of ours bypassed.
      expect({ sql, outcome: await serverOnly(granted, sql) }).toMatchObject({
        sql,
        outcome: { ran: false, state: "42501" },
      })
    }
    for (const sql of UNMASKED_READS) {
      expect({ sql, code: code(await queryPostgres(granted, sql, MASKED)) }).toEqual({
        sql,
        code: undefined,
      })
      expect({
        sql,
        code: code(await explainPostgres(granted, sql, { ...MASKED, analyze: true })),
      }).toEqual({ sql, code: undefined })
    }
    const star = await queryPostgres(granted, "SELECT * FROM users", MASKED)
    expect(isDbRefusal(star) ? star.message : "").toBe(
      "the role may read only some columns of public.users, not password_hash: select the others by name",
    )
  })

  test("a masked column: the plan check behind the grants refuses it too, wherever the plan uses it", async () => {
    // pg_read_all_data reads every column, so only the plan check stands between it and the hash.
    const reader = engineClient(ROLE.reader)
    const planOnly = (sql: string, mode: "query" | "explain" | "analyze") =>
      inReadOnlyTransaction(reader, TIMEOUT_MS, async (connection) => {
        const scope = checkScope(SCOPE, { masked, statement: sql })
        if (mode === "query") return fetchThroughCursor(connection, sql, { maxRows: 5, scope })
        return explainThroughServer(connection, sql, { analyze: mode === "analyze", scope })
      })
    for (const sql of MASKED_READS) {
      for (const mode of ["query", "explain", "analyze"] as const) {
        expect({ sql, mode, code: code(await planOnly(sql, mode)) }).toEqual({
          sql,
          mode,
          code: "NIFRA_DB_COLUMN_REFUSED",
        })
      }
    }
    for (const sql of UNMASKED_READS) {
      expect({ sql, code: code(await planOnly(sql, "analyze")) }).toEqual({ sql, code: undefined })
    }
    // A view inlines into the plan, so a column it renames is still seen.
    expect(code(await planOnly("SELECT * FROM hash_lookup", "query"))).toBe(
      "NIFRA_DB_FUNCTION_REFUSED",
    )
  })

  test("the grant gate refuses a role that can read hidden data, materialized views included", async () => {
    const reader = engineClient(ROLE.reader)
    const refused = await queryPostgres(reader, "SELECT count(*) FROM orders", MASKED)
    expect(refused).toMatchObject({ code: "NIFRA_DB_ROLE_GRANTS" })
    const message = isDbRefusal(refused) ? refused.message : ""
    const via = serverVersion >= 140000 ? '"pg_read_all_data"' : JSON.stringify(ROLE.reader)
    for (const hidden of [
      `public.audit (devDatabase.exclude leaves it out; granted to ${via})`,
      `public.audit_2026 (it inherits from public.audit, which devDatabase.exclude leaves out; granted to ${via})`,
    ]) {
      expect(message).toContain(hidden)
    }
    expect(message).toContain(", and 5 more;")
    expect(code(await explainPostgres(reader, "SELECT 1", MASKED))).toBe("NIFRA_DB_ROLE_GRANTS")
    // Without masking or exclusions the same role passes: nothing is hidden from it.
    expect(
      code(await queryPostgres(reader, "SELECT count(*) FROM orders", { ...OPTIONS, exclude: [] })),
    ).toBeUndefined()
    // A materialized view stores its rows: the plan reads only the view, so the plan check alone let
    // these through. The granted role's privileges refuse them.
    const granted = engineClient(ROLE.granted)
    for (const sql of ["SELECT * FROM secret_copy", "SELECT ph FROM hash_copy"]) {
      expect({ sql, code: code(await queryPostgres(granted, sql, MASKED)) }).toEqual({
        sql,
        code: "NIFRA_DB_TABLE_EXCLUDED",
      })
      expect({ sql, outcome: await serverOnly(granted, sql) }).toMatchObject({
        sql,
        outcome: { ran: false, state: "42501" },
      })
    }
  })

  test("the function allowlist: what pg_proc says a call can do decides it", async () => {
    const granted = engineClient(ROLE.granted)
    for (const sql of [
      "SELECT pg_sleep(0)",
      "SELECT word FROM ts_stat('SELECT to_tsvector(''simple'', note) FROM users')",
      "SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, ''b''::tsquery')",
      "SELECT table_to_xml('orders', true, false, '')",
      "SELECT query_to_xml('SELECT 1', true, false, '')",
      "SELECT current_setting('server_version') || set_config('application_name', 'x', true)",
      "SELECT owner_hash(1)",
      "SELECT bump()",
      // Planning runs immutable functions on constants, so a call is checked before the server plans it.
      "SELECT 1 WHERE owner_hash(1) IS NOT NULL",
      // A view's call shows only in its plan.
      "SELECT * FROM hash_lookup",
      'SELECT "bump"()',
      // Postgres cuts an identifier to 63 bytes before resolving it.
      `SELECT ${LONG_NAME}_and_more()`,
    ]) {
      expect({ sql, code: code(await queryPostgres(granted, sql, MASKED)) }).toEqual({
        sql,
        code: "NIFRA_DB_FUNCTION_REFUSED",
      })
    }
    for (const sql of [
      "SELECT lower('A'), length('abc'), now() > '2000-01-01', age(now(), now()), random() < 2",
      "SELECT gen_random_uuid() IS NOT NULL, clock_timestamp() IS NOT NULL",
      "SELECT count(*), string_agg(status, ','), json_agg(id) FROM orders",
      "SELECT shout(status) FROM orders",
      "SELECT pg_total_relation_size('orders') > 0",
      "SELECT x FROM generate_series(1, 3) AS g(x)",
      "SELECT to_char(placed, 'YYYY'), extract(year FROM placed) FROM orders",
    ]) {
      expect({ sql, code: code(await queryPostgres(granted, sql, MASKED)) }).toEqual({
        sql,
        code: undefined,
      })
    }
    // allowFunctions is a decision to trust a function: owner_hash then reads with its owner's rights.
    await asOwner(`GRANT EXECUTE ON FUNCTION owner_hash(int) TO "${ROLE.granted}"`)
    try {
      const trusted = await queryPostgres(granted, "SELECT owner_hash(1) AS h", {
        ...MASKED,
        allowFunctions: ["public.owner_hash"],
      })
      expect(trusted).toMatchObject({ rows: [["hash-value"]] })
    } finally {
      await asOwner(`REVOKE EXECUTE ON FUNCTION owner_hash(int) FROM "${ROLE.granted}"`)
    }
  })

  test("SECURITY DEFINER code reached without its name: the gate needs EXECUTE revoked, then the server refuses it", async () => {
    const granted = engineClient(ROLE.granted)
    for (const sql of [
      // Folded at plan time, through an operator, through a cast, from a function's body, from an
      // aggregate's support function (checked against the aggregate's owner, not the caller).
      "SELECT * FROM folded_view",
      "SELECT 1 ### 2 AS s",
      "SELECT ROW(1)::boxed::text AS s",
      "SELECT calls_folded() AS s",
      "SELECT calls_agg() AS s",
    ]) {
      const outcome = await queryPostgres(granted, sql, MASKED)
      expect({
        sql,
        code: code(outcome),
        leaked: JSON.stringify(outcome).includes("top secret"),
      }).toEqual({
        sql,
        code: "NIFRA_DB_FUNCTION_REFUSED",
        leaked: false,
      })
    }
    for (const [grant, listed] of [
      ["folded_secret(int)", "public.folded_secret(integer)"],
      ["op_secret(int, int)", "public.op_secret(integer, integer)"],
      ["boxed_text(boxed)", "public.boxed_text(boxed)"],
      ["secret_step(text, int)", "public.secret_step(text, integer)"],
      ["secret_agg(int)", "public.secret_agg(integer)"],
    ] as const) {
      await asOwner(`GRANT EXECUTE ON FUNCTION ${grant} TO "${ROLE.granted}"`)
      try {
        const outcome = await queryPostgres(granted, "SELECT 1", MASKED)
        expect({ grant, code: code(outcome) }).toEqual({ grant, code: "NIFRA_DB_ROLE_GRANTS" })
        expect(isDbRefusal(outcome) ? outcome.message : "").toContain(listed)
      } finally {
        await asOwner(`REVOKE EXECUTE ON FUNCTION ${grant} FROM "${ROLE.granted}"`)
      }
    }
  })

  test("a refusal names each grant the role reads through, and nifra db role revokes every one", async () => {
    const granted = engineClient(ROLE.granted)
    const su = engineClient()
    const roleSql = async (role: string) => {
      const sql = await postgresRoleSql(su, {
        ...SCOPE,
        timeoutMs: TIMEOUT_MS,
        role,
        redaction: { column: masked },
      })
      if (isDbRefusal(sql)) throw new Error(sql.message)
      return sql.statements
    }
    const fn = '"public"."folded_secret"(integer)'
    const grants = [
      "GRANT SELECT ON secrets TO PUBLIC",
      `GRANT SELECT (password_hash) ON users TO "${ROLE.group}"`,
      `GRANT EXECUTE ON FUNCTION folded_secret(int) TO "${ROLE.group}", "${ROLE.granted}"`,
    ]
    await asOwner(`GRANT "${ROLE.group}" TO "${ROLE.granted}"`)
    try {
      for (const grant of grants) await asOwner(grant)
      const tables = await queryPostgres(granted, "SELECT 1", MASKED)
      expect(code(tables)).toBe("NIFRA_DB_ROLE_GRANTS")
      for (const listed of [
        "public.secrets (devDatabase.exclude leaves it out; granted to PUBLIC)",
        `public.users.password_hash (masked as a credential; granted to "${ROLE.group}")`,
      ]) {
        expect(isDbRefusal(tables) ? tables.message : "").toContain(listed)
      }
      const written = await roleSql(ROLE.granted)
      expect(
        written.filter((line) => line.includes("folded_secret") || /^-- REVOKE SELECT/.test(line)),
      ).toEqual([
        '-- REVOKE SELECT ON TABLE "public"."secrets" FROM PUBLIC;',
        `-- REVOKE SELECT ("password_hash") ON TABLE "public"."users" FROM "${ROLE.group}";`,
        `REVOKE EXECUTE ON FUNCTION ${fn} FROM "${ROLE.granted}";`,
        `-- REVOKE EXECUTE ON FUNCTION ${fn} FROM "${ROLE.group}";`,
      ])
      // A role the SQL would create holds only PUBLIC's grants.
      const fresh = await roleSql(`nifra_live_absent_${run}`)
      expect(fresh).toContain('-- REVOKE SELECT ON TABLE "public"."secrets" FROM PUBLIC;')
      expect(
        fresh.some((line) => line.includes(ROLE.group) || line.includes("folded_secret")),
      ).toBe(false)
      // Applied as written, the SQL leaves nothing for the gate to refuse.
      await asOwner("REVOKE SELECT ON secrets FROM PUBLIC")
      await asOwner(`REVOKE SELECT (password_hash) ON users FROM "${ROLE.group}"`)
      const definers = await queryPostgres(granted, "SELECT 1", MASKED)
      expect(code(definers)).toBe("NIFRA_DB_ROLE_GRANTS")
      expect(isDbRefusal(definers) ? definers.message : "").toContain(
        `public.folded_secret(integer) (granted to "${ROLE.granted}", "${ROLE.group}")`,
      )
      for (const line of written) {
        if (!line.includes("folded_secret")) continue
        await asOwner(line.replace(/^-- /, ""))
      }
      expect(code(await queryPostgres(granted, "SELECT 1", MASKED))).toBeUndefined()
      if (serverVersion >= 140000) {
        expect(await roleSql(ROLE.reader)).toContain(
          `-- "${ROLE.reader}" has the privileges of pg_read_all_data, which reads every table past these REVOKEs: revoke that membership.`,
        )
      }
    } finally {
      await asOwner(`REVOKE "${ROLE.group}" FROM "${ROLE.granted}"`)
      await asOwner("REVOKE SELECT ON secrets FROM PUBLIC")
      await asOwner(`REVOKE SELECT (password_hash) ON users FROM "${ROLE.group}"`)
      await asOwner(
        `REVOKE EXECUTE ON FUNCTION folded_secret(int) FROM "${ROLE.group}", "${ROLE.granted}"`,
      )
    }
  })

  test("text search that runs SQL from a string: the allowlist refuses it, the grants would too", async () => {
    const granted = engineClient(ROLE.granted)
    for (const sql of [
      "SELECT word FROM ts_stat('SELECT to_tsvector(''simple'', password_hash) FROM users')",
      "SELECT word FROM ts_stat('SELECT to_tsvector(''simple'', value) FROM secrets')",
      "SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, plainto_tsquery(value) FROM secrets')",
    ]) {
      expect({ sql, code: code(await queryPostgres(granted, sql, MASKED)) }).toEqual({
        sql,
        code: "NIFRA_DB_FUNCTION_REFUSED",
      })
      expect({ sql, outcome: await serverOnly(granted, sql) }).toMatchObject({
        sql,
        outcome: { ran: false, state: "42501" },
      })
    }
  })

  test("a role with no grants is refused by the server's privileges", async () => {
    const weak = engineClient(ROLE.weak)
    expect(code(await queryPostgres(weak, "SELECT * FROM orders", OPTIONS))).toBe(
      "NIFRA_DB_TABLE_EXCLUDED",
    )
  })

  test("explain and explain analyze run inside the same read-only transaction", async () => {
    const reader = engineClient(ROLE.granted)
    const plan = await explainPostgres(
      reader,
      "SELECT * FROM orders WHERE status = 'paid'",
      OPTIONS,
    )
    if (isDbRefusal(plan)) throw new Error(plan.message)
    expect(plan.analyzed).toBe(false)
    expect(JSON.stringify(plan.plan)).toContain('"Relation Name":"orders"')
    const analyzed = await explainPostgres(reader, "SELECT count(*) FROM orders", {
      ...OPTIONS,
      analyze: true,
    })
    if (isDbRefusal(analyzed)) throw new Error(analyzed.message)
    expect(analyzed.analyzed).toBe(true)
    expect(JSON.stringify(analyzed.plan)).toContain("Actual Rows")
    expect(code(await explainPostgres(reader, "SELECT * FROM secrets", OPTIONS))).toBe(
      "NIFRA_DB_TABLE_EXCLUDED",
    )
    expect(
      code(await explainPostgres(reader, "DELETE FROM orders", { ...OPTIONS, analyze: true })),
    ).toBe("NIFRA_DB_WRITE_REFUSED")
    const [count] = await rawCount("SELECT count(*)::int AS n FROM orders")
    expect(count?.n).toBe(2)
  })

  test("schema lists exposed relations only, from the catalog", async () => {
    const reader = engineClient(ROLE.reader)
    const schema = await readPostgresSchema(reader, { ...SCOPE, timeoutMs: TIMEOUT_MS })
    if (isDbRefusal(schema)) throw new Error(schema.message)
    const names = schema.tables.map((table) => table.name)
    expect(names).toEqual([
      "base_open",
      "folded_view",
      "hash_copy",
      "hash_lookup",
      "kid_open",
      "order_summary",
      "orders",
      "users",
    ])
    // secrets and audit by name; child_secret and grand_secret inherit secrets; secret_view and
    // secret_copy read it.
    expect(schema.excludedCount).toBe(6)
    const orders = schema.tables.find((table) => table.name === "orders")
    expect(orders?.columns[0]).toMatchObject({ name: "id", type: "bigint", primaryKey: true })
    expect(orders?.indexes.map((index) => index.name).sort()).toEqual([
      "orders_pkey",
      "orders_status",
    ])
    expect(orders?.rowEstimate).toBe(2)
    const one = await readPostgresSchema(reader, {
      ...SCOPE,
      timeoutMs: TIMEOUT_MS,
      table: "public.users",
    })
    expect(isDbRefusal(one) ? one.code : one.tables.map((table) => table.name)).toEqual(["users"])
    expect(
      code(await readPostgresSchema(reader, { ...SCOPE, timeoutMs: TIMEOUT_MS, table: "secrets" })),
    ).toBe("NIFRA_DB_TABLE_EXCLUDED")
    // A table the role may read only some columns of is listed; what it may not read at all is not.
    const granted = await readPostgresSchema(engineClient(ROLE.granted), {
      ...SCOPE,
      timeoutMs: TIMEOUT_MS,
      redaction: { column: masked },
    })
    if (isDbRefusal(granted)) throw new Error(granted.message)
    expect(granted.tables.map((table) => table.name)).toEqual([
      "base_open",
      "folded_view",
      "hash_lookup",
      "kid_open",
      "order_summary",
      "orders",
      "users",
    ])
    expect(
      granted.tables
        .find((table) => table.name === "users")
        ?.columns.map((column) => column.redacted),
    ).toEqual([false, false, true, false])
  })

  test("nifra db role SQL: applied as written, it reads exposed tables and is refused the excluded ones", async () => {
    const su = engineClient()
    const withExcludes = await postgresRoleSql(su, {
      ...SCOPE,
      timeoutMs: TIMEOUT_MS,
      role: ROLE.generated,
    })
    if (isDbRefusal(withExcludes)) throw new Error(withExcludes.message)
    expect(withExcludes.statements.some((line) => line.includes("pg_read_all_data"))).toBe(false)
    const revoked = withExcludes.statements.filter((line) => line.startsWith("REVOKE"))
    expect(revoked).toEqual([
      `REVOKE SELECT ON TABLE "public"."audit" FROM "${ROLE.generated}";`,
      `REVOKE SELECT ON TABLE "public"."audit_2026" FROM "${ROLE.generated}";`,
      `REVOKE SELECT ON TABLE "public"."child_secret" FROM "${ROLE.generated}";`,
      `REVOKE SELECT ON TABLE "public"."grand_secret" FROM "${ROLE.generated}";`,
      `REVOKE SELECT ON TABLE "public"."secret_copy" FROM "${ROLE.generated}";`,
      `REVOKE SELECT ON TABLE "public"."secret_view" FROM "${ROLE.generated}";`,
      `REVOKE SELECT ON TABLE "public"."secrets" FROM "${ROLE.generated}";`,
    ])
    const db = rawClient(DB)
    try {
      // The role exists already (created with a password by this suite); apply the rest as written.
      for (const statement of withExcludes.statements) {
        if (statement.startsWith("--") || statement.startsWith("CREATE ROLE")) continue
        await db.unsafe(statement)
      }
    } finally {
      await db.close()
    }
    const generated = engineClient(ROLE.generated)
    const [readOnly] = await generated.reserve().then(async (connection) => {
      try {
        return records(
          await connection`SELECT rolconfig::text AS config FROM pg_roles WHERE rolname = current_user`,
        )
      } finally {
        connection.release()
      }
    })
    expect(String(readOnly?.config)).toContain("default_transaction_read_only=on")
    expect(
      await queryPostgres(generated, "SELECT count(*) AS n FROM orders", OPTIONS),
    ).toMatchObject({
      rows: [[2]],
    })
    for (const sql of [
      "SELECT * FROM secrets",
      "SELECT * FROM audit_2026",
      "SELECT * FROM child_secret",
      "SELECT * FROM grand_secret",
      "SELECT * FROM secret_view",
      "SELECT * FROM secret_copy",
    ]) {
      expect({ sql, outcome: await serverOnly(generated, sql) }).toMatchObject({
        sql,
        outcome: { ran: false, state: "42501" },
      })
    }
    const masking = await postgresRoleSql(su, {
      ...SCOPE,
      timeoutMs: TIMEOUT_MS,
      role: ROLE.generated,
      redaction: { column: masked },
    })
    if (isDbRefusal(masking)) throw new Error(masking.message)
    expect(
      masking.statements.filter((line) => line.includes('"users"') || line.includes("hash_copy")),
    ).toEqual([
      `REVOKE SELECT ON TABLE "public"."hash_copy" FROM "${ROLE.generated}";`,
      `REVOKE SELECT ON TABLE "public"."users" FROM "${ROLE.generated}";`,
      `GRANT SELECT ("id", "email", "note") ON TABLE "public"."users" TO "${ROLE.generated}";`,
    ])
    const plain = await postgresRoleSql(su, { timeoutMs: TIMEOUT_MS })
    if (isDbRefusal(plain)) throw new Error(plain.message)
    expect(plain.statements).toContain(
      'GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "nifra_dev_reader";',
    )
    expect(plain.statements.some((line) => line.includes("pg_read_all_data"))).toBe(false)
  })
})

async function rawCount(sql: string): Promise<readonly Record<string, unknown>[]> {
  const db = rawClient(DB)
  try {
    return await db.unsafe(sql)
  } finally {
    await db.close()
  }
}
