---
"@nifrajs/web": minor
---

`withISR` serves through a cache-store outage. A `get` that throws, rejects, or outlives the new `storeTimeoutMs` is a miss and the page renders; a failed `set` still returns the rendered page and shares it with concurrent misses; a failed background regeneration keeps the stale entry. Failures go to the new `onStoreError(error, { op })`, which by default logs one line per operation per minute without the cache key. A store failure never changes the response status.
