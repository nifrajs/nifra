---
"@nifrajs/core": patch
---

A mounted app's `onRequest` hooks run once for a WebSocket handshake that its HTTP route answers. Under a `stripPrefix` mount the HTTP answer stripped the prefix into a fresh request, so the child ran its hooks again after the handshake check had already run them, and a rate limiter in the child counted the request twice. The child now gets the same stripped request the check gave it.
