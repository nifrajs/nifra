---
"@nifrajs/node-engine": minor
---

HTTP/2 response headers are compressed, `setResponseTrailers()` sets response trailers, `stop()` shuts connections down in two steps, and `http2` takes window, frame, header table, send buffer and keepalive `PING` settings. Rebuild the native addon together with the package.
