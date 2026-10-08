---
"@nifrajs/core": major
---

A WebSocket handshake runs the route chain an HTTP `GET` registered at the same point runs: the `authenticate()` stages, `derive`s and `beforeHandle`s added before `app.ws()`, then `upgrade()`. Auth middleware such as `basicAuth`, `bearer`, `apiKey`, `jwt` and `authed()` guards the sockets registered after it, and a guard refuses the handshake with the response it would send an HTTP request. `upgrade(c)` sees, typed, what the guards derived and the app's decorations. To keep a socket public, register it before the guard.

`upgrade()` may reject with `status(...)` as well as a `Response`. A thrown `Response` rejects the handshake with that response; any other throw goes to the route's `onError` hooks, then a flat 500. The guards share the upgrade timeout.

In development, a `derive`, `decorate`, `beforeHandle` or `onError` followed only by WebSocket routes is no longer reported as applying to no route.
