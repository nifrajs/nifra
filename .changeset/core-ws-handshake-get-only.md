---
"@nifrajs/core": patch
---

Only a GET request is treated as a WebSocket handshake. A POST or PUT that carries `Upgrade: websocket` reaches its HTTP route instead of the socket's `upgrade()` guard and a 426.
