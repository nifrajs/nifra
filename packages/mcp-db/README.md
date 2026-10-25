# @nifrajs/mcp-db

Expose an allowlisted SQLite schema as a fail-closed MCP server, with opt-in read-only queries.

```sh
bun add @nifrajs/mcp-db
```

```ts
import { Database } from "bun:sqlite"
import { serveDatabaseAsMcp } from "@nifrajs/mcp-db"

const mcp = serveDatabaseAsMcp(new Database("app.db"), {
  tables: ["habits", "entries"],
  // Refuse any other Host, so a DNS-rebound browser page cannot read the schema tools.
  allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
})
```

Only `list_tables` and `describe_table` are exposed by default, restricted to the explicit table
allowlist. `list_tables` counts rows in the same lane as `run_query`, within its time limit, and
reuses the counts for 10 seconds. `run_query` requires an authorization hook and is guarded by SQLite
query-only mode, single-statement/read-only checks, verification of the compiled statement, and
bounded output. D1 is not supported
because it cannot provide the same engine-level read-only guarantee.

## The engine: `@nifrajs/mcp-db/engine`

The read-only SQLite engine behind the MCP server, without the MCP layer. `nifra db` uses it.

```ts
import { openReadOnlySqlite, querySqlite, readSqliteSchema } from "@nifrajs/mcp-db/engine"

const db = await openReadOnlySqlite("./data/app.db")
const result = querySqlite(db, "SELECT status, count(*) FROM orders GROUP BY 1", {
  exclude: ["sessions"],
  maxRows: 100,
  maxResultBytes: 100 * 1024,
})
if ("code" in result) console.error(result.code, result.fix)
```

- The file opens with the `readonly` flag and `PRAGMA query_only = ON`, so SQLite itself rejects every
  write. A WAL database with no writer attached (no `-wal` file yet) is reopened read-write with
  `query_only` on, which still rejects writes at the engine.
- A query must be one SELECT (or WITH ... SELECT). Every table its compiled bytecode opens must be
  exposed (all tables and views minus `exclude`): views read as their base tables, an alias cannot hide
  a table, and `sqlite_master`, virtual tables and table-valued functions are never exposed.
- With `redaction`, a query that reads a column `redaction.column` matches is refused
  (`NIFRA_DB_COLUMN_REFUSED`) wherever the compiled statement reads it: selected under another name,
  inside an expression, in a filter or an index seek, or through a view. Strings go through
  `redaction.text`.
- Results are capped by rows and bytes, bigints beyond 2^53 come back as strings, blobs as
  `<n bytes>`.
- Every refusal is a `DbRefusal`: a stable `NIFRA_DB_*` code, a message, a fix and a docs anchor.

## Postgres: `@nifrajs/mcp-db/postgres`

The same result shape and refusal codes for a development Postgres, on `Bun.SQL`.

```ts
import { isDbRefusal } from "@nifrajs/mcp-db/engine"
import { connectPostgres, parsePostgresUrl, queryPostgres } from "@nifrajs/mcp-db/postgres"

const target = parsePostgresUrl("postgres://nifra_dev_reader:secret@localhost/app")
if (isDbRefusal(target)) throw new Error(target.message)
const client = connectPostgres(target, { timeoutMs: 5000 })
if (isDbRefusal(client)) throw new Error(client.message)
const result = await queryPostgres(client, "SELECT id, status FROM orders LIMIT 10", {
  timeoutMs: 5000,
  maxRows: 100,
  maxResultBytes: 100 * 1024,
  exclude: ["audit_log"],
})
await client.close()
```

Each layer refuses on its own, in this order:

1. **Host.** Only loopback, `*.localhost` and unix sockets connect unless `allowHosts` names the host.
   URL parameters other than host, port, user, password, database and `sslmode` are ignored.
2. **Tokenizer.** One SELECT, WITH, VALUES or TABLE statement; row-locking clauses and
   unicode-escaped identifiers are refused.
