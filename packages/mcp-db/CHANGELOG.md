# @nifrajs/mcp-db

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
