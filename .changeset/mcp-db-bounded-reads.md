---
"@nifrajs/mcp-db": patch
---

`run_query` no longer materializes oversized results before applying `maxResultBytes`. A text or blob cell longer than the budget arrives as `"<n bytes>"` instead of being copied out of SQLite, and rows stop being read once their cells pass the budget. Before, `SELECT zeroblob(2000000) FROM t` over 100 rows held about 2 GB and ran for over a minute before the byte cap applied. A result cut by the byte budget reports `total: null` unless `exactTotal` is on.
