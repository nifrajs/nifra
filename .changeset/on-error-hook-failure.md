---
"@nifrajs/core": patch
---

An `onError` hook that throws or rejects no longer makes `app.fetch` reject. The error it was handling and its own error are both logged, later `onError` hooks are skipped, and the client gets the default `500` (a failed `authenticate()` stage keeps its `503`). An `onError` answer that cannot be rendered is logged and answered `500` the same way. A thrown `Response` or `status()` value is sent as if returned, still held to the route's response contract. This covers route errors, `onRequest` failures, the Node lane and the WebSocket handshake. Previously nothing was logged and the runtime answered with its own bare `500`.
