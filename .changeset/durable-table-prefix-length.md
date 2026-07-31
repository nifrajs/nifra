---
"@nifrajs/core": patch
"@nifrajs/mcp-db": patch
---

A durable table prefix cannot collide after PostgreSQL truncates it.

**Breaking for prefixes longer than 45 characters**, which now fail at construction rather than later.
PostgreSQL truncates identifiers to 63 bytes, and this adapter appends up to `_records_reconcile` (18)
to the prefix. Two distinct prefixes long enough to be cut short became one table name, silently
sharing state between what the caller believed were separate deployments. The accepted length now
reserves the longest suffix, so an accepted prefix survives truncation intact.

Both adapters also assemble their statements through a tagged template that validates every
substitution as an identifier at the boundary, so the check is at the seam rather than trusted from a
caller several frames up.
