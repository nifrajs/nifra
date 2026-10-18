---
"@nifrajs/middleware": patch
---

`compression()` adds `Vary: Accept-Encoding` to the identity response it sends a client that does not accept gzip, whenever it would have compressed that response for one that does. Only the gzip response carried it before, so a shared cache could store the identity bytes and replay them to gzip-capable clients. A response that is never compressed (too small, an incompressible type, already encoded, a range, or `no-transform`) still gets no `Vary`.
