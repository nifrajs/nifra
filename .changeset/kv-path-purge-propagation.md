---
"@nifrajs/web": patch
---

A path purge on `KVCacheStore` now holds across locations. A page that another location rebuilt from data read before the purge, and stored before the purge reached it, reads as a miss once the purge arrives, instead of being served until it expires or the route revalidates. A purge by tag already behaved this way.

Each read now also fetches the path's purge record, in parallel with the page, so a cached hit costs one more KV read and no extra round trip. A path purge writes that record instead of overwriting the page; with `expirationTtl` set, the record expires a day after the pages it covers.
