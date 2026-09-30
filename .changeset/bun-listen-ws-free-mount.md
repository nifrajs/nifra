---
"@nifrajs/core": patch
---

fix(core): on Bun, `listen()` starts a server that mounts another nifra app with no WebSocket routes.
Every mounted nifra app counted as a WebSocket mount, so `listen()` required the `websocket()` runtime
and threw `INVALID_WS_RUNTIME`. `createWebApp({ api })` mounts its backend this way, so a full-stack
app with an `api` backend could not start on Bun.

A mounted app now takes part in Bun's WebSocket wiring only when it has a WebSocket route, directly or
in an app it mounts. `listen()` asks when it runs, so a runtime or route added to the child after it
was mounted is served, and an app mounted under itself to alias a prefix still starts. A mounted
object that exposes `resolveWebSocketUpgrade` without naming a runtime still needs `websocket()` on
the parent.
