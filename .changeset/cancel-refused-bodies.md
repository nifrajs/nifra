---
"@nifrajs/core": patch
"@nifrajs/middleware": patch
---

A response body refused by its `content-length` alone is now cancelled. `readBoundedBytes` (behind the typed client's `maxDecodedBytes` and `decodeTransportResponse`) and the `jwks()` key fetch threw on an oversized declared length without touching the body, which left the stream, and its connection, open until the sender gave up.
