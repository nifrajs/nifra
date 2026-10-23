---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
---

A WebSocket route's `close` callback is given the server's own code and reason when the server closed
first - `ws.close(code, reason)`, or 1009 "message too large" for a message over the payload cap - on
every runtime, as on Bun. Node, Deno and Workers passed on the peer's echo of the close, which
usually drops the reason, and Node reported 1006 when `ws` refused a message over its cap.
