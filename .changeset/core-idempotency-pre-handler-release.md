---
"@nifrajs/core": patch
---

On an idempotent route, a request rejected before its handler runs (by an auth stage, validation, or a guard) no longer stores a result under its `Idempotency-Key`: the key is released and can be retried. Rejected requests therefore no longer fill the idempotency store.
