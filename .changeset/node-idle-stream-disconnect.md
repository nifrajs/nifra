---
"@nifrajs/node": patch
---

A client that leaves while a streamed response is idle now cancels the response body, as on Bun and Deno. Before, a stream waiting to produce its next chunk (an SSE feed, a streamed agent run) never learned the client had gone: it kept running, and `stop()` waited on it until the drain timeout.
