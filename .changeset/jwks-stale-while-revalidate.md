---
"@nifrajs/middleware": minor
---

`jwks()` no longer holds requests on a slow identity provider, and it picks up a rotated key before the cache expires. Inside the `staleMs` window, a request is answered from the last good key set at once while one refresh runs behind it. Before, every refresh wave waited up to `timeoutMs` while the provider hung. A token whose `kid` is missing from the cached set now refetches the set, at most once per the new `cooldownMs` option (default 30 s), so made-up `kid`s cannot turn every request into a fetch. With `staleMs: 0` every refresh is still awaited and fails closed.
