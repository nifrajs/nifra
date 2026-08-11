---
"@nifrajs/mcp-db": minor
---

`run_query` now bounds what one call can cost. `queryTimeoutMs` (default 5 seconds) covers planning,
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
