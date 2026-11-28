---
"@nifrajs/node-engine": patch
---

Decode HTTP/2 request headers with fewer allocations: a field repeated from the HPACK table is shared with it instead of copied. Rebuild the native addon together with the package.
