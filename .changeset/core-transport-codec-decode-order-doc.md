---
"@nifrajs/core": patch
---

`transportCodecs()` documents that it decodes a codec request body before routing, so a route's `bodyLimit` and its `authenticate()` stages run after the decode, and that its `maxBytes` option is the only bound on that work.
