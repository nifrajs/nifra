---
"@nifrajs/middleware": patch
---

`jwks({ url })` now remembers a fetch that failed or returned an empty key set for `failureCooldownMs` (new option, default 5 s). Inside that window a request that needs the set gets the same answer at once (the fetch error, or no key) instead of starting its own fetch, and a stale set starts no new background refresh. Before, nothing was cached after a failure, so while the identity provider was down every request carrying a `kid` waited up to `timeoutMs` (5 s) on a fresh fetch. Set `failureCooldownMs: 0` for the old behavior.
