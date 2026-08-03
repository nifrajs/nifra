---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

Two hot-path costs removed. On Bun, the socket peer address is now resolved lazily: `c.clientIp` keeps its documented raw-peer behavior, but the underlying `requestIP()` lookup (surprisingly expensive per request) only runs when something actually reads it - trust-mode routes still resolve it before the handler. On Node, buffered SSR responses no longer clone the response-header record (and every Set-Cookie array) before `writeHead` - the producer already hands over response-normalized names and values.
