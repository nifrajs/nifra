---
"@nifrajs/core": patch
---

A WebSocket handshake resolves the `clientIp` trust declaration the way an HTTP request does, so `onRequest` hooks such as `ipRestriction()` and a route's `upgrade()` see the derived caller rather than the proxy's socket address.
