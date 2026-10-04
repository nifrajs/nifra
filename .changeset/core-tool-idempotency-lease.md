---
"@nifrajs/core": minor
---

Tool idempotency gets the same lease as route idempotency. `ToolIdempotencyStore` takes an optional `renew()`, and `MemoryToolIdempotencyStore` implements it. With such a store, `executeTool` reserves the key with a lease of `pendingTtlMs` (default 60 seconds, or the tool's `idempotency.pendingTtlMs`) and renews it every third of that while the tool runs, so a key reserved by a process that died frees after the lease instead of after the store's `ttlMs`. A completed key is kept for `ttlMs` from completion. Stores without `renew()` keep a running key for their own TTL as before.
