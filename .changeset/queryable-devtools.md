---
"@nifrajs/devtools": minor
"@nifrajs/cli": minor
---

DevTools' request-trace buffer is now queryable, not just streamable.

Alongside the live SSE overlay, the plugin serves a one-shot JSON snapshot at `/_nifra/devtools/state` - the recent request traces (method, path, status, duration, ISR status, response bytes), filterable by a `path` prefix and a `limit`, and guarded exactly like the stream (loopback-only unless `allowRemote`, origin-checked, optional `authorize` hook). A new `filterDevToolsEvents` export defines that query once, shared by the endpoint and its consumers.

`nifra_inspect` (MCP) reads that snapshot for a running dev server, so an agent can SEE what its requests actually did - which route answered, the status, how long, ISR hit or miss - instead of inferring it from the response alone. It needs the app to mount the `devtools()` plugin (which auto-enables in development).
