---
"@nifrajs/web": patch
---

`MemoryCacheStore` no longer stores a render that began before a purge whose record it has since evicted. Purge records are bounded by `max`; once a page's or tag's record was evicted, a slow render that began before that purge was accepted and served the purged page again (one purge followed by 500 others was enough at the default `max`). Such a render is now served but not cached; a render that began after the purge is cached as before.
