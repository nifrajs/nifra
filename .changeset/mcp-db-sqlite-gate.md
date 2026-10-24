---
"@nifrajs/mcp-db": patch
---

`run_query` answers a query that gives a table an alias (`SELECT h.name FROM habits h`). It had refused every one as touching the alias, because SQLite's query plan names a scan by its alias; the compiled statement, which names each table it opens, decides alone.

The SQLite statement gate, behind both `run_query` and `querySqlite`, reads `` `x` `` and `[x]` identifiers as quoted, so a `;` or `--` inside one no longer refuses or cuts the query. A comment after the statement is dropped before the query is wrapped.

`list_tables` counts rows in the same lane as `run_query`, within its time limit, and reuses the counts for 10 seconds. A count past the limit is reported as `null`. Before, every anonymous call counted every table on the serving thread with no limit.
