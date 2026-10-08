---
"@nifrajs/core": minor
"@nifrajs/cli": patch
---

`reflectRoutes()` lists each WebSocket route under the pseudo-method `"WS"`, after the HTTP routes, with the evidence its handshake enforces: `nifra.authenticated` from the auth guards registered before it and `nifra.rate-limited` from the app's request hooks. A socket never claims evidence whose enforcement its message handlers bypass. Route assurance therefore classifies every socket, and an assurance rule selects sockets with `methods: ["WS"]`; a policy whose rules name only HTTP methods reports each socket as `unclassified-route`. Capability assurance (`nifra capabilities check`) does not cover sockets, which declare no capabilities.
