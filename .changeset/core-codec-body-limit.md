---
"@nifrajs/core": patch
---

A request body decoded by `transportCodecs()` before routing is still held to the matched route's `bodyLimit` (and the server's body cap): one larger than the limit answers 413 like a JSON body would.
