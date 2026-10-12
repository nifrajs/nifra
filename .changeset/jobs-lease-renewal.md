---
"@nifrajs/jobs": patch
---

A job whose handler runs longer than the worker's `leaseMs` is no longer run a second time while the first run is still going. The worker now renews a running job's lease (about three times per `leaseMs`) through a new optional `JobStore.renew(id, until, lease)`, never starts a job it is already running when the store hands it back, and passes the lease token a store returns on `StoredJob.lease` to `complete`, `retry` and `deadLetter`, so a worker whose lease was taken over cannot settle the job. `MemoryJobStore` implements both; a custom store keeps working unchanged and gains the cross-worker protection once it implements them. `start()` (and a `define()` after it) now throws a `RangeError` when a job's `timeoutMs` is not below `leaseMs`; before, that setup let the job be leased again mid-attempt. Delivery stays at-least-once.
