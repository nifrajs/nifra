---
"@nifrajs/mcp-db": patch
---

A query through a partial SQLite index whose `WHERE` names a masked column is now refused like any other read of that column. Choosing the index proves its predicate for every row it yields, so `SELECT count(*) FROM users WHERE password_hash LIKE 'h%'` could answer the masked predicate through an existing partial index without the bytecode ever reading the column.
