---
"@nifrajs/mcp-db": minor
---

`@nifrajs/mcp-db/postgres` reads a development Postgres database on `Bun.SQL`, with the result shape and `NIFRA_DB_*` refusal codes of the SQLite engine.

- `parsePostgresUrl` and `connectPostgres` connect only to loopback, `*.localhost` or a unix socket unless `allowHosts` names the host, and start every session read-only.
- `queryPostgres` runs one statement through a tokenizer (one read-only statement, no row locks, no functions that reach outside a query), a `BEGIN READ ONLY` transaction with statement, lock and idle timeouts, a role gate (superusers and server-file or server-program roles are refused), an extension gate (dblink, postgres_fdw, file_fdw and untrusted languages, unless `allowExtensions` names them), a `DECLARE CURSOR` that the server accepts only for SELECT and VALUES, and a plan-level check that every relation, its parent tables and every catalog function in FROM are in `schemas` and outside `exclude`.
- `explainPostgres` returns the JSON plan, and with `analyze` executes it inside the same transaction and timeout.
- `readPostgresSchema` lists the readable tables and views with columns, keys, indexes and row estimates, and leaves out an excluded table along with the views and child tables that read it.
- `postgresRoleSql` writes the SQL for a read-only login role, `pg_read_all_data` on Postgres 14 and later or `GRANT SELECT` per schema with a `REVOKE` per excluded table and partition, and runs none of it.
