---
"@nifrajs/cache": minor
---

`createCache({ observer })` reports every cache operation after it settles.

- Each event carries `op` (`get`, `has`, `set`, `wrap`, `delete`, `invalidateTag`, `clear`, `revalidate`), `outcome` (`hit`, `stale`, `miss`, `ok`, `error`), `startedAt`, `durationMs`, `key`, `tag`, `tagCount` and the bound `context`.
- `revalidate` is the background refresh a stale `wrap` starts, reported with the context whose read found the stale entry.
- An observer that throws or rejects cannot change a result. Without an observer the cache reads no extra clock and allocates no event.
- `cache.for(context)` works with an observer alone, so bound operations can be traced without a capability beacon. A beacon is still enforced whenever it is set.
