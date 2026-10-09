---
"@nifrajs/core": patch
---

A GET carrying `Upgrade: websocket` to a path no WebSocket route takes now runs the `onRequest` hooks once. The handshake check ran them, found no socket route, and the HTTP route that answered ran them again, so a rate limiter or request counter in `onRequest` counted such a request twice. The HTTP route now runs with what the hooks returned during the check, including a rewritten request. This holds on Bun, Node and Deno.
