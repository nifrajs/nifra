---
"@nifrajs/core": patch
"@nifrajs/client": patch
---

Bound standalone idempotency response serialization and replay to 1 MB by default. Explicit `maxBytes` and route-level `maxResponseBytes` settings still control the limit.

Keep in-process client response decoding under the same byte cap as network responses, including framework-resident bodies.
