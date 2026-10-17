---
"@nifrajs/core": patch
---

An idempotent route that authenticates first now runs its `authenticate()` stages before the idempotency key is checked or the body is read. A bad credential gets the route's `401` without its body being buffered, and a request with no key is refused only once it has authenticated. The whole dedupe step - namespace resolver, body read, store - now runs under the request deadline, so a stalled resolver or store answers `503` at `requestTimeoutMs` instead of holding the request open. A body decoded by `transportCodecs()` now reaches an idempotent route's body schema intact, and the fingerprint is taken over the bytes the caller sent, so a different payload under the same key is refused with `409 idempotency_key_reused` instead of replaying the first response.
