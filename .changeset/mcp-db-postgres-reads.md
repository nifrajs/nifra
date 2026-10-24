---
"@nifrajs/mcp-db": patch
---

Postgres queries and plans run again on Bun 1.4.4. `queryPostgres`, `explainPostgres`, `nifra db query` and the `nifra_db_query` tool had answered every statement with `NIFRA_DB_DRIVER`, because Bun.SQL now refuses a statement whose template object is not shaped like a real one.

With `redaction`, a query that gives a table a column alias list (`FROM users AS t(a, b)`) is refused while any relation it reads holds a masked column: the plan names that table's columns by the list, so it cannot show which real column is read. `ts_stat`, `ts_rewrite`, `crosstab` and `connectby` are refused with the other functions that run SQL from a string the plan check cannot see.

Every Postgres read runs with JIT off. The schema read's catalog queries crossed the JIT cost threshold, and compiling them ran past the timeout on a stock Ubuntu server, so `nifra db schema` and `nifra_db_schema` answered `NIFRA_DB_TIMEOUT` there.
