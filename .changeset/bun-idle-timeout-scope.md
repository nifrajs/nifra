---
"@nifrajs/core": minor
---

`withIdleTimeout(c, seconds, work)` from `@nifrajs/core/idle-timeout` sets the idle timeout of one request's connection on a Bun `listen()` server while `work` runs, then puts the `idleTimeoutSec` value back before the response is sent. `0` turns the timeout off. A slow handler no longer needs `idleTimeoutSec` raised for every connection, idle keep-alive ones included. When the request's deadline answers `503` first, the listener's value is back before that response too. Scopes nest, the longest applies, and `0` outlasts any number, so `app.around((c, next) => withIdleTimeout(c, 300, next))` covers a group of routes. It works on routes served from Bun's route table, from the portable dispatcher, from a mounted app, and from an app with WebSocket routes, and it times the request Bun received even when an `onRequest` hook rewrote it. Off `listen()` it runs `work` unchanged.
