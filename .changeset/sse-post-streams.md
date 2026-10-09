---
"@nifrajs/core": minor
"@nifrajs/client": minor
---

`app.sse()` registers a POST stream when its schema declares a `body`: the body validates as on any POST, the handler reads `c.body`, and the typed client's `.subscribe(onEvent, { body })` sends it, typed from the body schema. A chat stream that posts its prompt no longer needs a hand-written `fetch`. A POST stream does not reconnect unless `reconnect: true` is passed, since a reconnect sends the body again; a GET stream keeps reconnecting by default.

`.subscribe()` now runs the client's `onRequest` hook before each connect, as every other request does, so a refreshed auth token reaches the stream.
