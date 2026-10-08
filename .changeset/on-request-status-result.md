---
"@nifrajs/core": patch
---

`onRequest` hooks can return a `status()` result, typed by `OnRequestResult`, to refuse a request through the normal response path: the body is serialized with its content-type, and declared `responseHeaders` and `onResponse` hooks apply. A WebSocket handshake refused this way answers with the same status and body.
