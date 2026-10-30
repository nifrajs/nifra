# @nifrajs/mcp-db

## 5.10.0

### Patch Changes

- d2066e0: Restore the repository check gate without weakening global rules. Distinguish property names from variable self-references in SQL assembly scanning, retain detection of real interpolation and concatenation, and document reviewed comparisons of public labels/object identities and escaped table identifiers. Correct fixture dependency declarations and backend zoning while preserving intentionally unsafe PPR shell tests.
- @nifrajs/mcp@5.10.0

## 5.9.0

### Minor Changes

- e19b8ad: `@nifrajs/mcp-db/postgres` checks the connected role's own privileges before every query and explain: a role that may read a masked column, an excluded table or one inheriting from it, or a view or materialized view that reads any of them or reaches outside `schemas`, is refused with the new code `NIFRA_DB_ROLE_GRANTS`. The database then refuses those reads itself, including through a function body or the rows a materialized view stores. `postgresRoleSql` takes `redaction` and writes the matching grants: a `REVOKE` for each excluded table, its partitions and children, and each view or materialized view over hidden data, and a column-level `GRANT` of the other columns of a table with a masked column. A query that names a column the role may not read is refused with `NIFRA_DB_COLUMN_REFUSED`, which names the columns it may read. `readPostgresSchema` lists a table the role may read some columns of. The gate also refuses a role that may execute a SECURITY DEFINER function, or an aggregate over one, unless `allowFunctions` names it, since such a function reads with its owner's rights through an operator, a cast, a view or another function. Either refusal names each grantee the role holds the privilege through: PUBLIC, the role itself, or a role whose privileges it has. `postgresRoleSql` takes `allowFunctions` and writes the `REVOKE EXECUTE` each function needs from each such grantee, and the `REVOKE SELECT` for a table or column grant that would still expose hidden data; a grant to the role itself is revoked by a statement, the rest are listed as comments since they reach other roles.
  
  Functions go through an allowlist read from `pg_proc`, for every function the statement names and every one its plan calls, each overload a name can resolve to: a built-in or extension function must be immutable or stable and parallel safe (plus a few value-only ones such as `random()`), one the database defines must be immutable or stable, and none may be SECURITY DEFINER. The option `allowFunctions` (`name` or `schema.name`) accepts a function past it. `lintPostgresStatement` refuses statement shapes only; function refusals come from the allowlist once connected.
  
  `nifra db` reads `devDatabase.allowFunctions`, and `nifra db role` writes the grants for the declaration's masking.

### Patch Changes

- Updated dependencies [7ee17d0]
  - @nifrajs/mcp@5.9.0

## 5.8.0

### Patch Changes

- @nifrajs/mcp@5.8.0

## 5.7.0

### Patch Changes

- 25f97c2: Stop retaining finalized or abandoned SQLite statements for the lifetime of read-only connections, while continuing to finalize live statements on close.
- @nifrajs/mcp@5.7.0

## 5.6.0

### Patch Changes

- e1abda9: Postgres queries and plans run again on Bun 1.4.4. `queryPostgres`, `explainPostgres`, `nifra db query` and the `nifra_db_query` tool had answered every statement with `NIFRA_DB_DRIVER`, because Bun.SQL now refuses a statement whose template object is not shaped like a real one.
  
  With `redaction`, a query that gives a table a column alias list (`FROM users AS t(a, b)`) is refused while any relation it reads holds a masked column: the plan names that table's columns by the list, so it cannot show which real column is read. `ts_stat`, `ts_rewrite`, `crosstab` and `connectby` are refused with the other functions that run SQL from a string the plan check cannot see.
  
  Every Postgres read runs with JIT off. The schema read's catalog queries crossed the JIT cost threshold, and compiling them ran past the timeout on a stock Ubuntu server, so `nifra db schema` and `nifra_db_schema` answered `NIFRA_DB_TIMEOUT` there.
