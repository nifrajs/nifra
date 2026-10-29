---
"@nifrajs/core": minor
"@nifrajs/node": minor
---

Make request-target normalization opt-in on Deno and Node with `server({ normalizeTarget: true })` and `serve(app, { normalizeTarget: true })`. Off, both runtimes route the target as sent, as most frameworks do; on, dot segments, backslashes and the characters a URL parser percent-encodes are resolved before routing so every runtime routes the same path. Enable it when path guards, or a proxy that normalizes paths, sit in front of or inside the app. Bun already delivers parsed targets and is unchanged. On Node, a request handed over as a Web `Request` (a `static` callback, a WebSocket upgrade) is parsed by the platform and resolved either way.
