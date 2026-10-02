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
allowlist. `run_query` requires an authorization hook and is guarded by SQLite query-only mode,
single-statement/read-only checks, query-plan verification, and bounded output. D1 is not supported
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
- Results are capped by rows and bytes, bigints beyond 2^53 come back as strings, blobs as
  `<n bytes>`, and `redaction` masks columns and scrubs strings.
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
2. **Tokenizer.** One SELECT, WITH, VALUES or TABLE statement; row-locking clauses, unicode-escaped
   identifiers and functions that reach outside a query (server files, `dblink`, `set_config`,
   advisory locks, `pg_notify`, `nextval`, `query_to_xml`, backend signals) are refused.
3. **Read-only transaction.** `BEGIN READ ONLY` with `statement_timeout`, `lock_timeout` and
   `idle_in_transaction_session_timeout` set to `timeoutMs`, always rolled back. Sessions also start
   with `default_transaction_read_only = on`.
4. **Role and extensions.** A superuser, a member of a superuser or server-file/program role, or a
   role that may execute server-file functions is refused (`NIFRA_DB_SUPERUSER`). A role that can use
   dblink, postgres_fdw, file_fdw or an untrusted language is refused (`NIFRA_DB_EXTENSION`) unless
   `allowExtensions` names it.
5. **Cursor.** The statement runs as one extended-protocol `DECLARE ... NO SCROLL CURSOR`, which the
   server accepts only for SELECT and VALUES and refuses for a data-modifying WITH, then one `FETCH`
   of `maxRows + 1` rows.
6. **Plan scope.** Every relation in the `EXPLAIN (VERBOSE)` plan, every table it inherits from, and
   every `pg_catalog` function scanned in FROM must sit in `schemas` (default `public`) and outside
   `exclude`.

`explainPostgres` returns the plan (with `analyze`, executed inside the same transaction),
`readPostgresSchema` reads tables, columns, keys and indexes from `pg_catalog`, and `postgresRoleSql`
writes the SQL for a read-only role (`pg_read_all_data` on 14+, or `GRANT SELECT` per schema with a
`REVOKE` for each excluded table and its partitions) without running it.

The live tests run against a throwaway server: set `NIFRA_TEST_POSTGRES_URL` to its superuser URL.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
