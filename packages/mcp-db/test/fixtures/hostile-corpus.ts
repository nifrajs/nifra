/**
 * The hostile corpus: statements a dev agent must never get through, each with the refusal code each
 * engine must answer. A regression fixture - add to it, never loosen an entry.
 *
 * Both engines run it against the same shape: `orders`, `users` (with `password_hash`), the excluded
 * `secrets`, and a view `secret_view` over `secrets`. Postgres adds an excluded partitioned `audit`
 * with the partition `audit_2026`, the sequence `orders_id_seq` and the procedure `p()`.
 *
 * `null` means the statement does not apply to that engine (its SQL is engine-specific).
 */

import type { DbRefusalCode } from "../../src/engine.ts"

export interface HostileStatement {
  readonly name: string
  readonly sql: string
  readonly sqlite: DbRefusalCode | null
  readonly postgres: DbRefusalCode | null
}

const WRITE = "NIFRA_DB_WRITE_REFUSED"
const FUNCTION = "NIFRA_DB_FUNCTION_REFUSED"
const TABLE = "NIFRA_DB_TABLE_EXCLUDED"
// SQLite answers a Postgres-only function or syntax with an engine error: still never run.
const FAILED = "NIFRA_DB_QUERY_FAILED"

export const HOSTILE_CORPUS: readonly HostileStatement[] = [
  // Writes and DDL.
  {
    name: "insert",
    sql: "INSERT INTO orders (status) VALUES ('x')",
    sqlite: WRITE,
    postgres: WRITE,
  },
  { name: "update", sql: "UPDATE orders SET status = 'x'", sqlite: WRITE, postgres: WRITE },
  { name: "delete", sql: "DELETE FROM orders", sqlite: WRITE, postgres: WRITE },
  {
    name: "replace",
    sql: "REPLACE INTO orders (id, status) VALUES (1, 'x')",
    sqlite: WRITE,
    postgres: null,
  },
  {
    name: "merge",
    sql: "MERGE INTO orders o USING users u ON o.id = u.id WHEN MATCHED THEN DELETE",
    sqlite: WRITE,
    postgres: WRITE,
  },
  { name: "create table", sql: "CREATE TABLE t (x int)", sqlite: WRITE, postgres: WRITE },
  { name: "drop table", sql: "DROP TABLE orders", sqlite: WRITE, postgres: WRITE },
  {
    name: "alter table",
    sql: "ALTER TABLE orders ADD COLUMN x int",
    sqlite: WRITE,
    postgres: WRITE,
  },
  { name: "truncate", sql: "TRUNCATE orders", sqlite: WRITE, postgres: WRITE },
  { name: "attach", sql: "ATTACH DATABASE '/tmp/x.db' AS x", sqlite: WRITE, postgres: WRITE },
  { name: "pragma", sql: "PRAGMA writable_schema = ON", sqlite: WRITE, postgres: WRITE },
  { name: "vacuum", sql: "VACUUM", sqlite: WRITE, postgres: WRITE },
  { name: "lock", sql: "LOCK TABLE orders", sqlite: WRITE, postgres: WRITE },
  { name: "set role", sql: "SET ROLE postgres", sqlite: WRITE, postgres: WRITE },
  { name: "notify statement", sql: "NOTIFY ch, 'x'", sqlite: WRITE, postgres: WRITE },
  {
    name: "explain analyze delete",
    sql: "EXPLAIN ANALYZE DELETE FROM orders",
    sqlite: WRITE,
    postgres: WRITE,
  },
  // Several statements, however hidden.
  { name: "two statements", sql: "SELECT 1; DELETE FROM orders", sqlite: WRITE, postgres: WRITE },
  {
    name: "terminator inside a literal",
    sql: "SELECT ';'; DELETE FROM orders",
    sqlite: WRITE,
    postgres: WRITE,
  },
  {
    name: "statement after a comment",
    sql: "SELECT 1; -- note\nDELETE FROM orders",
    sqlite: WRITE,
    postgres: WRITE,
  },
  // A write wearing a SELECT.
  {
    name: "data-modifying CTE",
    sql: "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
    sqlite: WRITE,
    postgres: WRITE,
  },
  // SQLite reads `FOR` as an alias, then fails to parse at UPDATE.
  {
    name: "select for update",
    sql: "SELECT * FROM orders FOR UPDATE",
    sqlite: WRITE,
    postgres: WRITE,
  },
  {
    name: "select into",
    sql: "SELECT * INTO orders_copy FROM orders",
    sqlite: FAILED,
    postgres: WRITE,
  },
  {
    name: "select for share",
    sql: "SELECT * FROM orders FOR NO KEY UPDATE",
    sqlite: FAILED,
    postgres: WRITE,
  },
  { name: "nextval", sql: "SELECT nextval('orders_id_seq')", sqlite: FAILED, postgres: FUNCTION },
  { name: "setval", sql: "SELECT setval('orders_id_seq', 1)", sqlite: FAILED, postgres: FUNCTION },
  // Procedural and server-side statements.
  { name: "call", sql: "CALL p()", sqlite: WRITE, postgres: WRITE },
  { name: "do", sql: "DO $$ BEGIN PERFORM 1; END $$", sqlite: WRITE, postgres: WRITE },
  {
    name: "copy to program",
    sql: "COPY (SELECT 1) TO PROGRAM 'id'",
    sqlite: WRITE,
    postgres: WRITE,
  },
  { name: "copy from file", sql: "COPY orders FROM '/etc/passwd'", sqlite: WRITE, postgres: WRITE },
  // Functions that reach outside the query.
  {
    name: "set_config role",
    sql: "SELECT set_config('role', 'postgres', true)",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  {
    name: "set_config read-write",
    sql: "SELECT set_config('transaction_read_only', 'off', true)",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  {
    name: "pg_read_file",
    sql: "SELECT pg_read_file('/etc/passwd')",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  {
    name: "qualified pg_read_file",
    sql: "SELECT pg_catalog.pg_read_file('/etc/passwd')",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  {
    name: "quoted pg_read_file",
    sql: "SELECT \"pg_read_file\"('/etc/passwd')",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  {
    name: "unicode-escaped function name",
    sql: "SELECT U&\"\\0070g_read_file\"('/etc/passwd')",
    sqlite: FAILED,
    postgres: WRITE,
  },
  { name: "pg_ls_dir", sql: "SELECT pg_ls_dir('.')", sqlite: FAILED, postgres: FUNCTION },
  { name: "lo_import", sql: "SELECT lo_import('/etc/passwd')", sqlite: FAILED, postgres: FUNCTION },
  {
    name: "dblink_exec",
    sql: "SELECT dblink_exec('dbname=postgres', 'CREATE TABLE pwned (x int)')",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  { name: "advisory lock", sql: "SELECT pg_advisory_lock(42)", sqlite: FAILED, postgres: FUNCTION },
  {
    name: "advisory lock behind a comment",
    sql: "SELECT pg_try_advisory_lock /* x */ (42)",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  { name: "pg_notify", sql: "SELECT pg_notify('ch', 'x')", sqlite: FAILED, postgres: FUNCTION },
  {
    name: "terminate a backend",
    sql: "SELECT pg_terminate_backend(pg_backend_pid())",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  {
    name: "SQL from a string",
    sql: "SELECT query_to_xml('select * from secrets', true, false, '')",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  {
    name: "load_extension",
    sql: "SELECT load_extension('/tmp/x')",
    sqlite: FAILED,
    postgres: FAILED,
  },
  // Excluded tables, however named or reached.
  { name: "excluded table", sql: "SELECT * FROM secrets", sqlite: TABLE, postgres: TABLE },
  {
    name: "excluded through a view",
    sql: "SELECT * FROM secret_view",
    sqlite: TABLE,
    postgres: TABLE,
  },
  {
    name: "excluded through a CTE",
    sql: "WITH s AS (SELECT * FROM secrets) SELECT * FROM s",
    sqlite: TABLE,
    postgres: TABLE,
  },
  {
    name: "excluded in a WHERE subquery",
    sql: "SELECT * FROM orders WHERE id IN (SELECT id FROM secrets)",
    sqlite: TABLE,
    postgres: TABLE,
  },
  {
    name: "excluded in a scalar subquery",
    sql: "SELECT (SELECT value FROM secrets LIMIT 1)",
    sqlite: TABLE,
    postgres: TABLE,
  },
  {
    name: "excluded behind an exposed alias",
    sql: "SELECT orders.* FROM users AS u, secrets AS orders",
    sqlite: TABLE,
    postgres: TABLE,
  },
  { name: "excluded, quoted", sql: 'SELECT * FROM "secrets"', sqlite: TABLE, postgres: TABLE },
  {
    name: "CTE named after the excluded table it reads",
    sql: "WITH secrets(v) AS (SELECT value FROM main.secrets) SELECT * FROM secrets",
    sqlite: TABLE,
    postgres: null,
  },
  {
    name: "CTE named after the excluded table it reads, schema-qualified",
    sql: "WITH secrets(v) AS (SELECT value FROM public.secrets) SELECT * FROM secrets",
    sqlite: null,
    postgres: TABLE,
  },
  {
    name: "excluded, sqlite-qualified",
    sql: "SELECT * FROM main.secrets",
    sqlite: TABLE,
    postgres: null,
  },
  {
    name: "excluded, schema-qualified",
    sql: "SELECT * FROM public.secrets",
    sqlite: null,
    postgres: TABLE,
  },
  { name: "excluded partition", sql: "SELECT * FROM audit_2026", sqlite: null, postgres: TABLE },
  {
    name: "wrapper breakout",
    sql: "SELECT 1) AS z, (SELECT * FROM secrets",
    sqlite: TABLE,
    postgres: WRITE,
  },
  // System catalogs.
  { name: "sqlite_master", sql: "SELECT * FROM sqlite_master", sqlite: TABLE, postgres: null },
  {
    name: "pragma table function",
    sql: "SELECT * FROM pragma_table_info('secrets')",
    sqlite: TABLE,
    postgres: null,
  },
  { name: "pg_class", sql: "SELECT relname FROM pg_class", sqlite: null, postgres: TABLE },
  {
    name: "pg_stat_activity",
    sql: "SELECT query FROM pg_stat_activity",
    sqlite: null,
    postgres: TABLE,
  },
  {
    name: "information_schema",
    sql: "SELECT table_name FROM information_schema.tables",
    sqlite: null,
    postgres: TABLE,
  },
  { name: "pg_shadow", sql: "SELECT * FROM pg_shadow", sqlite: null, postgres: TABLE },
  {
    name: "pg_settings",
    sql: "SELECT name, setting FROM pg_settings",
    sqlite: null,
    postgres: TABLE,
  },
  { name: "pg_locks", sql: "SELECT pid, mode FROM pg_locks", sqlite: null, postgres: TABLE },
  {
    name: "statistics function in FROM",
    sql: "SELECT * FROM pg_stat_get_activity(NULL) AS s",
    sqlite: TABLE,
    postgres: FUNCTION,
  },
  {
    name: "statistics function in a target list",
    sql: "SELECT (pg_stat_get_activity(NULL)).query",
    sqlite: FAILED,
    postgres: FUNCTION,
  },
  // Malformed input never reaches the engine as SQL it might misread.
  { name: "unterminated literal", sql: "SELECT 'abc", sqlite: FAILED, postgres: WRITE },
]
