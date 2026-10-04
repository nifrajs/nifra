---
"@nifrajs/core": minor
---

`schema.idempotency` takes `pendingTtlMs`, and `IdempotencyStore` an optional `renew()`. With a store that implements it, as `MemoryIdempotencyStore` does, a key whose handler is still running is held by a lease of `pendingTtlMs` (default 60 seconds, `DEFAULT_IDEMPOTENCY_PENDING_TTL_MS`) that the server renews every third of it until the response is stored, so a key reserved by a process that died frees after the lease instead of after `ttlMs`. `begin()` receives the lease as `pendingTtlMs`. A store without `renew()` keeps a running key reserved for `ttlMs` as before, and declaring `pendingTtlMs` on one is a registration error.
