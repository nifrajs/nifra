---
"@nifrajs/mcp-db": patch
---

Closing a connection from `openReadOnlySqlite` releases the database file right away, instead of when its statements are garbage collected.
