---
"@nifrajs/mcp-db": patch
---

A query that walks an index on a masked column in key order is refused like any other read of that column. `ORDER BY <masked column>` served by its index never read or compared the column, so it was admitted and returned rows ranked by the masked value.
