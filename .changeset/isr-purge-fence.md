---
"@nifrajs/web": minor
---

An ISR purge that lands while a page renders now holds. The render stored the page it had built from data read before the purge, and that stale page was served as fresh until it expired. `withISR` now takes a fence from the store before each render, and the store refuses an entry whose key or tags were purged after its fence. `CacheStore` gains an optional `fence()`, and `ISRStoreOp` gains `"fence"`, so an exhaustive `switch` over it needs that case. `MemoryCacheStore` orders purges exactly. `KVCacheStore` orders them by time, as far as KV's eventual consistency has carried the purge, and its `delete` now leaves a marker that reads as a miss instead of removing the key.
