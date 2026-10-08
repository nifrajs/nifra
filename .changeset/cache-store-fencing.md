---
"@nifrajs/cache": minor
"@nifrajs/testing": minor
---

`CacheStore` gains two optional methods for a store that several caches or processes share: `fence(key, tags)` and `setIfFence(key, entry, tags, token)`. A `wrap` load takes a fence before its loader runs and stores its result through `setIfFence`, which refuses the write when a `set` or `delete` of the key, an `invalidateTag` of one of its tags, or a `clear` ran in the meantime from any cache sharing the store. `MemoryCache` implements both, so two caches over one `MemoryCache` no longer write back a value the other invalidated.

A `delete`, `invalidateTag` or `clear` now runs after the cache's own async store writes it covers, so a store that applies requests out of order cannot land an earlier write after the invalidation.

`cacheStoreCertificationProfile({ fencing: true })` adds the `fenced-write` capability, which checks a store's `fence` and `setIfFence`.
