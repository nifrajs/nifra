---
"@nifrajs/web": patch
---

`KVCacheStore` orders purges against in-flight renders by wall-clock time, held strictly increasing per process. A purge from a process whose host had slept, or whose system clock was stepped after it started, could carry a time behind the wall clock, so a render that began before the purge but finished after it was stored as fresh and the purged page kept serving until its next purge or expiry.
