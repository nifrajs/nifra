---
"@nifrajs/core": patch
---

fix(core): on Bun, `c.clientIp` is the socket peer on every route `listen()` serves

A static or `:param` route answered `undefined` for `c.clientIp` under `listen()` on Bun, while a
wildcard route, and any route of an app with a request hook, answered the socket peer. Every route
now answers the peer, as the docs describe. The address is looked up when a handler reads it, so a
request whose handler never reads it costs no lookup, and a second read returns the first answer.
