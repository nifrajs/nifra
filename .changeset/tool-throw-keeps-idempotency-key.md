---
"@nifrajs/core": patch
---

A tool call whose executor throws or rejects now keeps its idempotency key: a retry with the same key answers `idempotency_duplicate` instead of running the executor again. The key was released on a throw, so an executor that committed its effect and then failed (a lost response, an error after the write) ran that effect a second time on retry. Pre-execution refusals (budget, cancellation before the call) and dry runs still release the key. To retry a failure known to have committed nothing, use a new key.
