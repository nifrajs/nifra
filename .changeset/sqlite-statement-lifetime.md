---
"@nifrajs/mcp-db": patch
---

Stop retaining finalized or abandoned SQLite statements for the lifetime of read-only connections, while continuing to finalize live statements on close.