- 578f9dd: `run_query` answers a query that gives a table an alias (`SELECT h.name FROM habits h`). It had refused every one as touching the alias, because SQLite's query plan names a scan by its alias; the compiled statement, which names each table it opens, decides alone.
  
  The SQLite statement gate, behind both `run_query` and `querySqlite`, reads `` `x` `` and `[x]` identifiers as quoted, so a `;` or `--` inside one no longer refuses or cuts the query. A comment after the statement is dropped before the query is wrapped.
  
  `list_tables` counts rows in the same lane as `run_query`, within its time limit, and reuses the counts for 10 seconds. A count past the limit is reported as `null`. Before, every anonymous call counted every table on the serving thread with no limit.
- Updated dependencies [0b9fed9]
- Updated dependencies [4bc7d8d]
- Updated dependencies [4bc7d8d]
  - @nifrajs/mcp@5.6.0

## 5.5.1

### Patch Changes

- @nifrajs/mcp@5.5.1

## 5.5.0

### Patch Changes

- 98347c2: `run_query` on SQLite answers an INTEGER past 2^53 exactly, as its decimal string, on both the worker lane and the in-process lane, and a safe one stays a number. It used to round such an id to a neighbouring value. The in-process lane asks the driver for exact integers where it can (`safeIntegers` on bun:sqlite and better-sqlite3, `setReadBigInts` on node:sqlite).
- @nifrajs/mcp@5.5.0

## 5.4.0

### Patch Changes

- @nifrajs/mcp@5.4.0

## 5.3.0

### Patch Changes

- 48c9895: A query through a partial SQLite index whose `WHERE` names a masked column is now refused like any other read of that column. Choosing the index proves its predicate for every row it yields, so `SELECT count(*) FROM users WHERE password_hash LIKE 'h%'` could answer the masked predicate through an existing partial index without the bytecode ever reading the column.
- @nifrajs/mcp@5.3.0
- 9fbb84e: A query that walks an index on a masked column in key order is refused like any other read of that column. `ORDER BY <masked column>` served by its index never read or compared the column, so it was admitted and returned rows ranked by the masked value.

## 5.2.1

### Patch Changes

- @nifrajs/mcp@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
  - @nifrajs/mcp@5.2.0

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- Updated dependencies [abb4354]
  - @nifrajs/mcp@5.1.0

## 5.0.0

### Patch Changes

- 5b17850: `run_query` no longer materializes oversized results before applying `maxResultBytes`. A text or blob cell longer than the budget arrives as `"<n bytes>"` instead of being copied out of SQLite, and rows stop being read once their cells pass the budget. Before, `SELECT zeroblob(2000000) FROM t` over 100 rows held about 2 GB and ran for over a minute before the byte cap applied. A result cut by the byte budget reports `total: null` unless `exactTotal` is on.
- e58690c: `explainPostgres` refuses a query that uses a masked column, as `queryPostgres` does, with `NIFRA_DB_COLUMN_REFUSED`, with or without `analyze`. Before, a plan's row counts and estimates for a filter such as `WHERE password_hash LIKE 'h%'` answered questions about the column. A plain `SELECT password_hash FROM users` is refused as well.
- 5377b66: `run_query` checks the tables the compiled statement opens, not only the names the SQL and the query plan use. A query is refused when it reads an unexposed table through a schema-qualified name beside a CTE of the same name, through any alias (non-ASCII ones included), through `x IN table`, or as a same-named table in a temp or attached schema of the connection.
- 437d3cd: `postgresRoleSql` and `nifra db-role` grant the role `SELECT` on each allowed schema only. On Postgres 14 and later, with nothing excluded, the role used to get `pg_read_all_data`, which reads every schema in the database whatever `schemas` named.
- cd07938: `run_query` refuses every query that opens a virtual table or a table-valued function, as documented, however the query names it. A `pragma_*` function or `dbstat` listed after a comma under an allowlisted alias used to pass the checks and return schema metadata of tables outside the allowlist.
- Updated dependencies [1af7543]
  - @nifrajs/mcp@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/mcp@4.0.2

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
