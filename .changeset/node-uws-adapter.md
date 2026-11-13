---
"@nifrajs/node": patch
"@nifrajs/node-uws": minor
---

`@nifrajs/node` has a `./transport` entry exposing its outcome runtime, Host and target policy, and lifecycle hooks to sibling HTTP adapters; `serve()` and the package's exports are unchanged. The new `@nifrajs/node-uws` serves a nifra app on uWebSockets.js through the same node-direct lane, with streaming responses, back-pressure, graceful `stop()` and the Host and target rules of `@nifrajs/node`. It has no WebSocket or static-file support.
