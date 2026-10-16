---
"@nifrajs/core": patch
---

A server no longer reads `process.env.NODE_ENV` on every request. The development check for order-scoped hooks that cover no route still runs on each server's first request. Once every server in the process has run it (or called `listen()`), and always in production, a request skips it with one integer compare. On Node, reading `process.env` is a native call of about 130 ns, so an app that runs core without a bundler replacing `NODE_ENV` (a plain `node server.js` install) paid it on every request. Builds made with `nifra build` already replaced it and are unchanged.