3. **Read-only transaction.** `BEGIN READ ONLY` with `statement_timeout`, `lock_timeout` and
   `idle_in_transaction_session_timeout` set to `timeoutMs`, always rolled back. Sessions also start
   with `default_transaction_read_only = on`.
4. **Role and extensions.** A superuser, a member of a superuser or server-file/program role, or a
   role that may execute server-file functions is refused (`NIFRA_DB_SUPERUSER`). A role that can use
   dblink, postgres_fdw, file_fdw or an untrusted language is refused (`NIFRA_DB_EXTENSION`) unless
   `allowExtensions` names it.
5. **Grant gate.** The role itself must be unable to read what the declaration hides: a column
   `redaction.column` matches, an `exclude`d table or one inheriting from it, and a view or
   materialized view that reads any of those or reaches outside `schemas`. A role that can is refused
   (`NIFRA_DB_ROLE_GRANTS`), so the database's privileges refuse such a read even where no plan shows
   it: inside a function's body, or from the rows a materialized view stores. The role may not execute
   a SECURITY DEFINER function either (one outside `pg_catalog`, or an aggregate over one) unless
   `allowFunctions` names it: such a function reads with its owner's rights wherever a query reaches
   it, through an operator, a cast, a view folded at plan time or another function's body, and only
   the EXECUTE privilege is checked on every one of those paths.
6. **Function allowlist.** Every function the statement names, and every one its plan calls (inside
   views too), is looked up in `pg_proc`, each overload the name can resolve to. A built-in or
   extension function must be immutable or stable and parallel safe (a few value-only ones such as
   `random()`, `clock_timestamp()` and `pg_total_relation_size()` pass as well); one the database
   defines must be immutable or stable; none may be SECURITY DEFINER. Anything else is refused
   (`NIFRA_DB_FUNCTION_REFUSED`) unless `allowFunctions` names it, so a function added in a later
   Postgres release is refused until it is known to be safe. The names are checked before the server
   plans the statement, since planning already runs immutable functions on constants.
7. **Cursor.** The statement runs as one extended-protocol `DECLARE ... NO SCROLL CURSOR`, which the
   server accepts only for SELECT and VALUES and refuses for a data-modifying WITH, then one `FETCH`
   of `maxRows + 1` rows.
8. **Plan scope.** Every relation in the `EXPLAIN (VERBOSE)` plan, every table it inherits from, and
   every `pg_catalog` function scanned in FROM must sit in `schemas` (default `public`) and outside
   `exclude`. With `redaction`, a column `redaction.column` matches that any plan expression uses
   (output, filter, join, sort or index condition), or a whole row holding one, is refused
   (`NIFRA_DB_COLUMN_REFUSED`). A plan names a scan's columns by the table's column alias list
   (`FROM users AS t(a, b)`), so while any relation the query reads holds a matching column, a query
   that gives a table one is refused as well. This is the second line behind the grant gate.

`explainPostgres` returns the plan (with `analyze`, executed inside the same transaction),
`readPostgresSchema` reads tables, columns, keys and indexes from `pg_catalog`, and `postgresRoleSql`
writes the SQL for the role the grant gate accepts, without running it: `GRANT SELECT` on each allowed
schema; a `REVOKE` for each excluded table, its partitions and children, and each view or
materialized view that reads hidden data; and, for a table with a masked column (pass the same
`redaction`), a `REVOKE` followed by a column-level `GRANT` of its other columns. Run it again after
adding a table or view: default privileges grant every column of a new one. A SECURITY DEFINER
function every role may execute is listed in comments with the `REVOKE EXECUTE ... FROM PUBLIC` the
gate needs (pass the same `allowFunctions` to skip the ones you trust); they are comments because
revoking from PUBLIC reaches every other role. A query that names a column the role may not read is
refused with `NIFRA_DB_COLUMN_REFUSED`, naming the columns it may.

The live tests run against a throwaway server: set `NIFRA_TEST_POSTGRES_URL` to its superuser URL.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
