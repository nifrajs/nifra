---
"@nifrajs/core": patch
---

On Bun, `listen()` keeps serving an app's routes from Bun's native route table when the app declares a `clientIp` trust or has WebSocket routes. `c.clientIp` applies the declared trust when a handler reads it. The GET routes a WebSocket handshake can reach stay with the portable dispatcher, as do the wildcard paths and idempotent routes the table never held.
