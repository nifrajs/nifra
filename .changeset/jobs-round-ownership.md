---
"@nifrajs/jobs": patch
---

A poll round settles only after every job it leased has settled, so a store failure in one job no longer frees the round's concurrency or lets `worker.stop()` return while a sibling handler is still running. `queue.drain()` runs its rounds through `queue.process()`, so concurrent drains and the worker's polls never run more than `concurrency` jobs at once.
