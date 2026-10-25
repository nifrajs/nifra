---
"@nifrajs/core": minor
"@nifrajs/web": patch
---

`listen()` takes `static`, a handler that sees every request before the app does, the ones Bun's route table serves included. It answers with a response, or hands the request to the app with `undefined`. A file it answers wins over any route at the same path, and no hook of the app runs for it.

`nifra build --target bun` emits a server that runs on `app.listen()` and serves its client bundle and public files through `static`. The built server answers a failing request with the listener's plain 500, serves WebSocket routes, and supports `stop()` and `withIdleTimeout()`. Pages of an app without request hooks are served from Bun's route table.

A `createWebApp` host policy refuses requests on every route of an app served by `app.listen()`, the routes Bun's route table holds included.
