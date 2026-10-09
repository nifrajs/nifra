---
"@nifrajs/core": minor
---

`sse()` and `.sse()` routes drop a client that stops reading. Once a client has `maxBufferedBytes` of events unread (a new `SSEInit` option, default 1 MiB), `stream.signal` aborts with `sse_client_too_slow`, the queued frames are released, and later sends are no-ops. Before, every `send()` queued in memory until the client read it or disconnected. A producer that sends a burst larger than 1 MiB before the client can read raises the option; `Infinity` turns the limit off.
