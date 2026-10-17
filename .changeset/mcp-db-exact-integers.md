---
"@nifrajs/mcp-db": patch
---

`run_query` on SQLite answers an INTEGER past 2^53 exactly, as its decimal string, on both the worker lane and the in-process lane, and a safe one stays a number. It used to round such an id to a neighbouring value. The in-process lane asks the driver for exact integers where it can (`safeIntegers` on bun:sqlite and better-sqlite3, `setReadBigInts` on node:sqlite).
