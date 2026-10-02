---
"@nifrajs/cli": minor
---

`nifra db` and the `nifra_db_schema`, `nifra_db_query` and `nifra_db_role` MCP tools read the development database an app declares as `devDatabase` in `nifra.config.ts`, SQLite or Postgres. `DATABASE_URL` is never read on its own.

- `nifra db schema [<table>]` lists tables, row estimates, columns, keys and indexes. `nifra db query "<sql>"` runs one read-only SELECT, and `--explain [--analyze]` returns its plan. Queries are on for a declared database unless `query: false`; a Postgres host other than loopback, `*.localhost` or a unix socket needs `allowHosts`.
- Each call runs in a fresh process that is killed at `timeoutMs` plus one second, so a runaway query or a crash comes back as a refusal with a stable `NIFRA_DB_*` code, a fix and a docs link.
- A Postgres superuser, or a role that can reach server files, server programs or another database, is refused queries. `nifra db role` prints the SQL for a read-only role and runs none of it.
- Rows are capped by `maxRows` and `maxResultBytes`, credential columns are masked, values pass through the dev feed's redactor, and every answer is marked untrusted.
- Each call is appended to `.nifra/db-audit.jsonl` (owner-only, rotated at 1 MB) with its redacted SQL, fingerprint, row count, duration and refusal code, never its rows. `nifra db audit` shows it.
