---
"@nifrajs/core": patch
---

An idempotent route that refuses a request - a failed `authenticate()`, a missing or invalid key, a body over the limit, a key conflict, or the request deadline - cancels the request body's producer again, as 5.4.0 did, and releases the caller's stream. Since the body is teed for its fingerprint, a refusal had cancelled only the gate's branch, which leaves the source running. The route's own branch is released once its response is ready, and that cleanup does not wait on a producer whose `cancel()` never settles.
