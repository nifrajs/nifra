---
"@nifrajs/web": patch
---

Revive tagged Dates in streamed PPR interactive props and signed shared-cache entries. Cached server data keeps its tagged JSON representation so blocking renders and subsequent browser responses preserve Dates across processes.

Treat a signed cache entry containing an invalid Date tag as a cache miss instead of allowing it to fail during response serialization.
