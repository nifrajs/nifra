# @nifrajs/mcp-db

## 4.0.1

### Patch Changes

- @nifrajs/mcp@4.0.1

## 4.0.0

### Minor Changes

- d4d40a5: feat(mcp): `allowedHosts` DNS-rebinding guard

  `createMcpServer()`, `respondMcpHttp()`, and `serveDatabaseAsMcp()` accept `allowedHosts`. A
  request whose Host is not listed gets 403, with or without an Origin. Set it for servers on
  localhost or a private network, where a DNS-rebound page presents a matching Origin. The check reads
  the inbound `Host` header. Host names compare case-insensitively, an entry without a port matches any
  port, and an entry with a port matches the effective port, so `localhost:80` admits
  `http://localhost/`.

  The same-origin default now accepts an `https:` Origin on an `http:` request URL (a TLS-terminating
  proxy) and still rejects a downgrade.

- 37dff1d: The read-only SQLite engine is importable on its own from `@nifrajs/mcp-db/engine`.

  - `openReadOnlySqlite` opens a file with the `readonly` flag and `PRAGMA query_only = ON`, and opens a WAL database that no writer has attached yet without making it writable.
  - `querySqlite`, `explainSqlite` and `readSqliteSchema` take an `exclude` list. A query is one SELECT (or WITH ... SELECT), and every table its compiled statement opens must be exposed, so a view, a CTE or an alias cannot reach an excluded table.
  - With a `redaction` option, a query that reads a column `redaction.column` matches is refused (`NIFRA_DB_COLUMN_REFUSED`), whether it selects the column under another name, wraps it in an expression, filters on it or reaches it through a view or an index. Results are capped by rows and bytes and JSON-safe (bigints beyond 2^53 as strings, blobs as `<n bytes>`).
  - Every refusal is a `DbRefusal` with a stable `NIFRA_DB_*` code, a message, a fix and a docs anchor.

  `serveDatabaseAsMcp` behaves as before.

- d4a79de: `@nifrajs/mcp-db/postgres` reads a development Postgres database on `Bun.SQL`, with the result shape and `NIFRA_DB_*` refusal codes of the SQLite engine.

  - `parsePostgresUrl` and `connectPostgres` connect only to loopback, `*.localhost` or a unix socket unless `allowHosts` names the host, and start every session read-only.
  - `queryPostgres` runs one statement through a tokenizer (one read-only statement, no row locks, no functions that reach outside a query), a `BEGIN READ ONLY` transaction with statement, lock and idle timeouts, a role gate (superusers and server-file or server-program roles are refused), an extension gate (dblink, postgres_fdw, file_fdw and untrusted languages, unless `allowExtensions` names them), a `DECLARE CURSOR` that the server accepts only for SELECT and VALUES, and a plan-level check that every relation, its parent tables and every catalog function in FROM are in `schemas` and outside `exclude`. With `redaction`, a column `redaction.column` matches that any plan expression uses, or a whole row holding one, is refused (`NIFRA_DB_COLUMN_REFUSED`).
  - `explainPostgres` returns the JSON plan, and with `analyze` executes it inside the same transaction and timeout.
  - `readPostgresSchema` lists the readable tables and views with columns, keys, indexes and row estimates, and leaves out an excluded table along with the views and child tables that read it.
  - `postgresRoleSql` writes the SQL for a read-only login role, `pg_read_all_data` on Postgres 14 and later or `GRANT SELECT` per schema with a `REVOKE` per excluded table and partition, and runs none of it.

### Patch Changes

- 0f486f2: Closing a connection from `openReadOnlySqlite` releases the database file right away, instead of when its statements are garbage collected.
- Updated dependencies [d4d40a5]
- Updated dependencies [9ccf198]
  - @nifrajs/mcp@4.0.0

## 3.5.0

### Patch Changes

- 6046984: Close fresh security and correctness gaps in table allowlists, ISR/cache behavior, streamed response capture, idempotency ownership, and canonical redirects.
  - @nifrajs/mcp@3.5.0

## 3.4.0

### Patch Changes

- Updated dependencies [8d23613]
- Updated dependencies
  - @nifrajs/mcp@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/mcp@3.3.0

## 3.2.0

### Patch Changes

- f34a050: Record the pending source changes for these packages in their release notes so fixed-version publishing does not omit their changelog entries.
- Updated dependencies [1a041a9]
- Updated dependencies [cefedc2]
  - @nifrajs/mcp@3.2.0

## 3.1.0

### Patch Changes

- @nifrajs/mcp@3.1.0

## 3.0.0

### Patch Changes

- @nifrajs/mcp@3.0.0

## 2.14.1

### Patch Changes

- @nifrajs/mcp@2.14.1

## 2.14.0

### Patch Changes

- @nifrajs/mcp@2.14.0

## 2.13.0

### Patch Changes

- @nifrajs/mcp@2.13.0

## 2.12.1

### Patch Changes

- @nifrajs/mcp@2.12.1

## 2.12.0

### Minor Changes

