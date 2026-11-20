---
"@nifrajs/web": patch
---

`MemoryCacheStore` invalidates a tag in time proportional to the entries that carry it, and a write no longer rescans the cache. The live hub forgets a tag derivation that failed instead of replaying the failure.
