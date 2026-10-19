---
"@nifrajs/core": patch
---

An `onRequest` hook that throws or rejects now fails the request the way a handler error does. Every `onError` the app registered sees the error, in order, with a context that has no route params, and the first answer is sent; when none answers, the error is logged and the client gets the default `500`. A thrown `Response` or `status()` value is sent as if returned. This covers `app.fetch`, the Node lane (including native `onNodeRequest` twins) and the WebSocket handshake. Previously the failure rejected `app.fetch`, so a rate-limit store outage skipped the app's error handling and the runtime answered with its own bare `500`.
