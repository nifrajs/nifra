---
"@nifrajs/mcp-db": minor
---

The read-only SQLite engine is importable on its own from `@nifrajs/mcp-db/engine`.

- `openReadOnlySqlite` opens a file with the `readonly` flag and `PRAGMA query_only = ON`, and opens a WAL database that no writer has attached yet without making it writable.
- `querySqlite`, `explainSqlite` and `readSqliteSchema` take an `exclude` list. A query is one SELECT (or WITH ... SELECT), and every table its compiled statement opens must be exposed, so a view, a CTE or an alias cannot reach an excluded table.
- Results are capped by rows and bytes, JSON-safe (bigints beyond 2^53 as strings, blobs as `<n bytes>`) and masked through a `redaction` option.
- Every refusal is a `DbRefusal` with a stable `NIFRA_DB_*` code, a message, a fix and a docs anchor.

`serveDatabaseAsMcp` behaves as before.
