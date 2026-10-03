---
"@nifrajs/web": patch
---

A static boundary's `load` receives no `origin` when it runs during a request: its value is cached for every visitor, so it no longer takes the first request's `Host` header. A static load that fails is loaded again on the next request instead of serving the error until restart. `StaticBoundaryCache` gains an optional `delete`, which `MemoryStaticBoundaryCache` implements.
