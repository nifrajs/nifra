---
"@nifrajs/core": patch
---

The `mountFetch()` reference says what the WebSockets guide already did: a mounted fetch handler carries HTTP only, so a WebSocket upgrade under its prefix reaches it as an ordinary request. Serve those sockets with `app.ws()` routes or a mounted child app.
