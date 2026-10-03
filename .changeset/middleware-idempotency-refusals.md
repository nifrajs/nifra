---
"@nifrajs/middleware": patch
---

`idempotency()` no longer caches a `401`, `403`, `408`, `409`, `425`, or `429` by default. Each says the operation did not run, so a retry under the same key now reaches the handler instead of replaying the refusal until the key expires. A custom `shouldCache` is unaffected.
