---
"@nifrajs/jobs": patch
---

A store that fails to record a finished job no longer sends that job back through the retry path. The handler had already succeeded, but the failure counted as the handler's: it was retried (running it again) or, on its last attempt, dead-lettered. The store error now surfaces as a store failure, and the lease decides any redelivery.