- 81b1579: `run_query` now bounds what one call can cost. `queryTimeoutMs` (default 5 seconds) covers planning,
  execution, and the optional count; `maxConcurrentQueries` (default 1) rejects calls that arrive
  while the lane is busy. Row truncation no longer counts the full result to report a total: the
  response carries `truncated: true` with `total: null`, and an exact total is opt-in per server via
  `exactTotal`, which re-runs the query as a count.

  Where the query runs depends on the database, and the difference is visible in the timeout it can
  enforce. A file-backed database is reopened read-only in a worker that is spawned once, reused for
  every call, and terminated when a deadline passes - so a runaway statement is stopped, and no call
  copies the database. An in-memory database has no file to reopen and runs on the serving thread,
  where a synchronous statement cannot be preempted; there the deadline still bounds the response but
  is only observed once the statement returns. `SqliteDatabaseLike` gained an optional `filename` to
  express that difference; any database shaped like it keeps working either way.

### Patch Changes

- 18c8301: The table allowlist is now checked against the SQL the query actually names, not only against SQLite's
  query plan. A plan row reports the alias as its scan target, so `FROM "users" AS habits` planned as
  `SCAN habits` and passed an allowlist that exposed `habits` but not `users`. A small tokenizer now
  reads every relation after `FROM`/`JOIN` before the query runs - it handles all four SQLite identifier
  quotings and the keyword-adjacent form (`FROM"users"`) a whitespace-anchored pattern cannot, drops
  string literals and comments so text can never be read as SQL, and excludes CTE names. The plan check
  still runs afterwards, and now resolves a schema-qualified `SCAN main.habits` to `habits` rather than
  rejecting it as a table named `main`.

  `maxResultBytes` is enforced on the encoded UTF-8 byte length of the whole payload, envelope included,
  rather than on the JS string length of the rows alone - a multi-byte result could exceed the cap it
  had just been measured against. A payload still over the cap after halving down to zero rows is an
  error rather than an oversized response.

  Authorization moves onto `@nifrajs/mcp`'s new `authorizeMessage` seam, so a `run_query` call is
  authorized from the message the server already parsed instead of from a second `request.clone().json()`
  read of the body.

- Updated dependencies [cb04de8]
- Updated dependencies [f3cc02e]
- Updated dependencies [e2d1939]
  - @nifrajs/mcp@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/mcp@2.11.0

## 2.10.0

### Patch Changes

- @nifrajs/mcp@2.10.0

## 2.9.1

### Patch Changes

- @nifrajs/mcp@2.9.1

## 2.9.0

### Patch Changes

- @nifrajs/mcp@2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.
- Updated dependencies [f7d68e8]
  - @nifrajs/mcp@2.8.2

## 2.8.1

### Patch Changes

- @nifrajs/mcp@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/mcp@2.8.0

## 2.7.1

### Patch Changes

- @nifrajs/mcp@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/mcp@2.7.0

## 2.6.1

### Patch Changes

- @nifrajs/mcp@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [10fb70c]
  - @nifrajs/mcp@2.6.0

## 2.5.0

### Patch Changes

- Updated dependencies [3731c69]
- Updated dependencies [0740f77]
  - @nifrajs/mcp@2.5.0

## 2.4.0

### Patch Changes

- @nifrajs/mcp@2.4.0

## 2.3.0

### Patch Changes

- ea0a27f: A durable table prefix cannot collide after PostgreSQL truncates it.

  **Breaking for prefixes longer than 45 characters**, which now fail at construction rather than later.
  PostgreSQL truncates identifiers to 63 bytes, and this adapter appends up to `_records_reconcile` (18)
  to the prefix. Two distinct prefixes long enough to be cut short became one table name, silently
  sharing state between what the caller believed were separate deployments. The accepted length now
  reserves the longest suffix, so an accepted prefix survives truncation intact.

  Both adapters also assemble their statements through a tagged template that validates every
  substitution as an identifier at the boundary, so the check is at the seam rather than trusted from a
  caller several frames up.

  - @nifrajs/mcp@2.3.0

## 2.2.0

### Patch Changes

- @nifrajs/mcp@2.2.0

## 2.1.0

### Patch Changes

- @nifrajs/mcp@2.1.0

## 2.0.0

### Patch Changes

- Updated dependencies [d91a45b]
- Updated dependencies [202e758]
  - @nifrajs/mcp@2.0.0

## 1.13.0

### Patch Changes

- @nifrajs/mcp@1.13.0

## 1.12.0

### Patch Changes

- @nifrajs/mcp@1.12.0

## 1.11.0

### Patch Changes

- @nifrajs/mcp@1.11.0

## 1.10.0

### Patch Changes

- @nifrajs/mcp@1.10.0

## 1.9.1

### Patch Changes

- Updated dependencies [3eb27ae]
  - @nifrajs/mcp@1.9.1

## 1.9.0

### Patch Changes

- @nifrajs/mcp@1.9.0

## 1.8.0

### Patch Changes

- @nifrajs/mcp@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/mcp@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/mcp@1.6.0

## 1.5.0

### Minor Changes

- 79ac481: Two new agent-native packages. `@nifrajs/prompt`: type-safe prompts over any LLM provider - bind an instruction to input/output Standard Schemas, hand the output schema to the provider as its structured-output format, and get a validated, typed result (provider-neutral `complete` fn, markdown-fence tolerance, bounded `heal` retries). `@nifrajs/mcp-db`: serve a SQLite database as a fail-closed MCP server - allowlisted `list_tables`/`describe_table` by default; opt-in `run_query` requires an authorize hook and enforces read-only in layers (engine `PRAGMA query_only`, single-statement + SELECT-only gates, `EXPLAIN QUERY PLAN` allowlist verification, row/byte caps with truncation markers).

### Patch Changes

- @nifrajs/mcp@1.5.0
