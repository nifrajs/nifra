---
"@nifrajs/mcp-db": patch
---

`explainPostgres` refuses a query that uses a masked column, as `queryPostgres` does, with `NIFRA_DB_COLUMN_REFUSED`, with or without `analyze`. Before, a plan's row counts and estimates for a filter such as `WHERE password_hash LIKE 'h%'` answered questions about the column. A plain `SELECT password_hash FROM users` is refused as well.
