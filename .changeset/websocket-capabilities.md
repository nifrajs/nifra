---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

`app.ws(path, { capabilities })` declares the capability ids a socket's code may reach, as an HTTP route's `capabilities` does. Reflection lists them on the `"WS"` route, and `nifra capabilities check` covers sockets: it finds each `.ws("/path", ...)` registration, compares the declaration with the effects reachable from that module, and reports an undeclared reach. A write whose definition needs request idempotency fails on a socket, which has no request idempotency. The handshake context carries the guard, so a runtime capability beacon in `upgrade()` fails closed on an undeclared capability.
