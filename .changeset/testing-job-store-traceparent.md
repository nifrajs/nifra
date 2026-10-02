---
"@nifrajs/testing": minor
---

`jobStoreCertificationProfile({ traceparent: true })` adds the optional `traceparent-roundtrip` capability: a store hands the `traceparent` given to `enqueue` back on every lease, including after a retry, and leaves it absent when none was given.
