---
"@nifrajs/core": patch
---

Capability assurance treats `OPTIONS` as a safe method, as it already treated `GET` and `HEAD`: an `OPTIONS` route that declares a domain write is reported as `safe-method-domain-write`, and one that only reaches it as `unconfined-write-reach`.
