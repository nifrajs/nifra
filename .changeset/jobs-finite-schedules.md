---
"@nifrajs/jobs": patch
---

A job can no longer be stranded by a non-finite time. `enqueue` rejects a `delayMs` or `runAt` that is `NaN` or infinite (an invalid `Date.parse` result, say) with a `RangeError` before the job is written; such a job used to sit pending forever, never run. A backoff that returns a non-finite delay dead-letters the job, reporting a `RangeError` through `onError`, where it used to leave the job pending with no further attempts and no dead letter. `fixedBackoff` and `exponentialBackoff` refuse a non-finite or negative delay, and a `jitter` outside [0, 1], when built.
