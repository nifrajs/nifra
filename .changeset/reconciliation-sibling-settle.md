---
"@nifrajs/core": patch
---

`runReconciliationWorker` no longer releases its lease while handlers are still running. When one handler in a page failed, the worker rejected at once, so the lease was released while the other handlers kept going. A second worker could then take the lease and handle the same findings at the same time. On a failure the worker now starts no new handlers, waits for the running ones to settle, and only then releases the lease and rethrows the first error.
