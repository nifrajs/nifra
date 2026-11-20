---
"@nifrajs/middleware": patch
---

`MemoryResponseCache` also caps the bytes it holds (`maxTotalBytes`, default 64 MiB) and evicts the least recently used entry first, so a thousand large cached responses no longer sit in memory at once.
