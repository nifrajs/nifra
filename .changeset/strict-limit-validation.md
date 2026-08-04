---
"@nifrajs/core": patch
"@nifrajs/auth": patch
"@nifrajs/cache": patch
"@nifrajs/cli": patch
"@nifrajs/image": patch
"@nifrajs/jobs": patch
"@nifrajs/mcp": patch
"@nifrajs/mcp-db": patch
"@nifrajs/middleware": patch
"@nifrajs/web": patch
---

Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.
