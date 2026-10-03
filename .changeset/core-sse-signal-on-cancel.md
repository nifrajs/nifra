---
"@nifrajs/core": patch
---

`sse()`'s `stream.signal` aborts when the runtime cancels the response body as well as when the request signal fires, so a producer looping on `stream.signal.aborted` stops once the client is gone on every runtime.
