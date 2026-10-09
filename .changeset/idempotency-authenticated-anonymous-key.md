---
"@nifrajs/middleware": patch
---

`idempotency()` no longer stores a response under the anonymous key when the request was authenticated by a credential outside `principalHeaders` (an `apiKey()` guard or an `authenticate` stage reading `x-service-key`, say). Replay runs before authentication, so an anonymous caller who presented the same `Idempotency-Key` was replayed the owner's stored response. Such requests now run each time; add the credential header to `principalHeaders` to dedupe them.
