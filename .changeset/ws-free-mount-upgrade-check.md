---
"@nifrajs/core": patch
---

perf(core): an app that mounts nifra apps without WebSocket routes answers the WebSocket upgrade
check without reading the request's headers. `@nifrajs/deno` and `toFetchHandler` on Workers run that
check on every request, and Deno builds a request's headers only when they are read, so a plain
request to such an app no longer pays for them. A WebSocket route or a mount added later, at any
depth, is still seen.

On Bun, an app whose own WebSocket routes sit beside mounted apps without any keeps native pub/sub:
`ws.subscribe` and `app.publish` stay on Bun's own topic broadcast. While it does, a WebSocket route a
mounted app gains after `listen()` is not upgraded, since its sockets would share the server's
topics; the next `listen()` serves it.
