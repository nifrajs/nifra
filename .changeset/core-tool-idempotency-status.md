---
"@nifrajs/core": patch
---

`toolHttpResult` and `createToolHttpHandler` answer an idempotency refusal as the HTTP idempotency lane does: a key already used is `409`, a call still running under the key is `409` with `Retry-After: 1`, and a full idempotency store is `503` with `Retry-After: 1`. All three used to be `500`, which reads as a server fault a client should not retry.
