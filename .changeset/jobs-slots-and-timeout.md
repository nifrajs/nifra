---
"@nifrajs/jobs": minor
---

A worker no longer leaves free slots idle behind its slowest job. Each poll now leases due jobs into the slots free at that moment, and a slot frees as soon as its own job settles. Before, a poll waited until every job it had leased was done, so one long job held all `concurrency` slots. `process()` and `drain()` share those slots, and `process()` still waits for in-flight jobs when it has nothing new to start.

A job definition takes `timeoutMs`. An attempt still running after that time fails with the new `JobTimeoutError`, is retried or dead-lettered like a throw, and frees its slot. The handler's new `ctx.signal` aborts with that error.
