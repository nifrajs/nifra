---
"@nifrajs/mcp-db": patch
---

`run_query` refuses every query that opens a virtual table or a table-valued function, as documented, however the query names it. A `pragma_*` function or `dbstat` listed after a comma under an allowlisted alias used to pass the checks and return schema metadata of tables outside the allowlist.
