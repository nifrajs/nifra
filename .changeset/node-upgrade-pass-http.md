---
"@nifrajs/node": patch
---

A request with a WebSocket `Upgrade` header to a path that has no WebSocket route is answered by that path's HTTP route, as on Bun, with the response body streamed rather than buffered. A request other than `GET` carrying an `Upgrade` header is served as an ordinary request.
