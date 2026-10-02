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

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
