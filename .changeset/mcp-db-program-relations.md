---
"@nifrajs/mcp-db": patch
---

`run_query` checks the tables the compiled statement opens, not only the names the SQL and the query plan use. A query is refused when it reads an unexposed table through a schema-qualified name beside a CTE of the same name, through any alias (non-ASCII ones included), through `x IN table`, or as a same-named table in a temp or attached schema of the connection.
