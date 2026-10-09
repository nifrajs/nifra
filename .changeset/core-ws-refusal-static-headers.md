---
"@nifrajs/core": patch
---

A refused WebSocket handshake carries the app's `responseHeaders()` the way an HTTP answer does. A guard's refusal already did, but the cross-origin 403, a refusal returned by an `onRequest` hook, a malformed-path 400, the upgrade timeout's 503, an internal 500 and a refusal from a mounted child's socket went out without them.
